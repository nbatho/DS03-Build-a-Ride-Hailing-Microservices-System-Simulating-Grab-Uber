const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  decideAttempt,
  attemptResult,
} = require('../../src/payments/payment-rules');
const {
  loadSimulatorConfig,
  simulateCharge,
} = require('../../src/payments/payment-simulator');

const request = {
  paymentId: 'b9bfefb8-1556-5e49-816c-4f95e3d86990',
  tripId: 'a1031bdc-44d7-5c67-93ff-7f11b2987aa4',
  passengerId: 'c15878c4-5fc0-5082-a243-691c58a8c3f3',
  amount: '41000',
  currency: 'VND',
  attemptNo: 1,
};
const fresh = {
  id: request.paymentId,
  tripId: request.tripId,
  passengerId: request.passengerId,
  amount: '41000',
  status: 'PENDING',
  version: 1,
  attemptNo: 0,
  retryable: true,
};

test('first attempt of a new payment is charged', () => {
  assert.deepEqual(decideAttempt(fresh, request), { kind: 'CHARGE' });
});

test('a succeeded payment is never charged again (BA 5.6: không thu hai lần)', () => {
  const succeeded = { ...fresh, status: 'SUCCEEDED', attemptNo: 1, retryable: false };

  assert.deepEqual(decideAttempt(succeeded, request), { kind: 'SKIP', reason: 'ALREADY_SUCCEEDED' });
  assert.deepEqual(decideAttempt(succeeded, { ...request, attemptNo: 2 }), {
    kind: 'SKIP',
    reason: 'ALREADY_SUCCEEDED',
  });
});

test('a re-sent request for an attempt already run does not create a new attempt', () => {
  const failed = { ...fresh, status: 'FAILED', attemptNo: 1, retryable: true };

  assert.deepEqual(decideAttempt(failed, request), {
    kind: 'SKIP',
    reason: 'ATTEMPT_ALREADY_PROCESSED',
  });
  assert.deepEqual(decideAttempt(failed, { ...request, attemptNo: 2 }), { kind: 'CHARGE' });
});

test('after a final failure later attempts are ignored', () => {
  const final = { ...fresh, status: 'FAILED', attemptNo: 1, retryable: false };

  assert.deepEqual(decideAttempt(final, { ...request, attemptNo: 2 }), {
    kind: 'SKIP',
    reason: 'FINAL_FAILURE',
  });
});

test('mismatched trip, passenger or amount and attempt > 3 are rejected', () => {
  for (const change of [
    { tripId: '00000000-0000-4000-8000-000000000000' },
    { passengerId: '00000000-0000-4000-8000-000000000000' },
    { amount: '99000' },
  ]) {
    assert.equal(decideAttempt(fresh, { ...request, ...change }).code, 'PAYMENT_MISMATCH');
  }

  assert.equal(decideAttempt(fresh, { ...request, attemptNo: 4 }).code, 'ATTEMPT_OUT_OF_RANGE');
});

test('temporary failure is retryable only before the 3rd attempt', () => {
  assert.deepEqual(attemptResult('SUCCESS', 1), { status: 'SUCCEEDED', retryable: false, reason: null });
  assert.deepEqual(attemptResult('TEMPORARY_FAILURE', 1), {
    status: 'FAILED',
    retryable: true,
    reason: 'SIMULATED_TEMPORARY_FAILURE',
  });
  assert.equal(attemptResult('TEMPORARY_FAILURE', 3).retryable, false);
  assert.deepEqual(attemptResult('FINAL_FAILURE', 1), {
    status: 'FAILED',
    retryable: false,
    reason: 'SIMULATED_FINAL_FAILURE',
  });
});

test('simulator modes', () => {
  const run = (mode, attempt, random) =>
    simulateCharge({ mode, failureRate: 0.5 }, attempt, random);

  assert.equal(run('SUCCEED', 1), 'SUCCESS');
  assert.equal(run('FAIL_ONCE', 1), 'TEMPORARY_FAILURE');
  assert.equal(run('FAIL_ONCE', 2), 'SUCCESS');
  assert.equal(run('TEMPORARY', 3), 'TEMPORARY_FAILURE');
  assert.equal(run('FINAL', 1), 'FINAL_FAILURE');
  assert.equal(run('RANDOM', 1, () => 0.4), 'TEMPORARY_FAILURE');
  assert.equal(run('RANDOM', 1, () => 0.6), 'SUCCESS');
});

test('simulator config defaults to SUCCEED and rejects bad values', () => {
  assert.deepEqual(loadSimulatorConfig({}), { mode: 'SUCCEED', failureRate: 0.2 });
  assert.equal(loadSimulatorConfig({ PAYMENT_SIMULATION_MODE: 'fail_once' }).mode, 'FAIL_ONCE');
  assert.throws(() => loadSimulatorConfig({ PAYMENT_SIMULATION_MODE: 'MAYBE' }), /PAYMENT_SIMULATION_MODE/);
  assert.throws(() => loadSimulatorConfig({ PAYMENT_FAILURE_RATE: '2' }), /PAYMENT_FAILURE_RATE/);
});
