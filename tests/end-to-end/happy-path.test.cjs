const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  GATEWAY,
  ROOT,
  account,
  bringOnline,
  call,
  createQuote,
  driverProfile,
  expectStatus,
  findNotification,
  findOffer,
  finishedOperation,
  poll,
  queryDb,
  sendLocation,
  setOnline,
} = require('../helpers/e2e-client.cjs');

const POINT_A = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const POINT_B = { lat: 10.8, lng: 106.72, zoneId: 'ZONE_B' };

function simulationMode() {
  const file = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');

  return /^PAYMENT_SIMULATION_MODE=(.*)$/m.exec(file)?.[1].trim() || 'SUCCEED';
}

function writeEvidence(outcomes) {
  const directory = path.join(ROOT, 'docs/test-evidence/e2e');
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'happy-path.json'),
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        status: outcomes.length === 3 && outcomes.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL',
        commit: commit.stdout.trim() || 'unknown',
        gateway: GATEWAY,
        outcomes,
        tokens: '[REDACTED]',
      },
      null,
      2,
    ) + '\n',
  );
}

const bookTrip = async (passenger, point, correlationId) => {
  const quote = await createQuote(passenger, point);

  return {
    quote,
    trip: await expectStatus(
      call('/trips', {
        method: 'POST',
        token: passenger.token,
        key: randomUUID(),
        correlationId,
        body: { quoteId: quote.id },
      }),
      201,
    ),
  };
};

async function driveToCompletion(driver, tripId, offerId) {
  const accepted = await expectStatus(
    call('/trips/' + tripId + '/accept', {
      method: 'POST',
      token: driver.token,
      key: randomUUID(),
      body: { offerId },
    }),
    202,
  );

  assert.equal(accepted.status, 'PENDING');
  assert.equal(accepted.tripStatus, 'ASSIGNING');

  const acceptance = await finishedOperation(driver, accepted.id);

  assert.equal(acceptance.status, 'SUCCEEDED', JSON.stringify(acceptance));
  assert.equal(acceptance.tripStatus, 'ASSIGNED');

  const assigned = await expectStatus(call('/trips/' + tripId, { token: driver.token }), 200);

  assert.equal(assigned.status, 'ASSIGNED');
  assert.equal(assigned.driverId, driver.id);
  assert.equal(assigned.assignmentId, accepted.assignmentId);
  assert.equal((await driverProfile(driver)).status, 'BUSY');

  const started = await expectStatus(
    call('/trips/' + tripId + '/start', {
      method: 'POST',
      token: driver.token,
      key: randomUUID(),
      body: {},
    }),
    200,
  );

  assert.equal(started.status, 'IN_PROGRESS');

  const completing = await expectStatus(
    call('/trips/' + tripId + '/complete', {
      method: 'POST',
      token: driver.token,
      key: randomUUID(),
      body: {},
    }),
    202,
  );

  assert.equal(completing.tripStatus, 'COMPLETED');

  const completion = await finishedOperation(driver, completing.id);

  assert.equal(completion.status, 'SUCCEEDED', JSON.stringify(completion));

  return { assignmentId: accepted.assignmentId, acceptId: accepted.id, completeId: completing.id };
}

const paidTrip = (passenger, tripId) =>
  poll(
    () => expectStatus(call('/trips/' + tripId, { token: passenger.token }), 200),
    item => ['SUCCEEDED', 'FAILED'].includes(item.paymentStatus),
    60000,
    'payment of trip ' + tripId,
  );

