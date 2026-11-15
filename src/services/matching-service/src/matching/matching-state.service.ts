import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type {
  EventPayloads,
  MatchingEventType,
  MatchingJob,
  MatchingFailedReason,
  Offer,
  OfferResolutionResult,
  RideEvent,
} from '@app/contracts';
import { createRideEvent, enqueueOutboxEvent } from '@app/messaging';
import { ApiError } from '@app/runtime';
import { MatchingJobEntity } from './entities/matching-job.entity';
import { OfferEntity } from './entities/offer.entity';

export const MATCHING_OUTBOX_TABLE = 'matching_schema.outbox_events';
export const MATCHING_INBOX = {
  table: 'matching_schema.processed_events',
  // Giữ tên cũ để bản ghi "đã xử lý" từ trước vẫn chặn được sự kiện gửi lặp.
  consumerName: 'matching.events',
} as const;

export function throwMatchingError(error: unknown): never {
  if (error instanceof ApiError) {
    throw error;
  }

  const failure = error as { driverError?: { code?: string } };

  if (failure?.driverError?.code === '23505') {
    throw new ApiError(409, 'OFFER_CONFLICT', 'This assignment or offer is already in use');
  }

  throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Matching database unavailable');
}

export function toJob(job: MatchingJobEntity): MatchingJob {
  return {
    id: job.id,
    tripId: job.tripId,
    status: job.status,
    version: job.version,
    ...(job.currentOfferId ? { currentOfferId: job.currentOfferId } : {}),
  };
}

export function toOffer(offer: OfferEntity): Offer {
  return {
    id: offer.id,
    jobId: offer.jobId,
    tripId: offer.tripId,
    driverId: offer.driverId,
    status: offer.status,
    expiresAt: offer.expiresAt.toISOString(),
    version: offer.version,
    ...(offer.assignmentId ? { assignmentId: offer.assignmentId } : {}),
  };
}

@Injectable()
export class MatchingStateService {
  async now(manager: EntityManager): Promise<Date> {
    const [row] = (await manager.query('SELECT clock_timestamp() AS now')) as Array<{ now: Date }>;

    return row.now;
  }

  lockJob(manager: EntityManager, id: string): Promise<MatchingJobEntity | null> {
    return manager
      .getRepository(MatchingJobEntity)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }

  async lockOffer(manager: EntityManager, offerId: string) {
    const offers = manager.getRepository(OfferEntity);
    const found = await offers.findOneBy({ id: offerId });

    if (!found) {
      throw new ApiError(404, 'OFFER_NOT_FOUND', 'Offer not found');
    }

    // Job trước, offer sau; API, event consumer và worker đều dùng thứ tự này.
    const job = await this.lockJob(manager, found.jobId);
    const offer = await offers.findOneOrFail({
      where: { id: found.id },
      lock: { mode: 'pessimistic_write' },
    });

    if (!job) {
      throw new ApiError(404, 'JOB_NOT_FOUND', 'Matching job not found');
    }

    return { job, offer };
  }

  async saveJob(manager: EntityManager, job: MatchingJobEntity, delayMs = 0): Promise<void> {
    job.version++;
    job.updatedAt = await this.now(manager);
    job.nextRetryAt = new Date(job.updatedAt.getTime() + delayMs);
    job.leaseToken = null;
    job.leaseUntil = null;
    await manager.getRepository(MatchingJobEntity).save(job);
  }

  async saveOffer(manager: EntityManager, offer: OfferEntity): Promise<void> {
    offer.version++;
    offer.updatedAt = await this.now(manager);
    await manager.getRepository(OfferEntity).save(offer);
  }

  async cancel(manager: EntityManager, job: MatchingJobEntity): Promise<void> {
    if (job.currentOfferId) {
      const offer = await manager.getRepository(OfferEntity).findOne({
        where: { id: job.currentOfferId },
        lock: { mode: 'pessimistic_write' },
      });

      if (offer && (offer.status === 'OPEN' || offer.status === 'CLAIMED')) {
        offer.status = 'CANCELLED';
        await this.saveOffer(manager, offer);
      }
    }

    job.status = 'CANCELLED';
    await this.saveJob(manager, job);
  }

  /** Ghi sự kiện vào outbox trong transaction của `manager`; OutboxRelay chung gửi đi sau khi commit. */
  async enqueue<T extends MatchingEventType>(
    manager: EntityManager,
    job: MatchingJobEntity,
    type: T,
    payload: EventPayloads[T],
  ): Promise<void> {
    const source = job.tripSnapshot!;
    // RideEvent<T> với T còn generic thì TypeScript không tự thu về union RideEvent.
    const event = createRideEvent(type, {
      aggregateId: job.id,
      aggregateVersion: job.version,
      correlationId: source.correlation_id,
      causationId: source.event_id,
      occurredAt: await this.now(manager),
      payload,
    }) as RideEvent;

    await enqueueOutboxEvent(manager, MATCHING_OUTBOX_TABLE, event);
  }

  async fail(
    manager: EntityManager,
    job: MatchingJobEntity,
    reason: MatchingFailedReason,
  ): Promise<void> {
    if (job.status !== 'SEARCHING' && job.status !== 'OFFERING') {
      return;
    }

    if (job.currentOfferId) {
      const offer = await manager
        .getRepository(OfferEntity)
        .findOne({ where: { id: job.currentOfferId }, lock: { mode: 'pessimistic_write' } });

      if (offer?.status === 'OPEN') {
        offer.status = 'EXPIRED';
        await this.saveOffer(manager, offer);
      }
    }

    job.status = 'FAILED';
    job.currentOfferId = null;
    await this.saveJob(manager, job);
    await this.enqueue(manager, job, 'matching.failed', {
      tripId: job.tripId,
      jobId: job.id,
      jobVersion: job.version,
      reason,
    });
  }

  async resolve(
    manager: EntityManager,
    job: MatchingJobEntity,
    offer: OfferEntity,
    result: OfferResolutionResult,
  ): Promise<void> {
    if (offer.resolutionResult) {
      if (offer.resolutionResult !== result) {
        throw new ApiError(409, 'RESOLUTION_CONFLICT', 'Offer already has a different resolution');
      }

      return;
    }

    if (job.status === 'CANCELLED') {
      if (result !== 'CANCELLED') {
        throw new ApiError(409, 'JOB_CANCELLED', 'Matching job was cancelled');
      }
    } else if (
      job.status !== 'CLAIMED' ||
      offer.status !== 'CLAIMED' ||
      job.currentOfferId !== offer.id
    ) {
      throw new ApiError(409, 'RESOLUTION_CONFLICT', 'Offer is not the active claim');
    }

    offer.resolutionResult = result;
    offer.status = result === 'ASSIGNED' ? 'ACCEPTED' : 'CANCELLED';
    await this.saveOffer(manager, offer);
    job.status =
      result === 'ASSIGNED' ? 'MATCHED' : result === 'CANCELLED' ? 'CANCELLED' : 'SEARCHING';

    if (result === 'RETRY') {
      job.currentOfferId = null;
    }

    await this.saveJob(manager, job);
  }
}
