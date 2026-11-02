const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { testEvidence } = require('../helpers/test-evidence.cjs');
const {
  acceptOffer,
  account,
  bringOnline,
  call,
  createQuote,
  expectStatus,
  findOffer,
  finishedOperation,
  poll,
  queryDb,
  setOnline,
} = require('../helpers/e2e-client.cjs');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };

test('a trip that missed the payment result reads it from Payment', { timeout: 300000 }, async t => {
  const evidence = testEvidence('resilience-payment-result-reconciliation', {
    purpose: 'Chuyến không kẹt ở trạng thái chờ thanh toán khi Payment đã có kết quả cuối, và việc đối soát không tạo thêm lần thu',
    setup: 'Chuyến thanh toán thành công thật, stack Compose đầy đủ. Tạo tình huống mất kết quả bằng cách ghi trực tiếp vào trip-db: đặt lại payment_status = PENDING và lùi updated_at 2 phút',
    steps: 'Chờ Trip tự gọi GET /internal/v1/payments/{paymentId}, poll GET /api/v1/trips/{tripId}, đếm payment và lần thu trong payment-db',
    expected: 'paymentStatus về SUCCEEDED, chuyến vẫn COMPLETED, vẫn 1 payment và 1 lần thu',
  });

  t.after(() => evidence.write());

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

    const completing = await expectStatus(
      call('/trips/' + trip.id + '/complete', { method: 'POST', token: driver.token, key: randomUUID(), body: {} }),
      202,
    );

    assert.equal((await finishedOperation(driver, completing.id)).status, 'SUCCEEDED');

    const readTrip = () => expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200);
    const paid = await poll(readTrip, item => item.paymentStatus === 'SUCCEEDED', 60000, 'the first payment');
    const counts = () => ({
      payments: queryDb('payment-db', 'payment_db', `SELECT count(*) FROM payment_schema.payments WHERE trip_id = '${trip.id}'`),
      attempts: queryDb('payment-db', 'payment_db', `SELECT count(*) FROM payment_schema.payment_attempts WHERE payment_id = '${paid.paymentId}'`),
    });

    queryDb(
      'trip-db',
      'trip_db',
      `UPDATE trip_schema.trips SET payment_status = 'PENDING', updated_at = now() - interval '2 minutes' WHERE id = '${trip.id}'`,
    );

    const before = await readTrip();

    assert.equal(before.paymentStatus, 'PENDING');
    evidence.set({ dbBefore: { tripPaymentStatus: before.paymentStatus, ...counts() } });

    const started = Date.now();
    const settled = await poll(readTrip, item => item.paymentStatus !== 'PENDING', 90000, 'reconciliation');
    const after = counts();

    assert.equal(settled.paymentStatus, 'SUCCEEDED');
    assert.equal(settled.status, 'COMPLETED');
    assert.equal(after.payments, '1');
    assert.equal(after.attempts, '1');

    evidence.record({
      tripId: trip.id,
      paymentId: paid.paymentId,
      correlationId,
      paymentStatus: settled.paymentStatus,
      tripStatus: settled.status,
      reconciledAfterMs: Date.now() - started,
    });
    evidence.set({
      dbAfter: { tripPaymentStatus: settled.paymentStatus, ...after },
      summary: 'Trip tự đọc kết quả từ Payment thật, không tạo thêm payment hay lần thu',
    });
  } catch (error) {
    evidence.fail(error);
    throw error;
  } finally {
    await setOnline(driver, false).catch(() => {});
  }
});
