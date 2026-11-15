import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { Payment, RideEvent, TripPaymentStatus } from '@app/contracts';
import { NonRetryableEventError, enqueueOutboxEvent, processEventOnce } from '@app/messaging';
import { runInTransaction } from '@app/runtime';
import { FareSnapshot } from './entities/fare-snapshot.entity';
import { Trip } from './entities/trip.entity';
import {
  decideFailed,
  decideReconcile,
  decideSucceeded,
  paymentRequestedEvent,
  type ReconcileDecision,
} from './trip-payment-rules';
import { TRIP_INBOX, TRIP_OUTBOX_TABLE } from './trip-tables';

type PaymentResult = RideEvent<'payment.succeeded' | 'payment.failed'>;

const RECONCILE_AFTER_SECONDS = 60;

function mismatch(event: PaymentResult, reason: string): NonRetryableEventError {
  return new NonRetryableEventError(
    'PAYMENT_MISMATCH',
    'Payment ' + event.payload.paymentId + ': ' + reason,
  );
}

@Injectable()
export class TripPaymentsService {
  constructor(private readonly database: DataSource) {}

  async handlePaymentSucceeded(event: RideEvent<'payment.succeeded'>): Promise<void> {
    await processEventOnce(this.database, TRIP_INBOX, event, async manager => {
      const trip = await this.lockTrip(manager, event);
      const fare = await this.findFare(manager, trip);

      if (event.payload.amount !== fare.amount) {
        throw mismatch(event, 'amount differs from the fare');
      }

      if (decideSucceeded(trip, event.payload.paymentVersion).kind === 'SUCCEEDED') {
        await this.project(manager, trip, 'SUCCEEDED', event.payload);
      }
    });
  }

  async handlePaymentFailed(event: RideEvent<'payment.failed'>): Promise<void> {
    await processEventOnce(this.database, TRIP_INBOX, event, async manager => {
      const trip = await this.lockTrip(manager, event);
      const decision = decideFailed(trip, event.payload);

      if (decision.kind === 'FAILED') {
        await this.project(manager, trip, 'FAILED', event.payload);
      }

      if (decision.kind === 'RETRY') {
        await this.scheduleRetry(manager, trip, event.payload.paymentVersion, decision, {
          correlationId: event.correlation_id,
          causationId: event.event_id,
        });
      }
    });
  }

  // Thứ tự ngẫu nhiên để các chuyến phải giữ nguyên không chiếm mãi lượt của chuyến khác.
  findUnsettled(limit: number): Promise<Array<Pick<Trip, 'id' | 'paymentId'>>> {
    return this.database
      .getRepository(Trip)
      .createQueryBuilder('trip')
      .select(['trip.id', 'trip.paymentId'])
      .where("trip.status = 'COMPLETED'")
      .andWhere("trip.paymentStatus IN ('PENDING', 'PENDING_RETRY')")
      .andWhere('trip.updatedAt < now() - make_interval(secs => :age)', { age: RECONCILE_AFTER_SECONDS })
      .orderBy('random()')
      .limit(limit)
      .getMany();
  }

  reconcile(tripId: string, payment: Payment): Promise<ReconcileDecision> {
    return runInTransaction(this.database, async manager => {
      const trip = await manager
        .getRepository(Trip)
        .findOneOrFail({ where: { id: tripId }, lock: { mode: 'pessimistic_write' } });
      const fare = await this.findFare(manager, trip);
      const decision = decideReconcile(trip, fare.amount, payment);

      if (decision === 'SUCCEEDED' || decision === 'FAILED') {
        await this.project(manager, trip, decision, {
          paymentVersion: trip.paymentVersion,
          attemptNo: payment.attemptNo,
        });
      }

      if (decision === 'RETRY') {
        const correlationId = randomUUID();

        await this.scheduleRetry(
          manager,
          trip,
          trip.paymentVersion,
          { nextAttempt: payment.attemptNo + 1, delaySeconds: 0 },
          { correlationId, causationId: correlationId },
        );
      }

      return decision;
    });
  }

  private async scheduleRetry(
    manager: EntityManager,
    trip: Trip,
    paymentVersion: number,
    retry: { nextAttempt: number; delaySeconds: number },
    meta: { correlationId: string; causationId: string },
  ): Promise<void> {
    await this.project(manager, trip, 'PENDING_RETRY', { paymentVersion, attemptNo: retry.nextAttempt });

    const event = paymentRequestedEvent(
      { ...trip, version: trip.version + 1 },
      await this.findFare(manager, trip),
      retry.nextAttempt,
      meta,
    );

    await enqueueOutboxEvent(manager, TRIP_OUTBOX_TABLE, event);
    // OutboxRelay chỉ lấy dòng đã đến next_retry_at, nên lịch thử lại sống qua restart mà không cần worker riêng.
    await manager.query(
      'UPDATE trip_schema.outbox_events SET next_retry_at = now() + make_interval(secs => $2) WHERE event_id = $1',
      [event.event_id, retry.delaySeconds],
    );
  }

  private async lockTrip(manager: EntityManager, event: PaymentResult): Promise<Trip> {
    const { tripId, paymentId, passengerId } = event.payload;
    const trip = await manager
      .getRepository(Trip)
      .findOne({ where: { id: tripId }, lock: { mode: 'pessimistic_write' } });

    if (!trip) {
      throw new NonRetryableEventError('TRIP_NOT_FOUND', 'Trip ' + tripId + ' does not exist');
    }

    if (trip.status !== 'COMPLETED') {
      throw mismatch(event, 'trip is ' + trip.status);
    }

    if (trip.paymentId !== paymentId || trip.passengerId !== passengerId) {
      throw mismatch(event, 'identifiers differ from trip ' + tripId);
    }

    return trip;
  }

  private findFare(manager: EntityManager, trip: Trip): Promise<FareSnapshot> {
    return manager.getRepository(FareSnapshot).findOneByOrFail({ tripId: trip.id });
  }

  private async project(
    manager: EntityManager,
    trip: Trip,
    paymentStatus: TripPaymentStatus,
    result: { paymentVersion: number; attemptNo: number },
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Trip)
      .set({
        paymentStatus,
        paymentVersion: result.paymentVersion,
        paymentAttemptNo: result.attemptNo,
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      })
      .where({ id: trip.id })
      .execute();
  }
}
