const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { testEvidence } = require('../helpers/test-evidence.cjs');
const {
  account,
  bringOnline,
  call,
  createQuote,
  expectStatus,
  findOffer,
  finishedOperation,
  poll,
  queryDb,
  sendLocation,
  setOnline,
} = require('../helpers/e2e-client.cjs');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const ROUNDS = 3;

test('two trips accepted by one driver at the same moment', { timeout: 420000 }, async t => {
  const evidence = testEvidence('concurrency-driver-double-booking', {
    purpose: 'Một tài xế chỉ được giữ tối đa một reservation và một chuyến đang chạy tại một thời điểm',
    setup: '1 tài xế online ở ZONE_A, 2 khách đặt chuyến thật, stack Compose đầy đủ',
    steps: 'Chờ tài xế có 2 offer OPEN thật từ 2 job, gửi POST /api/v1/trips/{tripId}/accept đồng thời bằng Promise.all, lặp ' + ROUNDS + ' vòng',
    expected: 'Một operation SUCCEEDED, một FAILED_COMPENSATED với DRIVER_UNAVAILABLE; bên thua về NO_DRIVER',
  });

  t.after(() => evidence.write());

  const passengers = [await account('PASSENGER'), await account('PASSENGER')];
  const driver = await account('DRIVER');
  const activeReservations = () =>
    queryDb(
      'driver-db',
      'driver_db',
      `SELECT count(*) FROM driver_schema.reservations WHERE driver_id = '${driver.id}' AND status IN ('HELD', 'CONFIRMED')`,
    );
  const activeTrips = () =>
    queryDb(
      'trip-db',
      'trip_db',
      `SELECT count(*) FROM trip_schema.trips WHERE driver_id = '${driver.id}' AND status IN ('ASSIGNED', 'IN_PROGRESS')`,
    );

  try {
    await bringOnline(driver, POINT);
    evidence.set({ dbBefore: { activeReservations: await activeReservations(), activeTrips: await activeTrips() } });

    for (let round = 1; round <= ROUNDS; round++) {
      await sendLocation(driver, POINT);

      const trips = await Promise.all(
        passengers.map(async passenger => {
          const quote = await createQuote(passenger, POINT);

          return expectStatus(
            call('/trips', {
              method: 'POST',
              token: passenger.token,
              key: randomUUID(),
              body: { quoteId: quote.id },
            }),
            201,
          );
        }),
      );
      const offers = await poll(
        () => Promise.all(trips.map(trip => findOffer(driver, trip.id))),
        items => items.every(Boolean),
        30000,
        'one driver holding two open offers',
      );
      const results = await Promise.all(
        trips.map((trip, index) =>
          call('/trips/' + trip.id + '/accept', {
            method: 'POST',
            token: driver.token,
            key: randomUUID(),
            body: { offerId: offers[index].offer.id },
          }),
        ),
      );

      for (const result of results) {
        assert.equal(result.status, 202, JSON.stringify(result.body));
      }

      const finals = await Promise.all(results.map(result => finishedOperation(driver, result.body.id)));
      const winner = finals.findIndex(item => item.status === 'SUCCEEDED');
      const loser = 1 - winner;

      assert.ok(winner >= 0, 'no winner: ' + JSON.stringify(finals));
      assert.equal(finals[loser].status, 'FAILED_COMPENSATED', JSON.stringify(finals));
      assert.equal(finals[loser].errorCode, 'DRIVER_UNAVAILABLE');
      assert.equal(await activeReservations(), '1');
      assert.equal(await activeTrips(), '1');

      const loserReservation = queryDb(
        'driver-db',
        'driver_db',
        `SELECT status FROM driver_schema.reservations WHERE id = '${results[loser].body.assignmentId}'`,
      );

      assert.equal(loserReservation, 'RELEASED');

      const loserTrip = await poll(
        () => expectStatus(call('/trips/' + trips[loser].id, { token: passengers[loser].token }), 200),
        item => item.status !== 'MATCHING' && item.status !== 'ASSIGNING',
        90000,
        'the losing trip to end',
      );

      assert.equal(loserTrip.status, 'NO_DRIVER');
      evidence.record({
        round,
        winnerTripId: trips[winner].id,
        loserTripId: trips[loser].id,
        winnerOperationId: results[winner].body.id,
        loserOperationId: results[loser].body.id,
        loserErrorCode: finals[loser].errorCode,
        loserReservation,
        activeReservationsDuringRound: 1,
        activeTripsDuringRound: 1,
      });

      const winnerPath = '/trips/' + trips[winner].id;

      await expectStatus(
        call(winnerPath + '/start', { method: 'POST', token: driver.token, key: randomUUID(), body: {} }),
        200,
      );

      const completing = await expectStatus(
        call(winnerPath + '/complete', { method: 'POST', token: driver.token, key: randomUUID(), body: {} }),
        202,
      );

      assert.equal((await finishedOperation(driver, completing.id)).status, 'SUCCEEDED');
      assert.equal(await activeReservations(), '0');
    }

    evidence.set({
      dbAfter: { activeReservations: await activeReservations(), activeTrips: await activeTrips() },
      summary: ROUNDS + ' vòng, mỗi vòng đúng một bên thắng, không double-booking',
    });
  } catch (error) {
    evidence.fail(error);
    throw error;
  } finally {
    await setOnline(driver, false);
  }
});
