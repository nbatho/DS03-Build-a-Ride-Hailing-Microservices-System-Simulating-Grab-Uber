const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const dotenv = require('dotenv');
const { testEvidence } = require('../helpers/test-evidence.cjs');
const {
  ROOT,
  acceptOffer,
  account,
  bringOnline,
  call,
  compose,
  createQuote,
  expectStatus,
  findOffer,
  finishedOperation,
  poll,
  queryDb,
  setOnline,
} = require('../helpers/e2e-client.cjs');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };

// Vhost theo RABBITMQ_VHOST trong .env (giống Compose và script demo), mặc định 'ride'.
function rabbitVhost() {
  try {
    return dotenv.parse(fs.readFileSync(path.join(ROOT, '.env'))).RABBITMQ_VHOST || 'ride';
  } catch {
    return 'ride';
  }
}

function paymentQueueDepth() {
  const output = compose(['exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q', '-p', rabbitVhost(), 'list_queues', 'name', 'messages']);
  const line = output.split('\n').find(item => item.startsWith('payment.events\t'));

  return Number(line?.split('\t')[1]);
}

test('Payment is down when the trip completes', { timeout: 300000 }, async t => {
  const evidence = testEvidence('resilience-payment-service-down', {
    purpose: 'Payment tắt khi chuyến kết thúc thì yêu cầu thanh toán không mất, bật lại xử lý đúng một logical payment',
    setup: 'Chuyến IN_PROGRESS thật, stack Compose đầy đủ, dừng service payment bằng docker compose stop',
    steps: 'Complete khi Payment tắt, kiểm tra tin chờ trong queue, bật Payment, poll kết quả',
    expected: 'Operation SUCCEEDED, COMPLETED/PENDING, 1 tin trong payment.events; sau khi bật lại SUCCEEDED, 1 payment, 1 attempt',
  });
  let paymentStopped = false;

  t.after(() => {
    if (paymentStopped) {
      compose(['start', 'payment']);
    }

    evidence.write();
  });

  const passenger = await account('PASSENGER');
  const driver = await account('DRIVER');

  try {
    await bringOnline(driver, POINT);

    const correlationId = randomUUID();
    const quote = await createQuote(passenger, POINT);
    const trip = await expectStatus(
      call('/trips', {
        method: 'POST',
        token: passenger.token,
        key: randomUUID(),
        correlationId,
        body: { quoteId: quote.id },
      }),
      201,
    );
    const offer = await poll(() => findOffer(driver, trip.id), Boolean, 30000, 'offer');
    const { final } = await acceptOffer(driver, trip.id, offer.offer.id);

    assert.equal(final.status, 'SUCCEEDED', JSON.stringify(final));
    await expectStatus(
      call('/trips/' + trip.id + '/start', { method: 'POST', token: driver.token, key: randomUUID(), body: {} }),
      200,
    );

    compose(['stop', 'payment']);
    paymentStopped = true;

    const depthBefore = paymentQueueDepth();

    evidence.set({ dbBefore: { paymentService: 'stopped', paymentEventsQueue: depthBefore } });

    const completing = await expectStatus(
      call('/trips/' + trip.id + '/complete', {
        method: 'POST',
        token: driver.token,
        key: randomUUID(),
        body: {},
      }),
      202,
    );
    const completion = await finishedOperation(driver, completing.id);

    assert.equal(completion.status, 'SUCCEEDED', JSON.stringify(completion));

    const waiting = await expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200);

    assert.equal(waiting.status, 'COMPLETED');
    assert.equal(waiting.paymentStatus, 'PENDING');

    await poll(() => paymentQueueDepth(), depth => depth === depthBefore + 1, 15000, 'the request to wait in payment.events');
    assert.equal(
      queryDb('payment-db', 'payment_db', `SELECT count(*) FROM payment_schema.payments WHERE trip_id = '${trip.id}'`),
      '0',
    );

    const downResponse = await call('/payments?tripId=' + trip.id, { token: passenger.token });

    assert.notEqual(downResponse.status, 200);

    evidence.record({
      phase: 'payment-down',
      tripId: trip.id,
      paymentId: waiting.paymentId,
      correlationId,
      operationId: completing.id,
      operationStatus: completion.status,
      tripStatus: waiting.status,
      paymentStatus: waiting.paymentStatus,
      queueDepth: depthBefore + 1,
      gatewayStatusWhileDown: downResponse.status,
    });

    compose(['start', 'payment']);
    paymentStopped = false;

    const paid = await poll(
      () => expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200),
      item => ['SUCCEEDED', 'FAILED'].includes(item.paymentStatus),
      120000,
      'the payment after restart',
    );

    assert.equal(paid.paymentStatus, 'SUCCEEDED');
    assert.equal(paid.status, 'COMPLETED');
    assert.equal(paid.paymentId, waiting.paymentId);

    const payments = queryDb(
      'payment-db',
      'payment_db',
      `SELECT count(*) FROM payment_schema.payments WHERE trip_id = '${trip.id}'`,
    );
    const attempts = queryDb(
      'payment-db',
      'payment_db',
      `SELECT count(*) FROM payment_schema.payment_attempts WHERE payment_id = '${paid.paymentId}'`,
    );

    assert.equal(payments, '1');
    assert.equal(attempts, '1');

    const payment = await poll(
      () => call('/payments?tripId=' + trip.id, { token: passenger.token }),
      item => item.status === 200,
      60000,
      'GET /api/v1/payments?tripId= after restart',
    );

    assert.equal(payment.body.status, 'SUCCEEDED');

    evidence.record({ phase: 'payment-restarted', paymentStatus: paid.paymentStatus, payments, attempts });
    evidence.set({
      dbAfter: { payments, attempts, paymentEventsQueue: paymentQueueDepth() },
      summary: 'Yêu cầu chờ trong queue khi Payment tắt, xử lý đúng một lần sau khi bật lại',
    });
  } catch (error) {
    evidence.fail(error);
    throw error;
  } finally {
    await setOnline(driver, false).catch(() => {});
  }
});
