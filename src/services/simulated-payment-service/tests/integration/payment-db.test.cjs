// Payment trên payment_db thật (cần: npm run c:db:up && npm run migration:payment:run). Không có DB thì skip.
// Chạy: npm run test:payment:integration
require('reflect-metadata');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../../../../../.env'), quiet: true });
const { DataSource } = require('typeorm');
const { databaseOptions } = require('../../src/database/options');
const entities = require('../../src/payments/entities');
const { PaymentsService } = require('../../src/payments/payments.service');

let dataSource;

function service(mode) {
  return new PaymentsService(dataSource, { mode, failureRate: 0 });
}

function requested({ attemptNo = 1, amount = '41000', ids = {} } = {}) {
  const paymentId = ids.paymentId ?? randomUUID();
  const tripId = ids.tripId ?? randomUUID();

  return {
    event_id: randomUUID(),
    type: 'payment.requested',
    schema_version: 1,
    aggregate_id: tripId,
    aggregate_version: 5,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    producer: 'trip-booking-service',
    payload: {
      paymentId,
      tripId,
      passengerId: ids.passengerId ?? randomUUID(),
      amount,
      currency: 'VND',
      attemptNo,
    },
  };
}

async function outbox(paymentId) {
  return dataSource.query(
    'SELECT type, status, envelope_json FROM payment_schema.outbox_events WHERE aggregate_id = $1 ORDER BY created_at',
    [paymentId],
  );
}

before(async () => {
  try {
    const { Payment, PaymentAttempt, ProcessedEvent, OutboxEvent } = entities;

    dataSource = new DataSource({
      ...databaseOptions(process.env),
      entities: [Payment, PaymentAttempt, ProcessedEvent, OutboxEvent],
    });
    await dataSource.initialize();
    await dataSource.query('SELECT 1 FROM payment_schema.payments LIMIT 0');
  } catch (error) {
    console.log('# payment_db not available, skipping: ' + error.message);
    dataSource = undefined;
  }
});

after(async () => {
  await dataSource?.destroy();
});

test('same event delivered twice charges once and writes one outbox event', async t => {
  if (!dataSource) {
    return t.skip('no database');
  }

  const event = requested();
  const payments = service('SUCCEED');

  assert.equal(await payments.handlePaymentRequested(event), 'SUCCEEDED');
  assert.equal(await payments.handlePaymentRequested(event), 'DUPLICATE_EVENT');
  // Cùng lần thử nhưng event_id mới (Trip gửi lại) cũng không thu lần hai.
  assert.equal(await payments.handlePaymentRequested({ ...event, event_id: randomUUID() }), 'ALREADY_SUCCEEDED');

  const rows = await outbox(event.payload.paymentId);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'payment.succeeded');
  assert.equal(rows[0].envelope_json.payload.paymentVersion, 2);
  assert.equal(rows[0].envelope_json.causation_id, event.event_id);

  const attempts = await dataSource.query(
    'SELECT count(*)::int AS n FROM payment_schema.payment_attempts WHERE payment_id = $1',
    [event.payload.paymentId],
  );

  assert.equal(attempts[0].n, 1);
});

test('temporary failure then retry with the same paymentId succeeds; old failure does not overwrite', async t => {
  if (!dataSource) {
    return t.skip('no database');
  }

  const payments = service('FAIL_ONCE');
  const first = requested();
  const ids = { ...first.payload };

  assert.equal(await payments.handlePaymentRequested(first), 'FAILED');
  assert.equal(await payments.handlePaymentRequested(requested({ attemptNo: 2, ids })), 'SUCCEEDED');
  // Lần thử 1 gửi lại muộn: không làm lùi trạng thái.
  assert.equal(await payments.handlePaymentRequested(requested({ attemptNo: 1, ids })), 'ALREADY_SUCCEEDED');

  const dto = await payments.getForTrip(ids.paymentId);

  assert.equal(dto.status, 'SUCCEEDED');
  assert.equal(dto.attemptNo, 2);
  assert.deepEqual((await outbox(ids.paymentId)).map(row => row.type), ['payment.failed', 'payment.succeeded']);
});

test('amount mismatch for an existing payment is rejected as non-retryable', async t => {
  if (!dataSource) {
    return t.skip('no database');
  }

  const payments = service('TEMPORARY');
  const first = requested();

  await payments.handlePaymentRequested(first);
  await assert.rejects(
    payments.handlePaymentRequested(requested({ attemptNo: 2, amount: '99000', ids: first.payload })),
    error => error.code === 'PAYMENT_MISMATCH',
  );
});

test('only the owning passenger can read the payment', async t => {
  if (!dataSource) {
    return t.skip('no database');
  }

  const payments = service('SUCCEED');
  const event = requested();

  await payments.handlePaymentRequested(event);
  assert.equal((await payments.getByTripForPassenger(event.payload.passengerId, event.payload.tripId)).id, event.payload.paymentId);
  await assert.rejects(payments.getForPassenger(randomUUID(), event.payload.paymentId), error => error.getStatus() === 403);
  await assert.rejects(payments.getForPassenger(event.payload.passengerId, randomUUID()), error => error.getStatus() === 404);
});
