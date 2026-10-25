require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { readTripEvent, readCandidates, readTrip } = require('../../src/matching/event-contracts');
const { MatchingEventsConsumer } = require('../../src/matching/matching-events.consumer');
const { ApiError } = require('@app/runtime');

function event() {
  const tripId = randomUUID();

  return {
    event_id: randomUUID(),
    type: 'trip.requested',
    schema_version: 1,
    aggregate_id: tripId,
    aggregate_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    producer: 'trip-booking-service',
    payload: {
      tripId,
      passengerId: randomUUID(),
      pickup: { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' },
      dropoff: { lat: 10.78, lng: 106.7, zoneId: 'ZONE_B' },
      amount: '41000',
      currency: 'VND',
      tripVersion: 1,
    },
  };
}

test('accepts canonical BA event and string money', () => {
  const value = event();

  assert.deepEqual(readTripEvent(value), value);
});

test('rejects mismatched aggregate, version, producer, invalid coordinates and extra fields', () => {
  const original = event();

  for (const value of [
    { ...original, aggregate_id: randomUUID() },
    { ...original, aggregate_version: 2 },
    { ...original, producer: 'driver-vehicle-location-service' },
    { ...original, extra: 1 },
    { ...original, payload: { ...original.payload, amount: 41000 } },
    {
      ...original,
      payload: { ...original.payload, pickup: { ...original.payload.pickup, lat: 91 } },
    },
  ]) {
    assert.throws(
      () => readTripEvent(value),
      error => error.getStatus() === 400,
    );
  }
});

test('rejects invalid candidates instead of treating a dependency error as an empty list', () => {
  assert.deepEqual(readCandidates({ items: [] }), { items: [] });
  assert.throws(() => readCandidates({ items: [{ driverId: randomUUID() }] }));
  assert.throws(() => readCandidates({ error: 'unavailable' }));
});

test('unknown Trip state cannot be used to release a claim', () => {
  assert.throws(() => readTrip({ id: randomUUID(), status: 'ASSIGNED' }, randomUUID()));
});

test('transient consumer failures retry at 1/5/15 seconds then move to DLQ; ACK follows publish confirmation', async () => {
  const value = event();
  const routes = [];
  let confirmed = false;
  let acknowledgements = 0;
  const consumer = new MatchingEventsConsumer(
    {
      publish: async (_exchange, queue) => {
        routes.push(queue);
        confirmed = true;
      },
    },
    {
      createJobFromRequested: async () => {
        throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'DB offline');
      },
    },
    {},
  );

  for (let attempt = 0; attempt <= 3; attempt++) {
    confirmed = false;
    await consumer.process(
      {
        content: Buffer.from(JSON.stringify(value)),
        properties: { messageId: value.event_id, headers: { 'x-matching-retry': attempt } },
      },
      {
        ack: () => {
          assert.equal(confirmed, true);
          acknowledgements++;
        },
      },
    );
  }

  assert.deepEqual(routes, [
    'matching.events.retry.1s',
    'matching.events.retry.5s',
    'matching.events.retry.15s',
    'matching.events.dlq',
  ]);
  assert.equal(acknowledgements, 4);
});

test('failed retry publish leaves the original delivery unacknowledged', async () => {
  const value = event();
  let acknowledged = false;
  const consumer = new MatchingEventsConsumer(
    {
      publish: async () => {
        throw new Error('broker lost');
      },
    },
    {
      createJobFromRequested: async () => {
        throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'DB offline');
      },
    },
    {},
  );

  await assert.rejects(() =>
    consumer.process(
      { content: Buffer.from(JSON.stringify(value)), properties: { headers: {} } },
      {
        ack: () => {
          acknowledged = true;
        },
      },
    ),
  );
  assert.equal(acknowledged, false);
});
