require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  EVENT_CATALOG,
  EVENT_TYPES,
  EVENT_QUEUES,
  validateRideEvent,
  assertRideEvent,
  buildEventsJsonSchema,
} = require('@app/contracts');
const {
  describeTopology,
  assertTopology,
  retryQueueName,
  deadLetterQueueName,
  createRideEvent,
  handleDelivery,
  NonRetryableEventError,
  loadMessagingConfig,
  redactUrl,
} = require('@app/messaging');

const root = path.resolve(__dirname, '../../../..');
const samplesDir = path.join(root, 'docs/events/samples');
const samples = fs
  .readdirSync(samplesDir)
  .sort()
  .map(file => ({
    file,
    event: JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8')),
  }));
const sample = type => structuredClone(samples.find(item => item.event.type === type).event);
const silent = { warn() {}, error() {} };

test('catalog has the 11 events of Phụ lục C with their codes and samples', () => {
  assert.equal(EVENT_TYPES.length, 11);
  assert.equal(samples.length, 11);
  for (const { file, event } of samples) {
    const code = EVENT_CATALOG[event.type].code.toLowerCase();

    assert.equal(file, code + '.' + event.type + '.json');
  }
});

test('every sample event passes runtime validation', () => {
  for (const { file, event } of samples) {
    const result = validateRideEvent(event);

    assert.ok(result.ok, file + ': ' + (result.ok ? '' : result.errors.join('; ')));
  }
});

test('validation rejects contract drift', () => {
  const cases = [
    ['missing payload field', e => delete e.payload.tripVersion, /payload.tripVersion is required/],
    ['extra payload field', e => (e.payload.price = 1), /payload.price is not allowed/],
    ['extra envelope field', e => (e.eventId = e.event_id), /\$.eventId is not allowed/],
    [
      'wrong producer',
      e => (e.producer = 'matching-service'),
      /producer must be trip-booking-service/,
    ],
    ['amount as number', e => (e.payload.amount = 41000), /amount must be a VND integer string/],
    ['bad zone', e => (e.payload.pickup.zoneId = 'ZONE_C'), /pickup.zoneId must be one of/],
    ['schema version 2', e => (e.schema_version = 2), /schema_version must be 1/],
    [
      'aggregate id mismatch',
      e => (e.aggregate_id = randomUUID()),
      /aggregate_id must equal the trip id/,
    ],
    [
      'aggregate version mismatch',
      e => (e.aggregate_version = 2),
      /aggregate_version must equal the trip version/,
    ],
    ['unknown type', e => (e.type = 'trip.updated'), /type must be one of/],
    ['bad timestamp', e => (e.occurred_at = '11/10/2026'), /occurred_at must be an ISO-8601/],
  ];

  for (const [name, mutate, expected] of cases) {
    const event = sample('trip.requested');

    mutate(event);
    const result = validateRideEvent(event);

    assert.equal(result.ok, false, name);
    assert.match(result.errors.join('\n'), expected, name);
  }

  const cancelled = sample('trip.cancelled');

  cancelled.payload.affectedDriverIds = [];
  assert.ok(validateRideEvent(cancelled).ok, 'affectedDriverIds may be empty');
  const failed = sample('payment.failed');

  failed.payload.paymentVersion = 2;
  assert.match(
    validateRideEvent(failed).errors.join(),
    /aggregate_version must equal the payment version/,
  );

  const offer = sample('matching.offer.created');

  offer.aggregate_id = offer.payload.offer.id;
  assert.match(
    validateRideEvent(offer).errors.join(),
    /aggregate_id must equal the matching_job id/,
  );
});

