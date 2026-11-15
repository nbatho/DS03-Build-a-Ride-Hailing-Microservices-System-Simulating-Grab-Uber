require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { validateRideEvent } = require('@app/contracts');
const { handleDelivery, NonRetryableEventError } = require('@app/messaging');
const { ApiError } = require('@app/runtime');
const { readCandidates, readTrip } = require('../../src/matching/upstream-contracts');
const {
  matchingEventHandlers,
  toEventError,
} = require('../../src/matching/matching-events.consumer');

const silent = { warn() {}, error() {} };

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

// Matching dựa vào validator chung cho các bảo đảm mà trước đây nó tự kiểm tra.
test('shared contract accepts the canonical event and rejects what Matching must never process', () => {
  const original = event();

  assert.equal(validateRideEvent(original).ok, true);

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
    assert.equal(validateRideEvent(value).ok, false);
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

test('4xx ApiError becomes NonRetryableEventError with its code; other errors stay retryable', () => {
  const permanent = toEventError(new ApiError(400, 'INVALID_EVENT', 'conflicting metadata'));

  assert.ok(permanent instanceof NonRetryableEventError);
  assert.equal(permanent.code, 'INVALID_EVENT');
  assert.equal(permanent.message, 'conflicting metadata');

  const transient = new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'DB offline');

  assert.equal(toEventError(transient), transient);
});

function harness() {
  const state = { acks: 0, routes: [] };

  return {
    state,
    channel: { ack: () => state.acks++, nack: () => assert.fail('must not nack') },
    sender: {
      publishConfirmed: async (_exchange, queue, _content, options) =>
        state.routes.push({ queue, headers: options.headers }),
    },
  };
}

function delivery(value, headers = {}) {
  return {
    content: Buffer.from(JSON.stringify(value)),
    fields: { redelivered: false },
    properties: { messageId: value.event_id, headers },
  };
}

function handlersFailingWith(error) {
  const fail = async () => {
    throw error;
  };

  return matchingEventHandlers({ createJobFromRequested: fail, cancelJobFromEvent: fail });
}

test('Matching handlers on matching.events: DB failure retries 1s/5s/15s then DLQ', async () => {
  const value = event();
  const { state, channel, sender } = harness();
  const handlers = handlersFailingWith(new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'DB offline'));

  for (let retries = 0; retries <= 3; retries++) {
    await handleDelivery(
      channel,
      sender,
      'matching.events',
      handlers,
      delivery(value, { 'x-retry-count': retries }),
      silent,
    );
  }

  assert.deepEqual(
    state.routes.map(route => route.queue),
    [
      'matching.events.retry.1s',
      'matching.events.retry.5s',
      'matching.events.retry.15s',
      'matching.events.dlq',
    ],
  );
  assert.equal(state.routes[3].headers['x-error-code'], 'RETRIES_EXHAUSTED');
  assert.equal(state.acks, 4);
});

test('Matching handlers on matching.events: 4xx goes straight to DLQ with the API error code', async () => {
  const { state, channel, sender } = harness();
  const outcome = await handleDelivery(
    channel,
    sender,
    'matching.events',
    handlersFailingWith(new ApiError(400, 'INVALID_EVENT', 'Event ID has conflicting metadata')),
    delivery(event()),
    silent,
  );

  assert.equal(outcome, 'DEAD_LETTERED');
  assert.equal(state.routes[0].queue, 'matching.events.dlq');
  assert.equal(state.routes[0].headers['x-error-code'], 'INVALID_EVENT');
  assert.equal(state.acks, 1);
});

test('Matching handlers receive the validated event and the delivery is ACKed', async () => {
  const value = event();
  const seen = [];
  const { state, channel, sender } = harness();
  const outcome = await handleDelivery(
    channel,
    sender,
    'matching.events',
    matchingEventHandlers({
      createJobFromRequested: async received => seen.push(received.event_id),
      cancelJobFromEvent: async () => assert.fail('wrong handler'),
    }),
    delivery(value),
    silent,
  );

  assert.equal(outcome, 'ACKED');
  assert.deepEqual(seen, [value.event_id]);
  assert.equal(state.routes.length, 0);
  assert.equal(state.acks, 1);
});
