import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { MatchingJob, MatchingFailedReason, RideEvent } from '@app/contracts';
import { recordProcessedEvent } from '@app/messaging';
import type { InternalCaller } from '@app/shared-types';
import { ApiError, runInTransaction, withCommandResult } from '@app/runtime';
import {
  MATCHING_INBOX,
  MatchingStateService,
  throwMatchingError,
  toJob,
} from './matching-state.service';
import { MatchingJobEntity } from './entities/matching-job.entity';
import { ProcessedEventEntity } from './entities/processed-event.entity';
import { CancelMatchingJobDto } from './dto/cancel-matching-job.dto';

type TripRequestedEvent = RideEvent<'trip.requested'>;
type TripCancelledEvent = RideEvent<'trip.cancelled'>;

@Injectable()
export class MatchingService {
  constructor(
    private readonly database: DataSource,
    private readonly state: MatchingStateService,
  ) {}

  async getJobByTripId(tripId: string): Promise<MatchingJob> {
    try {
      const job = await this.database.getRepository(MatchingJobEntity).findOneBy({ tripId });

      if (!job) {
        throw new ApiError(404, 'JOB_NOT_FOUND', 'Matching job not found');
      }

      return toJob(job);
    } catch (error) {
      throwMatchingError(error);
    }
  }

  async cancelJob(
    tripId: string,
    dto: CancelMatchingJobDto,
    caller: InternalCaller,
    correlationId: string,
  ): Promise<MatchingJob> {
    try {
      const result = await withCommandResult(
        this.database,
        {
          schema: 'matching_schema',
          callerService: caller,
          commandType: 'CANCEL',
          commandId: dto.commandId,
          resourceId: tripId,
          correlationId,
        },
        dto,
        async manager => {
          const job = await this.ensureJob(manager, tripId, dto.tripVersion, null);

          if (dto.tripVersion < job.latestTripVersion) {
            throw new ApiError(
              409,
              'STALE_TRIP_VERSION',
              'Trip version is older than the saved version',
            );
          }

          job.latestTripVersion = dto.tripVersion;
          await this.state.cancel(manager, job);

          return { status: 200, body: toJob(job) };
        },
      );

      return result.body;
    } catch (error) {
      throwMatchingError(error);
    }
  }

  // Sự kiện đã được EventConsumer kiểm tra theo @app/contracts (cấu trúc, producer, aggregate khớp payload).
  createJobFromRequested(event: TripRequestedEvent): Promise<void> {
    return this.processEvent(event);
  }

  cancelJobFromEvent(event: TripCancelledEvent): Promise<void> {
    return this.processEvent(event);
  }

  async failSearch(jobId: string, reason: MatchingFailedReason): Promise<void> {
    try {
      await runInTransaction(this.database, async manager => {
        const job = await this.state.lockJob(manager, jobId);

        if (job) {
          await this.state.fail(manager, job, reason);
        }
      });
    } catch (error) {
      throwMatchingError(error);
    }
  }

  private async ensureJob(
    manager: EntityManager,
    tripId: string,
    tripVersion: number,
    source: TripRequestedEvent | null,
  ): Promise<MatchingJobEntity> {
    const now = await this.state.now(manager);

    await manager
      .createQueryBuilder()
      .insert()
      .into(MatchingJobEntity)
      .values({
        id: randomUUID(),
        tripId,
        latestTripVersion: tripVersion,
        status: source ? 'SEARCHING' : 'CANCELLED',
        version: 1,
        tripSnapshot: source,
        searchDeadline: source ? new Date(now.getTime() + 60000) : null,
        currentOfferId: null,
        nextRetryAt: now,
        leaseToken: null,
        leaseUntil: null,
        createdAt: now,
        updatedAt: now,
      })
      .orIgnore()
      .execute();

    return manager
      .getRepository(MatchingJobEntity)
      .findOneOrFail({ where: { tripId }, lock: { mode: 'pessimistic_write' } });
  }

  private async processEvent(event: TripRequestedEvent | TripCancelledEvent): Promise<void> {
    try {
      await runInTransaction(this.database, async manager => {
        if (!(await recordProcessedEvent(manager, MATCHING_INBOX, event))) {
          // Trùng event_id nhưng khác nội dung là lỗi của bên gửi, không phải bản gửi lặp.
          const seen = await manager
            .getRepository(ProcessedEventEntity)
            .findOneByOrFail({ consumerName: MATCHING_INBOX.consumerName, eventId: event.event_id });

          if (
            seen.eventType !== event.type ||
            seen.aggregateId !== event.aggregate_id ||
            seen.aggregateVersion !== event.aggregate_version
          ) {
            throw new ApiError(400, 'INVALID_EVENT', 'Event ID has conflicting metadata');
          }

          return;
        }

        const job = await this.ensureJob(
          manager,
          event.payload.tripId,
          event.payload.tripVersion,
          event.type === 'trip.requested' ? event : null,
        );

        if (event.payload.tripVersion < job.latestTripVersion) {
          return;
        }

        if (event.type === 'trip.cancelled') {
          job.latestTripVersion = event.payload.tripVersion;
          await this.state.cancel(manager, job);
        } else if (event.payload.tripVersion > job.latestTripVersion) {
          job.latestTripVersion = event.payload.tripVersion;
          await this.state.saveJob(manager, job);
        }
        // Job đã tồn tại (kể cả CANCELLED) không bị tạo lại, đổi snapshot hay gia hạn deadline.
      });
    } catch (error) {
      throwMatchingError(error);
    }
  }
}