test('queue bindings follow BA mục 8.1', () => {
  const topology = describeTopology();

  assert.equal(topology.exchange, 'ride.events');
  const bindings = Object.fromEntries(
    topology.queues.map(queue => [queue.name, [...queue.bindings].sort()]),
  );

  assert.deepEqual(bindings, {
    'matching.events': ['trip.cancelled', 'trip.requested'],
    'trip.events': ['matching.failed', 'payment.failed', 'payment.succeeded'],
    'payment.events': ['payment.requested'],
    'notification.events': [
      'matching.offer.created',
      'payment.failed',
      'payment.succeeded',
      'trip.accepted',
      'trip.cancelled',
      'trip.completed',
      'trip.no_driver',
      'trip.started',
    ],
  });

  for (const type of EVENT_TYPES) {
    assert.ok(EVENT_CATALOG[type].queues.length > 0, type + ' must have a consumer queue');
  }

  assert.deepEqual(
    [0, 1, 2].map(index => retryQueueName(EVENT_QUEUES.TRIP, index)),
    ['trip.events.retry.1s', 'trip.events.retry.5s', 'trip.events.retry.15s'],
  );

  assert.equal(deadLetterQueueName(EVENT_QUEUES.TRIP), 'trip.events.dlq');
  assert.throws(() => retryQueueName(EVENT_QUEUES.TRIP, 3), RangeError);
});

test('assertTopology declares exchange, queues, bindings and retry dead-lettering back to the source queue', async () => {
  const calls = [];
  const channel = {
    assertExchange: async (...args) => calls.push(['exchange', ...args]),
    assertQueue: async (...args) => calls.push(['queue', ...args]),
    bindQueue: async (...args) => calls.push(['bind', ...args]),
  };

  await assertTopology(channel);
  assert.deepEqual(calls[0], ['exchange', 'ride.events', 'topic', { durable: true }]);
  const queues = calls.filter(call => call[0] === 'queue');

  assert.equal(queues.length, 4 * 5);
  assert.deepEqual(queues.find(call => call[1] === 'payment.events.retry.5s')[2], {
    durable: true,
    arguments: {
      'x-message-ttl': 5000,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': 'payment.events',
    },
  });

  assert.equal(calls.filter(call => call[0] === 'bind').length, 2 + 3 + 1 + 8);
  assert.ok(queues.every(call => call[2].durable === true));
});

test('createRideEvent fills envelope from the catalog', () => {
  const tripId = randomUUID();
  const event = createRideEvent('trip.no_driver', {
    aggregateId: tripId,
    aggregateVersion: 3,
    correlationId: randomUUID(),
    causationId: randomUUID(),
    payload: { tripId, passengerId: randomUUID(), tripVersion: 3, reason: 'SEARCH_TIMEOUT' },
  });

  assert.equal(event.producer, 'trip-booking-service');
  assert.equal(event.schema_version, 1);
  assert.ok(assertRideEvent(event, 'trip.no_driver'));
  assert.throws(
    () =>
      createRideEvent('trip.no_driver', {
        aggregateId: randomUUID(),
        aggregateVersion: 3,
        correlationId: randomUUID(),
        causationId: randomUUID(),
        payload: { tripId, passengerId: randomUUID(), tripVersion: 3, reason: 'SEARCH_TIMEOUT' },
      }),
    /aggregate_id must equal/,
  );
});

test('docs/api/events.schema.json is generated from the contract', () => {
  const file = path.join(root, 'docs/api/events.schema.json');

  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')),
    buildEventsJsonSchema(),
    'run npm run events:schema',
  );
});

test('messaging config requires RABBITMQ_URL and never logs the password', () => {
  assert.throws(() => loadMessagingConfig({}), /RABBITMQ_URL is required/);
  assert.throws(() => loadMessagingConfig({ RABBITMQ_URL: 'http://x' }), /amqp/);
  assert.throws(
    () => loadMessagingConfig({ RABBITMQ_URL: 'amqp://h', RABBITMQ_PREFETCH: '0' }),
    /PREFETCH/,
  );

  assert.equal(loadMessagingConfig({ RABBITMQ_URL: 'amqp://h' }).prefetch, 10);
  assert.equal(
    redactUrl('amqp://ride:s3cret@127.0.0.1:5672/ride'),
    'amqp://ride:***@127.0.0.1:5672/ride',
  );
});

function delivery(content, headers = {}) {
  return {
    content: Buffer.isBuffer(content) ? content : Buffer.from(JSON.stringify(content)),
    fields: { redelivered: false },
    properties: { messageId: content.event_id, headers },
  };
}

function harness({ failPublish = false } = {}) {
  const state = { acks: 0, nacks: [], published: [] };
  const channel = {
    ack: () => state.acks++,
    nack: (_m, all, requeue) => state.nacks.push({ all, requeue }),
  };
  const sender = {
    publishConfirmed: async (exchange, routingKey, content, options) => {
      if (failPublish) {
        throw new Error('broker down');
      }

      state.published.push({ exchange, routingKey, content, headers: options.headers });
    },
  };

  return { state, channel, sender };
}

