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
        properties: { messageId: value.event_id, headers: { 'x-retry-count': attempt } },
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

function consumerWith(routes, handled = []) {
  return new MatchingEventsConsumer(
    {
      publish: async (_exchange, queue, content, properties) => {
        routes.push({ queue, content, headers: properties.headers });
      },
    },
    {
      createJobFromRequested: async envelope => {
        handled.push(envelope.event_id);
      },
    },
    {},
  );
}

test('an event up to 128 KiB is processed (same limit as @app/messaging)', async () => {
  const value = event();
  const content = Buffer.from(JSON.stringify({ ...value, padding: 'x'.repeat(90_000 - JSON.stringify(value).length) }));
  const routes = [];
  const handled = [];
  let acked = false;

  assert.ok(content.length >= 89_000 && content.length <= 128 * 1024);
  await consumerWith(routes, handled).process(
    { content, properties: { messageId: value.event_id, headers: {} } },
    { ack: () => (acked = true) },
  );
  assert.ok(handled.length === 1 || routes[0]?.headers['x-error-code'] !== 'EVENT_TOO_LARGE');
  assert.equal(acked, true);
});

test('an event over 128 KiB goes to the DLQ truncated, with an error code and the original size', async () => {
  const content = Buffer.alloc(140_000, 'a');
  const routes = [];
  let acked = false;

  await consumerWith(routes).process(
    { content, properties: { messageId: randomUUID(), headers: { 'x-matching-retry': 2 } } },
    { ack: () => (acked = true) },
  );

  assert.equal(routes.length, 1);
  assert.equal(routes[0].queue, 'matching.events.dlq');
  assert.equal(routes[0].content.length, 1024);
  assert.equal(routes[0].headers['x-error-code'], 'EVENT_TOO_LARGE');
  assert.equal(routes[0].headers['x-original-size'], 140_000);
  assert.equal(routes[0].headers['x-matching-retry'], undefined);
  assert.equal(acked, true);
});

test('retries use x-retry-count so npm run events:dlq -- --replay resets them; DLQ copies carry the error', async () => {
  const value = event();
  const routes = [];
  const consumer = new MatchingEventsConsumer(
    { publish: async (_exchange, queue, _content, properties) => routes.push({ queue, headers: properties.headers }) },
    {
      createJobFromRequested: async () => {
        throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'DB offline');
      },
    },
    {},
  );
  const deliver = headers =>
    consumer.process(
      { content: Buffer.from(JSON.stringify(value)), properties: { messageId: value.event_id, headers } },
      { ack: () => undefined },
    );

  await deliver({});
  await deliver({ 'x-retry-count': 3 });
  await deliver({});

  assert.equal(routes[0].queue, 'matching.events.retry.1s');
  assert.equal(routes[0].headers['x-retry-count'], 1);
  assert.equal(routes[1].queue, 'matching.events.dlq');
  assert.equal(routes[1].headers['x-error-code'], 'RETRIES_EXHAUSTED');
  assert.equal(routes[1].headers['x-error-message'], 'DB offline');
  assert.equal(routes[2].queue, 'matching.events.retry.1s');
});
