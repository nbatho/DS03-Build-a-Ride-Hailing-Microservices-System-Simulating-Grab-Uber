const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '../..');
const GATEWAY = process.env.E2E_GATEWAY_URL ?? 'http://127.0.0.1:8080';
const API = GATEWAY + '/api/v1';
const POINT_A = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const POINT_B = { lat: 10.8, lng: 106.72, zoneId: 'ZONE_B' };

async function call(route, { method = 'GET', body, token, key } = {}) {
  const response = await fetch(API + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function expectStatus(promise, status) {
  const result = await promise;

  assert.equal(result.status, status, JSON.stringify(result.body));

  return result.body;
}

async function poll(read, done, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    last = await read();

    if (done(last)) {
      return last;
    }

    await sleep(1000);
  }

  throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(last));
}

async function account(role) {
  const email = role.toLowerCase() + '-' + randomUUID() + '@e2e.test';
  const password = 'E2e-' + randomUUID();
  const user = await expectStatus(
    call('/auth/register', {
      method: 'POST',
      body: { email, password, displayName: 'E2E', role },
    }),
    201,
  );
  const login = await expectStatus(
    call('/auth/login', { method: 'POST', body: { email, password } }),
    200,
  );

  return { id: user.id, token: login.accessToken };
}

async function bringOnline(driver, position) {
  await expectStatus(
    call('/drivers/me', {
      method: 'PUT',
      token: driver.token,
      body: { licenseNumber: 'E2E-' + driver.id.slice(0, 8) },
    }),
    200,
  );
  await expectStatus(
    call('/vehicles', {
      method: 'POST',
      token: driver.token,
      key: randomUUID(),
      body: { plateNumber: 'E2E' + driver.id.slice(0, 8), model: 'Vios', color: 'White' },
    }),
    201,
  );
  await expectStatus(
    call('/drivers/me/location', {
      method: 'PUT',
      token: driver.token,
      body: { position, sequence: 1, recordedAt: new Date().toISOString() },
    }),
    200,
  );

  const profile = await expectStatus(call('/drivers/me', { token: driver.token }), 200);

  await expectStatus(
    call('/drivers/me/status', {
      method: 'PATCH',
      token: driver.token,
      key: randomUUID(),
      body: { online: true, expectedVersion: profile.version },
    }),
    200,
  );
}

async function goOffline(driver) {
  const profile = await expectStatus(call('/drivers/me', { token: driver.token }), 200);

  await expectStatus(
    call('/drivers/me/status', {
      method: 'PATCH',
      token: driver.token,
      key: randomUUID(),
      body: { online: false, expectedVersion: profile.version },
    }),
    200,
  );
}

const estimate = point => ({
  pickup: point,
  dropoff: point,
  distanceMeters: 3000,
  durationSeconds: 600,
});

const createQuote = (passenger, point) =>
  expectStatus(
    call('/quotes', {
      method: 'POST',
      token: passenger.token,
      key: randomUUID(),
      body: estimate(point),
    }),
    201,
  );

function queryDb(service, database, sql) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env',
      '-f',
      'deploy/docker-compose.yml',
      'exec',
      '-T',
      service,
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-tAc',
      sql,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
  );

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

const findOffer = async (driver, tripId) => {
  const page = await expectStatus(call('/notifications', { token: driver.token }), 200);

  return page.items.find(item => item.type === 'OFFER' && item.tripId === tripId && item.actionable);
};

const finishedOperation = (driver, operationId) =>
  poll(
    () => expectStatus(call('/operations/' + operationId, { token: driver.token }), 200),
    item => !['PENDING', 'RUNNING'].includes(item.status),
    60000,
    'operation ' + operationId,
  );

