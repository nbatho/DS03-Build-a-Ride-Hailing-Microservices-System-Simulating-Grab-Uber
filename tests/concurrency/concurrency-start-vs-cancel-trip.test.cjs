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
  driverProfile,
  expectStatus,
  findOffer,
  finishedOperation,
  poll,
  queryDb,
  sendLocation,
  setOnline,
} = require('../helpers/e2e-client.cjs');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const ROUNDS = 6;

test('start and cancel race on an assigned trip', { timeout: 420000 }, async t => {
  const evidence = testEvidence('concurrency-start-vs-cancel-trip', {
    purpose: 'Khi start và cancel cùng lúc trên một chuyến, bên commit chuyển trạng thái trước sẽ thắng, chuyến không thể vừa chạy vừa bị hủy',
    setup: 'Chuyến ASSIGNED thật, stack Compose đầy đủ',
    steps: 'Gửi POST /api/v1/trips/{tripId}/start và POST /api/v1/trips/{tripId}/cancel đồng thời bằng Promise.all, lặp ' + ROUNDS + ' vòng',
    expected: 'Start thắng: IN_PROGRESS, CONFIRMED, cancel 409 TRIP_ALREADY_STARTED. Cancel thắng: CANCELLED, RELEASED, start 409 INVALID_STATE',
  });

  t.after(() => evidence.write());

  const passenger = await account('PASSENGER');
  const driver = await account('DRIVER');
  const wins = { start: 0, cancel: 0 };
  const reservation = id =>
    queryDb('driver-db', 'driver_db', `SELECT status FROM driver_schema.reservations WHERE id = '${id}'`);

  try {
    await bringOnline(driver, POINT);

    for (let round = 1; round <= ROUNDS; round++) {
      await sendLocation(driver, POINT);

      const quote = await createQuote(passenger, POINT);
      const trip = await expectStatus(
        call('/trips', {
          method: 'POST',
          token: passenger.token,
          key: randomUUID(),
          body: { quoteId: quote.id },
        }),
        201,
      );
      const offer = await poll(() => findOffer(driver, trip.id), Boolean, 30000, 'offer');
      const { accepted, final } = await acceptOffer(driver, trip.id, offer.offer.id);

      assert.equal(final.status, 'SUCCEEDED', JSON.stringify(final));

      const sendStart = () =>
        call('/trips/' + trip.id + '/start', {
          method: 'POST',
          token: driver.token,
          key: randomUUID(),
          body: {},
        });
      const sendCancel = () =>
        call('/trips/' + trip.id + '/cancel', {
          method: 'POST',
          token: passenger.token,
          key: randomUUID(),
          body: { reason: 'CHANGE_PLAN' },
        });
      // Đảo thứ tự gửi giữa các vòng, nếu không bên gửi trước gần như luôn thắng.
      const [start, cancel] =
        round % 2 === 0
          ? (await Promise.all([sendCancel(), sendStart()])).reverse()
          : await Promise.all([sendStart(), sendCancel()]);
      const startWon = start.status === 200;

      assert.notEqual(startWon, cancel.status === 202, JSON.stringify({ start, cancel }));

      let winner;

      if (startWon) {
        winner = 'start';
        assert.equal(cancel.status, 409);
        assert.equal(cancel.body.code, 'TRIP_ALREADY_STARTED');

        const current = await expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200);

        assert.equal(current.status, 'IN_PROGRESS');
        assert.equal(reservation(accepted.assignmentId), 'CONFIRMED');
      } else {
        winner = 'cancel';
        assert.equal(start.status, 409);
        assert.equal(start.body.code, 'INVALID_STATE');
        assert.equal((await finishedOperation(passenger, cancel.body.id)).status, 'SUCCEEDED');

        const current = await expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200);

        assert.equal(current.status, 'CANCELLED');
        assert.equal(reservation(accepted.assignmentId), 'RELEASED');
        assert.equal((await driverProfile(driver)).status, 'AVAILABLE');
      }

      wins[winner] += 1;
      evidence.record({
        round,
        tripId: trip.id,
        assignmentId: accepted.assignmentId,
        winner,
        startStatus: start.status,
        startCode: start.body.code,
        cancelStatus: cancel.status,
        cancelCode: cancel.body.code,
        reservation: reservation(accepted.assignmentId),
      });

      if (startWon) {
        const completing = await expectStatus(
          call('/trips/' + trip.id + '/complete', {
            method: 'POST',
            token: driver.token,
            key: randomUUID(),
            body: {},
          }),
          202,
        );

        assert.equal((await finishedOperation(driver, completing.id)).status, 'SUCCEEDED');
      }
    }

    evidence.set({
      summary: 'Start thắng ' + wins.start + ' vòng, cancel thắng ' + wins.cancel + ' vòng, không vòng nào cả hai cùng thắng',
      wins,
    });
  } catch (error) {
    evidence.fail(error);
    throw error;
  } finally {
    await setOnline(driver, false);
  }
});
