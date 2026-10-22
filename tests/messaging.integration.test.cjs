// Test liên kết của từng queue trên RabbitMQ thật (BA mục 8.1). Cần: npm run mq:up, RABBITMQ_URL trong .env.
// Không kết nối được thì skip. Chạy: npm run test:messaging:integration
require('reflect-metadata');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { connect } = require('amqplib');
const {
  RabbitConnection,
  EventPublisher,
  EventConsumer,
  UnroutableMessageError,
  describeTopology,
  loadMessagingConfig,
} = require('@app/messaging');

const samplesDir = path.resolve(__dirname, '../docs/events/samples');
const sample = type => {
  const file = fs.readdirSync(samplesDir).find(name => name.endsWith('.' + type + '.json'));
  const event = JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8'));

  return { ...event, event_id: randomUUID() };
};

let config;
let admin;
let channel;
const connections = [];

async function open() {
  const connection = new RabbitConnection(config);

  await connection.connectOnce();
  connections.push(connection);

  return connection;
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await sleep(100);
  }

  assert.fail('condition not met within ' + timeoutMs + 'ms');
}

before(async () => {
  try {
    config = loadMessagingConfig(process.env);
    admin = await connect(config.url, { timeout: 10_000 });
    channel = await admin.createChannel();
    await (await open()).close();
  } catch (error) {
    console.log('# RabbitMQ not available, skipping: ' + error.message);
    admin = undefined;

    return;
  }

  for (const queue of describeTopology().queues) {
    for (const name of [
      queue.name,
      ...queue.retryQueues.map(retry => retry.name),
      queue.deadLetterQueue,
    ]) {
      await channel.purgeQueue(name);
    }
  }
});

after(async () => {
  for (const connection of connections) {
    await connection.close();
  }

  await admin?.close().catch(() => undefined);
});

test('each event reaches exactly the queues of its consumers', async t => {
  if (!admin) {
    return t.skip('no broker');
  }

  const publisher = new EventPublisher(await open());
  const topology = describeTopology();

  for (const type of [
    'trip.requested',
    'trip.cancelled',
    'payment.requested',
    'payment.succeeded',
    'matching.failed',
  ]) {
    const event = sample(type);

    await publisher.publish(event);
    for (const queue of topology.queues) {
      const message = await channel.get(queue.name, { noAck: true });

      if (queue.bindings.includes(type)) {
        assert.ok(message, type + ' should reach ' + queue.name);
        assert.equal(JSON.parse(message.content.toString()).event_id, event.event_id);
        assert.equal(message.properties.messageId, event.event_id);
        assert.equal(message.properties.deliveryMode, 2);
      } else {
        assert.equal(message, false, type + ' must not reach ' + queue.name);
      }
    }
  }
});

test('a routing key without a bound queue is returned and not reported as sent', async t => {
  if (!admin) {
    return t.skip('no broker');
  }

  const connection = await open();

  await assert.rejects(
    connection.publishConfirmed('ride.events', 'nobody.listens', Buffer.from('{}')),
    UnroutableMessageError,
  );
});

test('failed handler is retried via payment.events.retry.1s and comes back to the same queue', async t => {
  if (!admin) {
    return t.skip('no broker');
  }

  const connection = await open();
  const consumer = new EventConsumer(connection, config);
  const attempts = [];
  const event = sample('payment.requested');

  await consumer.subscribe('payment.events', {
    'payment.requested': async (received, context) => {
      if (received.event_id !== event.event_id) {
        return;
      }

      attempts.push(context.attempt);
      if (context.attempt === 1) {
        throw new Error('simulated temporary failure');
      }
    },
  });

  await new EventPublisher(connection).publish(event);
  await waitFor(() => attempts.length >= 2, 5_000);
  assert.deepEqual(attempts, [1, 2]);
  // Bên nhận khác (notification) không nhận lại bản retry.
  const { messageCount } = await channel.checkQueue('notification.events');

  assert.equal(messageCount, 0);
});

test(
  'after 3 retries (1s + 5s + 15s) the event lands in trip.events.dlq with an error code',
  { timeout: 40_000 },
  async t => {
    if (!admin) {
      return t.skip('no broker');
    }

    const connection = await open();
    const consumer = new EventConsumer(connection, config);
    const event = sample('matching.failed');

    await consumer.subscribe('trip.events', {
      'matching.failed': async () => {
        throw new Error('always failing');
      },
    });

    await new EventPublisher(connection).publish(event);
    let dead;

    await waitFor(async () => {
      dead = await channel.get('trip.events.dlq', { noAck: true });

      return dead !== false;
    }, 30_000);

    assert.equal(JSON.parse(dead.content.toString()).event_id, event.event_id);
    assert.equal(dead.properties.headers['x-error-code'], 'RETRIES_EXHAUSTED');
    assert.equal(dead.properties.headers['x-retry-count'], 3);
  },
);
