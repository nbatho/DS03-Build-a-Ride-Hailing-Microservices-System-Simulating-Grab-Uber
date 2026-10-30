const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { readJob, readQuote } = require('../../src/trips/upstream-contracts');
const { decodeCursor, encodeCursor } = require('../../src/trips/cursor');
const { toTrip, toTripProgress } = require('../../src/trips/entities/trip.entity');
const { toOperation } = require('../../src/trips/entities/operation.entity');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };

function quote(fields = {}) {
  return {
    id: randomUUID(),
    passengerId: randomUUID(),
    pickup: POINT,
    dropoff: POINT,
    distanceMeters: 3000,
    durationSeconds: 600,
    amount: '41000',
    currency: 'VND',
    ruleVersion: 'CAR_V1',
    expiresAt: '2026-10-31T00:05:00.000Z',
    ...fields,
  };
}

function trip(fields = {}) {
  return {
    id: randomUUID(),
    passengerId: randomUUID(),
    driverId: null,
    quoteId: randomUUID(),
    assignmentId: null,
    pickup: POINT,
    dropoff: POINT,
    status: 'MATCHING',
    paymentId: null,
    paymentStatus: 'NOT_REQUESTED',
    version: 1,
    createdAt: new Date('2026-10-31T00:00:00.000Z'),
    updatedAt: new Date('2026-10-31T00:00:00.000Z'),
    fare: { amount: '41000', currency: 'VND' },
    ...fields,
  };
}

function rejected(work, code = 'DEPENDENCY_UNAVAILABLE') {
  assert.throws(work, error => error.getResponse().code === code);
}

test('readQuote accepts the Pricing contract and keeps only the Point fields', () => {
  const value = quote({ pickup: { ...POINT, extra: true } });
  const result = readQuote(value, value.id);

  assert.deepEqual(result.pickup, POINT);
  assert.equal(result.amount, '41000');
});

test('readQuote rejects responses that do not match the contract', () => {
  const broken = [
    { passengerId: 'not-a-uuid' },
    { pickup: { ...POINT, lat: 91 } },
    { dropoff: { ...POINT, zoneId: 'ZONE_C' } },
    { distanceMeters: 0 },
    { durationSeconds: 1.5 },
    { amount: 41000 },
    { amount: '-1' },
    { amount: '123456789012345' },
    { currency: 'USD' },
    { ruleVersion: '' },
    { expiresAt: 'soon' },
  ];

  for (const fields of broken) {
    const value = quote(fields);

    rejected(() => readQuote(value, value.id));
  }

  rejected(() => readQuote(quote(), randomUUID()));
  rejected(() => readQuote(null, randomUUID()));
});

test('readJob checks identity, status and version', () => {
  const tripId = randomUUID();
  const job = { id: randomUUID(), tripId, status: 'FAILED', version: 2 };

  assert.deepEqual(readJob(job, tripId), job);
  rejected(() => readJob(job, randomUUID()));
  rejected(() => readJob({ ...job, id: 'x' }, tripId));
  rejected(() => readJob({ ...job, status: 'DONE' }, tripId));
  rejected(() => readJob({ ...job, version: 0 }, tripId));
  rejected(() => readJob(undefined, tripId));
});

test('cursor round-trips a PostgreSQL timestamp and rejects malformed values', () => {
  const position = { createdAt: '2026-10-31 00:00:00.123456+00', id: randomUUID() };

  assert.deepEqual(decodeCursor(encodeCursor(position)), position);

  for (const cursor of [
    'not-a-cursor',
    encodeCursor({ createdAt: 'never', id: randomUUID() }),
    encodeCursor({ createdAt: position.createdAt, id: 'x' }),
    Buffer.from('{"a":1}').toString('base64url'),
  ]) {
    rejected(() => decodeCursor(cursor), 'INVALID_CURSOR');
  }
});

test('toTrip omits empty optional fields instead of returning null', () => {
  const result = toTrip(trip());

  assert.deepEqual(Object.keys(result).sort(), [
    'amount',
    'createdAt',
    'currency',
    'dropoff',
    'id',
    'passengerId',
    'paymentStatus',
    'pickup',
    'quoteId',
    'status',
    'updatedAt',
    'version',
  ]);
  assert.equal(result.amount, '41000');
});

test('toTripProgress hides assignment and payment identifiers', () => {
  const full = trip({
    status: 'ASSIGNED',
    driverId: randomUUID(),
    assignmentId: randomUUID(),
    paymentId: randomUUID(),
  });

  assert.ok(toTrip(full).driverId);

  const progress = toTripProgress(full);

  for (const field of ['driverId', 'assignmentId', 'paymentId']) {
    assert.equal(field in progress, false);
  }

  assert.equal(progress.status, 'ASSIGNED');
  assert.equal(progress.amount, '41000');
});

test('toOperation takes tripStatus from the trip and omits empty fields', () => {
  const operation = {
    id: randomUUID(),
    tripId: randomUUID(),
    actorId: randomUUID(),
    type: 'ACCEPT',
    status: 'PENDING',
    assignmentId: null,
    errorCode: null,
    updatedAt: new Date('2026-10-31T00:00:00.000Z'),
    trip: { status: 'ASSIGNING' },
  };

  assert.deepEqual(toOperation(operation), {
    id: operation.id,
    tripId: operation.tripId,
    type: 'ACCEPT',
    status: 'PENDING',
    tripStatus: 'ASSIGNING',
    updatedAt: '2026-10-31T00:00:00.000Z',
  });
});
