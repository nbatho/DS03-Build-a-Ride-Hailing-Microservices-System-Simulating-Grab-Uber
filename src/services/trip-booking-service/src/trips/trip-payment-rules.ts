import {
  MAX_PAYMENT_ATTEMPTS,
  type RideEvent,
  type TripPaymentStatus,
} from '@app/contracts';
import { createRideEvent } from '@app/messaging';
import type { FareSnapshot } from './entities/fare-snapshot.entity';
import type { Trip } from './entities/trip.entity';

export const PAYMENT_RETRY_DELAY_SECONDS: Readonly<Record<number, number>> = { 1: 5, 2: 15 };

export interface PaymentProjection {
  paymentStatus: TripPaymentStatus;
  paymentVersion: number;
}

export type PaymentDecision =
  | { kind: 'IGNORE' }
  | { kind: 'SUCCEEDED' }
  | { kind: 'FAILED' }
  | { kind: 'RETRY'; nextAttempt: number; delaySeconds: number };

function isStale(state: PaymentProjection, paymentVersion: number): boolean {
  return state.paymentStatus === 'SUCCEEDED' || paymentVersion <= state.paymentVersion;
}

export function decideSucceeded(state: PaymentProjection, paymentVersion: number): PaymentDecision {
  return isStale(state, paymentVersion) ? { kind: 'IGNORE' } : { kind: 'SUCCEEDED' };
}

export function decideFailed(
  state: PaymentProjection,
  failure: { paymentVersion: number; attemptNo: number; retryable: boolean },
): PaymentDecision {
  if (isStale(state, failure.paymentVersion)) {
    return { kind: 'IGNORE' };
  }

  if (!failure.retryable || failure.attemptNo >= MAX_PAYMENT_ATTEMPTS) {
    return { kind: 'FAILED' };
  }

  return {
    kind: 'RETRY',
    nextAttempt: failure.attemptNo + 1,
    delaySeconds: PAYMENT_RETRY_DELAY_SECONDS[failure.attemptNo],
  };
}

export function paymentRequestedEvent(
  trip: Pick<Trip, 'id' | 'passengerId' | 'paymentId' | 'version'>,
  fare: Pick<FareSnapshot, 'amount' | 'currency'>,
  attemptNo: number,
  meta: { eventId?: string; correlationId: string; causationId: string },
): RideEvent<'payment.requested'> {
  return createRideEvent('payment.requested', {
    ...(meta.eventId ? { eventId: meta.eventId } : {}),
    aggregateId: trip.id,
    aggregateVersion: trip.version,
    correlationId: meta.correlationId,
    causationId: meta.causationId,
    payload: {
      paymentId: trip.paymentId!,
      tripId: trip.id,
      passengerId: trip.passengerId,
      amount: fare.amount,
      currency: fare.currency,
      attemptNo,
    },
  });
}