test('G2: the main flow works end to end through the Gateway', { timeout: 300000 }, async t => {
  const outcomes = [];

  t.after(() => writeEvidence(outcomes));

  async function scenario(name, work) {
    await t.test(name, async () => {
      const started = Date.now();

      try {
        outcomes.push({ name, status: 'PASS', ...(await work()), durationMs: Date.now() - started });
      } catch (error) {
        outcomes.push({ name, status: 'FAIL', error: error.message, durationMs: Date.now() - started });
        throw error;
      }
    });
  }

  const mode = simulationMode();

  assert.equal(mode, 'SUCCEED', 'E2E needs PAYMENT_SIMULATION_MODE=SUCCEED in .env, found ' + mode);

  const passenger = await account('PASSENGER');
  const first = await account('DRIVER');
  const second = await account('DRIVER');

  assert.equal(passenger.role, 'PASSENGER');
  assert.equal(first.role, 'DRIVER');

  try {
    await scenario('E2E-1: a full trip from quote to paid', async () => {
      await bringOnline(first, POINT_A);
      assert.equal((await driverProfile(first)).status, 'AVAILABLE');

      const quote = await createQuote(passenger, POINT_A);

      assert.equal(quote.amount, '41000');

      const correlationId = randomUUID();
      const key = randomUUID();
      const request = {
        method: 'POST',
        token: passenger.token,
        key,
        correlationId,
        body: { quoteId: quote.id },
      };
      const trip = await expectStatus(call('/trips', request), 201);

      assert.equal(trip.status, 'MATCHING');
      assert.equal(trip.paymentStatus, 'NOT_REQUESTED');
      assert.equal(trip.amount, '41000');
      assert.deepEqual(await expectStatus(call('/trips', request), 201), trip);

      const offer = await poll(() => findOffer(first, trip.id), Boolean, 30000, 'offer');

      assert.equal(offer.offer.driverId, first.id);
      assert.equal(offer.amount, '41000');

      const ids = await driveToCompletion(first, trip.id, offer.offer.id);

      assert.equal((await driverProfile(first)).status, 'AVAILABLE');

      const paid = await paidTrip(passenger, trip.id);

      assert.equal(paid.status, 'COMPLETED');
      assert.equal(paid.paymentStatus, 'SUCCEEDED');

      const payment = await expectStatus(call('/payments?tripId=' + trip.id, { token: passenger.token }), 200);

      assert.equal(payment.id, paid.paymentId);
      assert.equal(payment.status, 'SUCCEEDED');
      assert.equal(payment.amount, '41000');
      assert.equal(payment.attemptNo, 1);

      await poll(
        async () =>
          (await findNotification(passenger, item => item.tripId === trip.id && item.tripStatus === 'COMPLETED')) &&
          findNotification(passenger, item => item.tripId === trip.id && item.paymentStatus === 'SUCCEEDED'),
        Boolean,
        30000,
        'trip and payment notifications',
      );

      assert.equal(
        queryDb('matching-db', 'matching_db', `SELECT status FROM matching_schema.matching_jobs WHERE trip_id = '${trip.id}'`),
        'MATCHED',
      );
      assert.equal(
        queryDb('driver-db', 'driver_db', `SELECT status FROM driver_schema.reservations WHERE id = '${ids.assignmentId}'`),
        'RELEASED',
      );
      assert.equal(
        queryDb(
          'trip-db',
          'trip_db',
          `SELECT string_agg(to_status, ',' ORDER BY occurred_at) FROM trip_schema.state_history WHERE trip_id = '${trip.id}'`,
        ),
        'MATCHING,ASSIGNING,ASSIGNED,IN_PROGRESS,COMPLETED',
      );
      assert.equal(
        queryDb('payment-db', 'payment_db', `SELECT count(*) FROM payment_schema.payments WHERE trip_id = '${trip.id}'`),
        '1',
      );
      assert.equal(
        queryDb('payment-db', 'payment_db', `SELECT count(*) FROM payment_schema.payment_attempts WHERE payment_id = '${paid.paymentId}'`),
        '1',
      );

      return {
        tripId: trip.id,
        operationId: ids.completeId,
        paymentId: paid.paymentId,
        correlationId,
      };
    });

    await scenario('E2E-2: the first driver rejects, the next one completes the trip', async () => {
      await sendLocation(first, POINT_A);
      await bringOnline(second, POINT_A);

      const correlationId = randomUUID();
      const { trip } = await bookTrip(passenger, POINT_A, correlationId);
      const drivers = [first, second];
      const offered = await poll(
        async () => {
          const offers = await Promise.all(drivers.map(item => findOffer(item, trip.id)));
          const index = offers.findIndex(Boolean);

          return index >= 0 ? { driver: drivers[index], other: drivers[1 - index], item: offers[index] } : null;
        },
        Boolean,
        30000,
        'first offer',
      );
      const rejection = await expectStatus(
        call('/trips/' + trip.id + '/reject', {
          method: 'POST',
          token: offered.driver.token,
          key: randomUUID(),
          body: { offerId: offered.item.offer.id, reason: 'NOT_INTERESTED' },
        }),
        202,
      );

      assert.equal((await finishedOperation(offered.driver, rejection.id)).status, 'SUCCEEDED');
      assert.equal(
        (await expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200)).status,
        'MATCHING',
      );

      const next = await poll(() => findOffer(offered.other, trip.id), Boolean, 30000, 'second offer');
      const ids = await driveToCompletion(offered.other, trip.id, next.offer.id);
      const paid = await paidTrip(passenger, trip.id);

      assert.equal(paid.paymentStatus, 'SUCCEEDED');
      assert.equal(paid.driverId, offered.other.id);

      const driverHistory = await expectStatus(call('/trips', { token: offered.other.token }), 200);

      assert.ok(driverHistory.items.some(item => item.id === trip.id));
      assert.equal((await call('/trips/' + trip.id, { token: offered.driver.token })).status, 403);

      return {
        tripId: trip.id,
        operationId: ids.completeId,
        paymentId: paid.paymentId,
        correlationId,
      };
    });

    await scenario('E2E-3: without a driver the trip ends in NO_DRIVER and nothing is charged', async () => {
      const correlationId = randomUUID();
      const { trip } = await bookTrip(passenger, POINT_B, correlationId);
      const finished = await poll(
        () => expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200),
        item => item.status !== 'MATCHING',
        90000,
        'NO_DRIVER',
      );

      assert.equal(finished.status, 'NO_DRIVER');
      assert.equal(finished.paymentStatus, 'NOT_REQUESTED');
      assert.equal(
        (await poll(
          () => findNotification(passenger, item => item.tripId === trip.id && item.tripStatus === 'NO_DRIVER'),
          Boolean,
          30000,
          'NO_DRIVER notification',
        )).type,
        'TRIP_STATUS',
      );

      const payment = await call('/payments?tripId=' + trip.id, { token: passenger.token });

      assert.equal(payment.status, 404);
      assert.equal(payment.body.code, 'PAYMENT_NOT_FOUND');

      const internal = await fetch(GATEWAY + '/internal/v1/trips/' + trip.id, {
        signal: AbortSignal.timeout(15000),
      });

      assert.notEqual(internal.status, 200);

      return { tripId: trip.id, correlationId };
    });
  } finally {
    for (const driver of [first, second]) {
      if (driver.sequence > 0) {
        await setOnline(driver, false);
      }
    }
  }
});
