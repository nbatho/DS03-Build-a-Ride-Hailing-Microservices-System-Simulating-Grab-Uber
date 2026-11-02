import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { runInTransaction } from '@app/runtime';
import type { OfferResolutionResult } from '@app/contracts';
import { MatchingStateService, toOffer } from './matching-state.service';
import { MatchingJobEntity } from './entities/matching-job.entity';
import { OfferEntity } from './entities/offer.entity';
import { AttemptedCandidateEntity } from './entities/attempted-candidate.entity';
import { DriverClient } from './driver.client';
import { TripClient } from './trip.client';

@Injectable()
export class MatchingWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly database: DataSource,
    private readonly state: MatchingStateService,
    private readonly drivers: DriverClient,
    private readonly trips: TripClient,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (!this.running) {
        this.running = this.tick()
          .catch(() => Logger.warn('Matching worker failed; will retry', 'MatchingWorker'))
          .finally(() => {
            this.running = undefined;
          });
      }
    }, 500);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  private async tick(): Promise<void> {
    await this.expireOpenOffers();
    await this.searchNextCandidates();
    await this.reconcileClaimedOffers();
  }

  private claim(status: 'SEARCHING' | 'CLAIMED'): Promise<MatchingJobEntity[]> {
    return runInTransaction(this.database, async manager => {
      const jobs = await manager
        .getRepository(MatchingJobEntity)
        .createQueryBuilder('job')
        .where('job.status = :status', { status })
        .andWhere('job.next_retry_at <= clock_timestamp()')
        .andWhere('(job.lease_until IS NULL OR job.lease_until <= clock_timestamp())')
        .orderBy('job.next_retry_at', 'ASC')
        .addOrderBy('job.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(5)
        .getMany();
      const now = await this.state.now(manager);

      for (const job of jobs) {
        job.leaseToken = randomUUID();
        job.leaseUntil = new Date(now.getTime() + 15000);
        await manager.getRepository(MatchingJobEntity).save(job);
      }

      return jobs;
    });
  }

  private async current(
    manager: EntityManager,
    claim: MatchingJobEntity,
  ): Promise<MatchingJobEntity | null> {
    const job = await this.state.lockJob(manager, claim.id);
    const now = await this.state.now(manager);

    return job &&
      job.status === claim.status &&
      job.version === claim.version &&
      job.leaseToken === claim.leaseToken &&
      job.leaseUntil!.getTime() > now.getTime()
      ? job
      : null;
  }

  private async reschedule(claim: MatchingJobEntity, delayMs: number): Promise<void> {
    await this.database.query(
      `UPDATE matching_schema.matching_jobs
      SET lease_token=NULL, lease_until=NULL, next_retry_at=clock_timestamp()+$3 * interval '1 millisecond'
      WHERE id=$1 AND lease_token=$2`,
      [claim.id, claim.leaseToken, delayMs],
    );
  }

  async searchNextCandidates(): Promise<void> {
    const claims = await this.claim('SEARCHING');

    await Promise.allSettled(
      claims.map(async claim => {
        try {
          // HTTP ngoài transaction; dữ liệu trả về chỉ là snapshot, phải kiểm tra lease/version lại.
          const expired =
            claim.searchDeadline!.getTime() <=
            (await this.state.now(this.database.manager)).getTime();
          const candidates = expired
            ? { items: [] }
            : await this.drivers.getCandidates(
                claim.tripSnapshot!.payload.pickup.zoneId,
                10,
                claim.tripSnapshot!.correlation_id,
              );

          await runInTransaction(this.database, async manager => {
            const job = await this.current(manager, claim);

            if (!job) {
              return;
            }

            const now = await this.state.now(manager);
            const attempted = await manager
              .getRepository(AttemptedCandidateEntity)
              .findBy({ jobId: job.id });

            if (job.searchDeadline!.getTime() <= now.getTime()) {
              await this.state.fail(manager, job, 'SEARCH_TIMEOUT');

              return;
            }

            const candidate = candidates.items.find(
              item =>
                item.zoneId === job.tripSnapshot!.payload.pickup.zoneId &&
                !attempted.some(previous => previous.driverId === item.driverId),
            );

            if (attempted.length >= 5 || !candidate) {
              await this.state.fail(manager, job, 'NO_CANDIDATE');

              return;
            }

            await manager
              .getRepository(AttemptedCandidateEntity)
              .insert({ jobId: job.id, driverId: candidate.driverId, attemptedAt: now });
            const offer = manager.getRepository(OfferEntity).create({
              id: randomUUID(),
              jobId: job.id,
              tripId: job.tripId,
              driverId: candidate.driverId,
              status: 'OPEN',
              assignmentId: null,
              decisionAction: null,
              resolutionResult: null,
              expiresAt: new Date(now.getTime() + 15000),
              version: 1,
              createdAt: now,
              updatedAt: now,
            });

            await manager.getRepository(OfferEntity).insert(offer);
            job.status = 'OFFERING';
            job.currentOfferId = offer.id;
            await this.state.saveJob(manager, job);
            const snapshot = job.tripSnapshot!.payload;

            await this.state.enqueue(manager, job, 'matching.offer.created', {
              offer: toOffer(offer),
              pickup: snapshot.pickup,
              dropoff: snapshot.dropoff,
              amount: snapshot.amount,
              currency: snapshot.currency,
            });
          });
        } catch {
          // Driver lỗi không được biến thành danh sách rỗng và báo NO_CANDIDATE giả.
          await this.reschedule(claim, 1000);
        }
      }),
    );
  }

  async expireOpenOffers(): Promise<void> {
    const rows = (await this.database.query(`
      SELECT j.id FROM matching_schema.matching_jobs j JOIN matching_schema.offers o ON o.id=j.current_offer_id
      WHERE j.status='OFFERING' AND o.status='OPEN'
        AND (o.expires_at <= clock_timestamp() OR j.search_deadline <= clock_timestamp())
      ORDER BY j.id LIMIT 100
    `)) as Array<{ id: string }>;

    for (const row of rows) {
      await runInTransaction(this.database, async manager => {
        const job = await this.state.lockJob(manager, row.id);

        if (!job || job.status !== 'OFFERING' || !job.currentOfferId) {
          return;
        }

        const offer = await manager.getRepository(OfferEntity).findOneOrFail({
          where: { id: job.currentOfferId },
          lock: { mode: 'pessimistic_write' },
        });
        const now = await this.state.now(manager);

        if (job.searchDeadline!.getTime() <= now.getTime()) {
          await this.state.fail(manager, job, 'SEARCH_TIMEOUT');
        } else if (offer.status === 'OPEN' && offer.expiresAt.getTime() <= now.getTime()) {
          offer.status = 'EXPIRED';
          await this.state.saveOffer(manager, offer);
          job.status = 'SEARCHING';
          job.currentOfferId = null;
          await this.state.saveJob(manager, job);
        }
      });
    }
  }

  async reconcileClaimedOffers(): Promise<void> {
    const claims = await this.claim('CLAIMED');

    await Promise.allSettled(
      claims.map(async claim => {
        try {
          const trip = await this.trips.getTrip(claim.tripId, claim.tripSnapshot!.correlation_id);

          await runInTransaction(this.database, async manager => {
            const job = await this.current(manager, claim);

            if (!job || !trip || trip.version < job.latestTripVersion) {
              return;
            }

            const offer = await manager
              .getRepository(OfferEntity)
              .findOneOrFail({
                where: { id: job.currentOfferId! },
                lock: { mode: 'pessimistic_write' },
              });
            let result: OfferResolutionResult | undefined;

            if (['CANCELLING', 'CANCELLED', 'NO_DRIVER'].includes(trip.status)) {
              result = 'CANCELLED';
            } else if (
              ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'].includes(trip.status) &&
              trip.assignmentId === offer.assignmentId &&
              trip.driverId === offer.driverId
            ) {
              result = 'ASSIGNED';
            } else if (trip.status === 'MATCHING' && trip.assignmentId !== offer.assignmentId) {
              result = 'RETRY';
            }

            if (result) {
              job.latestTripVersion = trip.version;
              await this.state.resolve(manager, job, offer, result);
            }
            // ASSIGNING/unknown giữ nguyên CLAIMED; không dùng hạn OPEN để tự mở lại.
          });
        } finally {
          await this.reschedule(claim, 5000);
        }
      }),
    );
  }
}
