const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const {
  decideFailed,
  decideReconcile,
  decideSucceeded,
  paymentRequestedEvent,
} = require('../../src/trips/trip-payment-rules');

const PENDING = { paymentStatus: 'PENDING', paymentVersion: 0 };

function reconcileCase() {
  const trip = {
    id: randomUUID(),
    passengerId: randomUUID(),
    paymentId: randomUUID(),
    status: 'COMPLETED',
    paymentStatus: 'PENDING',
  };
  const payment = {
    id: trip.paymentId,
    tripId: trip.id,
    passengerId: trip.passengerId,
    amount: '41000',
    currency: 'VND',
    status: 'SUCCEEDED',
    attemptNo: 1,
    retryable: false,
  };

  return { trip, payment };
}

test('a newer success is applied; an old or repeated one is ignored', () => {
  assert.deepEqual(decideSucceeded(PENDING, 2), { kind: 'SUCCEEDED' });
  assert.deepEqual(
    decideSucceeded({ paymentStatus: 'PENDING_RETRY', paymentVersion: 2 }, 3),
    { kind: 'SUCCEEDED' },
  );
  assert.deepEqual(
    decideSucceeded({ paymentStatus: 'PENDING_RETRY', paymentVersion: 3 }, 3),
    { kind: 'IGNORE' },
  );
  assert.deepEqual(decideSucceeded({ paymentStatus: 'SUCCEEDED', paymentVersion: 2 }, 3), {
    kind: 'IGNORE',
  });
});

test('a retryable failure schedules the next attempt after 5 then 15 seconds', () => {
  assert.deepEqual(decideFailed(PENDING, { paymentVersion: 2, attemptNo: 1, retryable: true }), {
    kind: 'RETRY',
    nextAttempt: 2,
    delaySeconds: 5,
  });
  assert.deepEqual(
    decideFailed(
      { paymentStatus: 'PENDING_RETRY', paymentVersion: 2 },
      { paymentVersion: 3, attemptNo: 2, retryable: true },
    ),
    { kind: 'RETRY', nextAttempt: 3, delaySeconds: 15 },
  );
});

test('a final failure or the last attempt ends the payment', () => {
  assert.deepEqual(decideFailed(PENDING, { paymentVersion: 2, attemptNo: 1, retryable: false }), {
    kind: 'FAILED',
  });
  assert.deepEqual(
    decideFailed(
      { paymentStatus: 'PENDING_RETRY', paymentVersion: 3 },
      { paymentVersion: 4, attemptNo: 3, retryable: true },
    ),
    { kind: 'FAILED' },
  );
});

test('a failure arriving after a newer result never moves the payment back', () => {
  for (const state of [
    { paymentStatus: 'SUCCEEDED', paymentVersion: 3 },
    { paymentStatus: 'FAILED', paymentVersion: 4 },
    { paymentStatus: 'PENDING_RETRY', paymentVersion: 3 },
  ]) {
    assert.deepEqual(decideFailed(state, { paymentVersion: 2, attemptNo: 1, retryable: true }), {
      kind: 'IGNORE',
    });
  }

  assert.deepEqual(
    decideFailed(
      { paymentStatus: 'SUCCEEDED', paymentVersion: 2 },
      { paymentVersion: 9, attemptNo: 2, retryable: true },
    ),
    { kind: 'IGNORE' },
  );
});

test('a late failure cannot reopen a payment that already failed', () => {
  assert.deepEqual(
    decideFailed(
      { paymentStatus: 'FAILED', paymentVersion: 0 },
      { paymentVersion: 5, attemptNo: 1, retryable: true },
    ),
    { kind: 'IGNORE' },
  );
});

test('reconciliation applies only final results that match the trip', () => {
  const { trip, payment } = reconcileCase();

  assert.equal(decideReconcile(trip, '41000', payment), 'SUCCEEDED');
  assert.equal(
    decideReconcile({ ...trip, paymentStatus: 'PENDING_RETRY' }, '41000', payment),
    'SUCCEEDED',
  );

  for (const failure of [
    { attemptNo: 1, retryable: false },
    { attemptNo: 3, retryable: true },
  ]) {
    assert.equal(decideReconcile(trip, '41000', { ...payment, status: 'FAILED', ...failure }), 'FAILED');
  }

  assert.equal(
    decideReconcile(trip, '41000', { ...payment, status: 'FAILED', attemptNo: 2, retryable: true }),
    'KEEP',
  );
  assert.equal(
    decideReconcile(trip, '41000', { ...payment, status: 'PENDING', attemptNo: 0, retryable: true }),
    'KEEP',
  );
});

test('reconciliation reports a payment that differs from the trip', () => {
  const { trip, payment } = reconcileCase();

  assert.equal(decideReconcile(trip, '41000', { ...payment, id: randomUUID() }), 'MISMATCH');
  assert.equal(decideReconcile(trip, '41000', { ...payment, tripId: randomUUID() }), 'MISMATCH');
  assert.equal(decideReconcile(trip, '41000', { ...payment, passengerId: randomUUID() }), 'MISMATCH');
  assert.equal(decideReconcile(trip, '41000', { ...payment, amount: '1' }), 'MISMATCH');
});

test('reconciliation leaves a settled trip alone', () => {
  const { trip, payment } = reconcileCase();

  for (const paymentStatus of ['SUCCEEDED', 'FAILED', 'NOT_REQUESTED']) {
    assert.equal(decideReconcile({ ...trip, paymentStatus }, '41000', payment), 'KEEP');
  }

  assert.equal(decideReconcile({ ...trip, status: 'IN_PROGRESS' }, '41000', payment), 'KEEP');
});

test('payment.requested uses the trip as aggregate and keeps the fixed paymentId', () => {
  const trip = {
    id: randomUUID(),
    passengerId: randomUUID(),
    paymentId: randomUUID(),
    version: 5,
  };
  const correlationId = randomUUID();
  const causationId = randomUUID();
  const eventId = randomUUID();
  const event = paymentRequestedEvent(trip, { amount: '41000', currency: 'VND' }, 2, {
    eventId,
    correlationId,
    causationId,
  });

  assert.equal(event.event_id, eventId);
  assert.equal(event.aggregate_id, trip.id);
  assert.equal(event.aggregate_version, 5);
  assert.equal(event.correlation_id, correlationId);
  assert.equal(event.causation_id, causationId);
  assert.deepEqual(event.payload, {
    paymentId: trip.paymentId,
    tripId: trip.id,
    passengerId: trip.passengerId,
    amount: '41000',
    currency: 'VND',
    attemptNo: 2,
  });
});