test('Trip, Matching and Notification work together through the Gateway', { timeout: 300000 }, async t => {
  const passenger = await account('PASSENGER');
  const driver = await account('DRIVER');

  await t.test('a booked trip reaches the online driver as an offer', async () => {
    await bringOnline(driver, POINT_A);

    try {
      const quote = await createQuote(passenger, POINT_A);

      assert.equal(quote.amount, '41000');

      const key = randomUUID();
      const request = {
        method: 'POST',
        token: passenger.token,
        key,
        body: { quoteId: quote.id },
      };
      const trip = await expectStatus(call('/trips', request), 201);

      assert.equal(trip.status, 'MATCHING');
      assert.equal(trip.paymentStatus, 'NOT_REQUESTED');
      assert.equal(trip.amount, '41000');
      assert.deepEqual(await expectStatus(call('/trips', request), 201), trip);

      const offer = await poll(
        async () => {
          const page = await expectStatus(call('/notifications', { token: driver.token }), 200);

          return page.items.find(item => item.type === 'OFFER' && item.tripId === trip.id);
        },
        Boolean,
        30000,
        'offer',
      );

      assert.equal(offer.offer.driverId, driver.id);
      assert.equal(offer.actionable, true);
      assert.equal(offer.amount, '41000');

      const read = await expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200);

      assert.equal(read.status, 'MATCHING');
      assert.equal(read.id, trip.id);
      assert.equal((await call('/trips/' + trip.id, { token: driver.token })).status, 403);
    } finally {
      await goOffline(driver);
    }
  });

  await t.test('a trip without drivers ends in NO_DRIVER and the passenger is told', async () => {
    const quote = await createQuote(passenger, POINT_B);
    const trip = await expectStatus(
      call('/trips', {
        method: 'POST',
        token: passenger.token,
        key: randomUUID(),
        body: { quoteId: quote.id },
      }),
      201,
    );

    const finished = await poll(
      () => expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200),
      item => item.status !== 'MATCHING',
      90000,
      'NO_DRIVER',
    );

    assert.equal(finished.status, 'NO_DRIVER');
    assert.equal(finished.version, 2);
    assert.equal(finished.paymentStatus, 'NOT_REQUESTED');

    const notice = await poll(
      async () => {
        const page = await expectStatus(call('/notifications', { token: passenger.token }), 200);

        return page.items.find(item => item.tripId === trip.id && item.tripStatus === 'NO_DRIVER');
      },
      Boolean,
      30000,
      'NO_DRIVER notification',
    );

    assert.equal(notice.type, 'TRIP_STATUS');

    const history = await expectStatus(call('/trips?limit=100', { token: passenger.token }), 200);

    assert.ok(history.items.some(item => item.id === trip.id));

    const internal = await fetch(GATEWAY + '/internal/v1/trips/' + trip.id, {
      signal: AbortSignal.timeout(15000),
    });

    assert.notEqual(internal.status, 200);
    assert.equal(
      (await call('/operations/' + randomUUID(), { token: passenger.token })).status,
      404,
    );
  });

  await t.test('one driver rejects, the next accepts and is assigned', async () => {
    const drivers = [await account('DRIVER'), await account('DRIVER')];

    for (const item of drivers) {
      await bringOnline(item, POINT_A);
    }

    const quote = await createQuote(passenger, POINT_A);
    const trip = await expectStatus(
      call('/trips', {
        method: 'POST',
        token: passenger.token,
        key: randomUUID(),
        body: { quoteId: quote.id },
      }),
      201,
    );
    const firstOffer = await poll(
      async () => {
        const offers = await Promise.all(drivers.map(item => findOffer(item, trip.id)));
        const index = offers.findIndex(Boolean);

        return index >= 0 ? { driver: drivers[index], other: drivers[1 - index], offer: offers[index] } : null;
      },
      Boolean,
      30000,
      'first offer',
    );

    const rejection = await expectStatus(
      call('/trips/' + trip.id + '/reject', {
        method: 'POST',
        token: firstOffer.driver.token,
        key: randomUUID(),
        body: { offerId: firstOffer.offer.offer.id, reason: 'NOT_INTERESTED' },
      }),
      202,
    );

    assert.equal((await finishedOperation(firstOffer.driver, rejection.id)).status, 'SUCCEEDED');
    assert.equal(
      (await expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200)).status,
      'MATCHING',
    );

    const secondOffer = await poll(() => findOffer(firstOffer.other, trip.id), Boolean, 30000, 'second offer');
    const operation = await expectStatus(
      call('/trips/' + trip.id + '/accept', {
        method: 'POST',
        token: firstOffer.other.token,
        key: randomUUID(),
        body: { offerId: secondOffer.offer.id },
      }),
      202,
    );

    assert.equal(operation.status, 'PENDING');
    assert.equal(operation.tripStatus, 'ASSIGNING');

    const final = await finishedOperation(firstOffer.other, operation.id);

    assert.equal(final.status, 'SUCCEEDED', JSON.stringify(final));
    assert.equal(final.tripStatus, 'ASSIGNED');

    const assigned = await expectStatus(call('/trips/' + trip.id, { token: passenger.token }), 200);

    assert.equal(assigned.status, 'ASSIGNED');
    assert.equal(assigned.driverId, firstOffer.other.id);
    assert.equal(assigned.assignmentId, operation.assignmentId);

    const profile = await expectStatus(call('/drivers/me', { token: firstOffer.other.token }), 200);

    assert.equal(profile.status, 'BUSY');

    const driverHistory = await expectStatus(call('/trips', { token: firstOffer.other.token }), 200);

    assert.ok(driverHistory.items.some(item => item.id === trip.id));

    await poll(
      async () => {
        const page = await expectStatus(call('/notifications', { token: passenger.token }), 200);

        return page.items.find(item => item.tripId === trip.id && item.tripStatus === 'ASSIGNED');
      },
      Boolean,
      30000,
      'ASSIGNED notification',
    );

    assert.equal(
      queryDb('matching-db', 'matching_db', `SELECT status FROM matching_schema.matching_jobs WHERE trip_id = '${trip.id}'`),
      'MATCHED',
    );
    assert.equal(
      queryDb('driver-db', 'driver_db', `SELECT status FROM driver_schema.reservations WHERE id = '${operation.assignmentId}'`),
      'CONFIRMED',
    );
    assert.equal(
      queryDb(
        'trip-db',
        'trip_db',
        `SELECT string_agg(to_status, ',' ORDER BY occurred_at) FROM trip_schema.state_history WHERE trip_id = '${trip.id}'`,
      ),
      'MATCHING,ASSIGNING,ASSIGNED',
    );

    await goOffline(firstOffer.driver);
  });
});