test('consumer ACKs after the handler succeeds and passes a typed event', async () => {
  const { state, channel, sender } = harness();
  const seen = [];
  const outcome = await handleDelivery(
    channel,
    sender,
    'matching.events',
    {
      'trip.requested': async (event, context) =>
        seen.push([event.payload.tripId, context.attempt]),
    },
    delivery(sample('trip.requested')),
    silent,
  );

  assert.equal(outcome, 'ACKED');
  assert.equal(state.acks, 1);
  assert.deepEqual(seen, [['a1031bdc-44d7-5c67-93ff-7f11b2987aa4', 1]]);
  assert.equal(state.published.length, 0);
});

test('temporary failure goes to the next retry queue with the same body, then ACKs', async () => {
  const event = sample('payment.requested');
  const handlers = {
    'payment.requested': async () => {
      throw new Error('db busy');
    },
  };

  for (const [retries, queue] of [
    [0, 'payment.events.retry.1s'],
    [1, 'payment.events.retry.5s'],
    [2, 'payment.events.retry.15s'],
  ]) {
    const { state, channel, sender } = harness();
    const outcome = await handleDelivery(
      channel,
      sender,
      'payment.events',
      handlers,
      delivery(event, { 'x-retry-count': retries }),
      silent,
    );

    assert.equal(outcome, 'RETRY_SCHEDULED');
    assert.equal(state.acks, 1);
    assert.equal(state.published[0].exchange, '');
    assert.equal(state.published[0].routingKey, queue);
    assert.equal(state.published[0].headers['x-retry-count'], retries + 1);
    assert.equal(JSON.parse(state.published[0].content).event_id, event.event_id);
  }
});

test('after 3 retries the message goes to the DLQ with an error code', async () => {
  const { state, channel, sender } = harness();
  const outcome = await handleDelivery(
    channel,
    sender,
    'trip.events',
    {
      'matching.failed': async () => {
        throw new Error('still failing');
      },
    },
    delivery(sample('matching.failed'), { 'x-retry-count': 3 }),
    silent,
  );

  assert.equal(outcome, 'DEAD_LETTERED');
  assert.equal(state.published[0].routingKey, 'trip.events.dlq');
  assert.equal(state.published[0].headers['x-error-code'], 'RETRIES_EXHAUSTED');
  assert.equal(state.acks, 1);
});

test('invalid body, unknown handler and non-retryable errors go straight to the DLQ', async () => {
  const cases = [
    [Buffer.from('{not json'), {}, 'INVALID_EVENT'],
    [
      { ...sample('trip.started'), producer: 'matching-service' },
      { 'trip.started': async () => {} },
      'INVALID_EVENT',
    ],
    [sample('trip.started'), {}, 'UNHANDLED_EVENT_TYPE'],
    [
      sample('trip.started'),
      {
        'trip.started': async () => {
          throw new NonRetryableEventError('TRIP_MISMATCH', 'unknown trip');
        },
      },
      'TRIP_MISMATCH',
    ],
  ];

  for (const [content, handlers, code] of cases) {
    const { state, channel, sender } = harness();
    const outcome = await handleDelivery(
      channel,
      sender,
      'notification.events',
      handlers,
      delivery(content),
      silent,
    );

    assert.equal(outcome, 'DEAD_LETTERED', code);
    assert.equal(state.published[0].routingKey, 'notification.events.dlq');
    assert.equal(state.published[0].headers['x-error-code'], code);
    assert.equal(state.acks, 1);
  }
});

test('if the retry copy cannot be published the original is not ACKed but requeued', async () => {
  const { state, channel, sender } = harness({ failPublish: true });
  const outcome = await handleDelivery(
    channel,
    sender,
    'payment.events',
    {
      'payment.requested': async () => {
        throw new Error('db busy');
      },
    },
    delivery(sample('payment.requested')),
    silent,
  );

  assert.equal(outcome, 'REQUEUED');
  assert.equal(state.acks, 0);
  assert.deepEqual(state.nacks, [{ all: false, requeue: true }]);
});
