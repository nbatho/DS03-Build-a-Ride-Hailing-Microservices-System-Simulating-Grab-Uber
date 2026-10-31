import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { RideEvent, TripPaymentStatus } from '@app/contracts';
import { NonRetryableEventError, enqueueOutboxEvent, processEventOnce } from '@app/messaging';
import { FareSnapshot } from './entities/fare-snapshot.entity';
import { Trip } from './entities/trip.entity';
import { decideFailed, decideSucceeded, paymentRequestedEvent } from './trip-payment-rules';
import { TRIP_INBOX, TRIP_OUTBOX_TABLE } from './trips.service';

type PaymentResult = RideEvent<'payment.succeeded' | 'payment.failed'>;

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

      if (decision.kind !== 'RETRY') {
        return;
      }

      await this.project(manager, trip, 'PENDING_RETRY', {
        ...event.payload,
        attemptNo: decision.nextAttempt,
      });

      const retry = paymentRequestedEvent(
        { ...trip, version: trip.version + 1 },
        await this.findFare(manager, trip),
        decision.nextAttempt,
        { correlationId: event.correlation_id, causationId: event.event_id },
      );

      await enqueueOutboxEvent(manager, TRIP_OUTBOX_TABLE, retry);
      // OutboxRelay chỉ lấy dòng đã đến next_retry_at, nên lịch thử lại sống qua restart mà không cần worker riêng.
      await manager.query(
        'UPDATE trip_schema.outbox_events SET next_retry_at = now() + make_interval(secs => $2) WHERE event_id = $1',
        [retry.event_id, decision.delaySeconds],
      );
    });
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
