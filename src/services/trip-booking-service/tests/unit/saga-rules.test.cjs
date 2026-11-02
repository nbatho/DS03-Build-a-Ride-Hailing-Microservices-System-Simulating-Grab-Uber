const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const {
  ACCEPT_STEPS,
  CANCEL_STEPS,
  COMPLETE_STEPS,
  MAX_CYCLES,
  REJECT_STEPS,
  backoffMs,
  isClosedResolution,
  onExhausted,
} = require('../../src/trips/saga/saga-rules');
const {
  readOffer,
  readReservation,
  readResult,
} = require('../../src/trips/upstream-contracts');

function rejected(work) {
  assert.throws(work, error => error.getResponse().code === 'DEPENDENCY_UNAVAILABLE');
}

test('backoff doubles and is capped', () => {
  assert.deepEqual([0, 1, 2, 3].map(backoffMs), [1000, 2000, 4000, 8000]);
  assert.equal(backoffMs(10), 30000);
  assert.equal(MAX_CYCLES, 5);
});

test('exhausting a step before the commit compensates; after it needs review', () => {
  for (const step of ['CLAIM_OFFER', 'RESERVE_DRIVER', 'CONFIRM_DRIVER']) {
    assert.equal(onExhausted(step), 'RELEASE_DRIVER');
  }

  const others = [...ACCEPT_STEPS, ...REJECT_STEPS, ...COMPLETE_STEPS, ...CANCEL_STEPS].filter(
    step => !['CLAIM_OFFER', 'RESERVE_DRIVER', 'CONFIRM_DRIVER'].includes(step),
  );

  for (const step of others) {
    assert.equal(onExhausted(step), 'FAILED_NEEDS_REVIEW');
  }
});

test('only codes meaning the claim is closed let compensation continue', () => {
  for (const code of ['ASSIGNMENT_MISMATCH', 'RESOLUTION_CONFLICT', 'JOB_CANCELLED', 'PAYLOAD_MISMATCH']) {
    assert.equal(isClosedResolution(code), true);
  }

  for (const code of ['OFFER_NOT_FOUND', 'JOB_NOT_FOUND', 'SOMETHING_ELSE']) {
    assert.equal(isClosedResolution(code), false);
  }
});

test('readResult separates business outcomes from configuration errors', () => {
  const read = body => body;

  assert.deepEqual(readResult('X', { status: 200, body: 1 }, read), { ok: true, body: 1 });

  for (const [status, code] of [
    [409, 'DRIVER_UNAVAILABLE'],
    [404, 'RESERVATION_NOT_FOUND'],
    [403, 'DRIVER_MISMATCH'],
  ]) {
    assert.deepEqual(readResult('X', { status, body: { code } }, read), { ok: false, code });
  }

  for (const [status, body] of [
    [400, { code: 'VALIDATION_ERROR' }],
    [401, { code: 'INTERNAL_CALLER_FORBIDDEN' }],
    [403, { code: 'INTERNAL_CALLER_FORBIDDEN' }],
    [404, undefined],
    [500, { code: 'INTERNAL_ERROR' }],
    [503, { code: 'DEPENDENCY_UNAVAILABLE' }],
  ]) {
    rejected(() => readResult('X', { status, body }, read));
  }
});

test('readOffer and readReservation check identity and status', () => {
  const offer = {
    id: randomUUID(),
    jobId: randomUUID(),
    tripId: randomUUID(),
    driverId: randomUUID(),
    status: 'OPEN',
    expiresAt: '2026-10-31T00:00:15.000Z',
    version: 1,
  };

  assert.deepEqual(readOffer(offer, offer.id), offer);
  rejected(() => readOffer(offer, randomUUID()));
  rejected(() => readOffer({ ...offer, status: 'DONE' }, offer.id));
  rejected(() => readOffer({ ...offer, jobId: 'x' }, offer.id));
  rejected(() => readOffer({ ...offer, expiresAt: 'soon' }, offer.id));

  const reservation = {
    id: randomUUID(),
    tripId: offer.tripId,
    driverId: offer.driverId,
    status: 'RELEASED',
    version: 1,
  };
  const check = value => readReservation(value, reservation.id, offer.tripId, offer.driverId);

  assert.deepEqual(check(reservation), reservation);
  rejected(() => check({ ...reservation, id: randomUUID() }));
  rejected(() => check({ ...reservation, tripId: randomUUID() }));
  rejected(() => check({ ...reservation, driverId: randomUUID() }));
  rejected(() => check({ ...reservation, status: 'DONE' }));
});
