const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const http = require('node:http');
const { test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { testEvidence } = require('../helpers/test-evidence.cjs');
const { createDriverDatabase } = require('../helpers/driver-environment.cjs');
const { createEnvironment, eventually } = require('../helpers/identity-environment.cjs');
const { createMatchingBroker } = require('../helpers/matching-environment.cjs');
const { createTripDatabase } = require('../helpers/trip-environment.cjs');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const TERMINAL = ['SUCCEEDED', 'FAILED_COMPENSATED', 'FAILED_NEEDS_REVIEW'];
const serviceToken = () => randomBytes(32).toString('base64url');

async function request(origin, route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(origin + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

test('Driver commits but the reply is lost, or stops in the middle of the saga', { timeout: 540000 }, async t => {
  const evidence = testEvidence('resilience-accept-saga-lost-reply-and-crash', {
    purpose: 'Mất phản hồi sau khi đã commit hoặc restart giữa Saga không tạo double reservation hay tài xế mồ côi',
    setup: 'Driver, Identity, Trip, PostgreSQL, RabbitMQ thật; Matching giả; Trip gọi Driver qua proxy trong test để ép lỗi sau khi Driver đã commit',
    steps: 'Năm case: mất reply PUT /internal/v1/reservations/{reservationId}, mất reply POST /internal/v1/reservations/{reservationId}/confirm, kill Trip sau confirm, kill Driver giữa Saga rồi POST /internal/v1/operations/{operationId}/retry, lệnh reserve đến muộn sau tombstone',
    expected: 'Không gửi lại thừa sau khi GET /internal/v1/reservations/{reservationId} xác nhận; 1 reservation mỗi assignment; cleanup xong tài xế AVAILABLE; tombstone chặn lệnh muộn',
  });
  let proxyServer, matchingServer;

  t.after(async () => {
    evidence.write();
    proxyServer?.closeAllConnections();
    matchingServer?.closeAllConnections();
    await Promise.all(
      [proxyServer, matchingServer].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))),
    );
  });

  const fixture = await createEnvironment(t);
  const driverDb = await createDriverDatabase(t);
  const tripDb = await createTripDatabase(t);
  const broker = await createMatchingBroker(t);
  const tokens = {
    tripDriver: serviceToken(),
    tripMatching: serviceToken(),
    tripPricing: serviceToken(),
    ops: serviceToken(),
  };
  const identity = await fixture.launch('identity-user-service', 'IDENTITY_PORT');
  const driverEnv = { ...driverDb.env, SVC_TOKEN_TRIP_DRIVER: tokens.tripDriver };
  let driverApp = await fixture.launch('driver-vehicle-location-service', 'DRIVER_PORT', driverEnv);

  // Proxy giữa Trip và Driver thật: mỗi kế hoạch ép lỗi áp dụng cho một số lượt khớp `name`.
  const proxyLog = [];
  const plans = [];
  const held = [];

  async function forward(req, raw) {
    const headers = { 'Content-Type': 'application/json' };

    for (const name of ['x-service-token', 'x-correlation-id']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }

    return fetch(driverApp.url + req.url, {
      method: req.method,
      headers,
      ...(raw ? { body: raw } : {}),
      signal: AbortSignal.timeout(5000),
    });
  }

  function operationName(req) {
    const action = req.url.split('/')[5];

    return action ?? (req.method === 'GET' ? 'lookup' : 'reserve');
  }

  proxyServer = http.createServer(async (req, res) => {
    let raw = '';

    for await (const chunk of req) raw += chunk;

    const name = operationName(req);
    const reservationId = req.url.split('/')[4];

    proxyLog.push({ name, reservationId });

    const tripId = raw ? JSON.parse(raw).tripId : undefined;
    const plan = plans.find(item => item.name === name && item.tripId === tripId && item.remaining > 0);

    if (plan) {
      plan.remaining -= 1;

      if (plan.action === 'hold') {
        held.push({ req: { method: req.method, url: req.url, headers: req.headers }, raw });
        res.socket.destroy();

        return;
      }

      if (plan.action === 'killDriverBefore') {
        await plan.effect();
      } else {
        const upstream = await forward(req, raw);

        await upstream.text();
        await plan.effect?.();
        res.socket.destroy();

        return;
      }
    }

    try {
      const upstream = await forward(req, raw);

      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(await upstream.text());
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'DEPENDENCY_UNAVAILABLE' }));
    }
  });
  proxyServer.listen(0, '127.0.0.1');
  await once(proxyServer, 'listening');

  const offers = new Map();

  matchingServer = http.createServer(async (req, res) => {
    let raw = '';

    for await (const chunk of req) raw += chunk;

    const send = (status, body) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const parts = req.url.split('/').filter(Boolean);

    if (req.url.startsWith('/internal/v1/matching/jobs/')) {
      send(200, { id: randomUUID(), tripId: parts[4], status: 'SEARCHING', version: 2 });

      return;
    }

    const offer = offers.get(parts[3]);

    if (!offer) {
      send(404, { code: 'OFFER_NOT_FOUND' });
    } else if (req.method === 'GET') {
      send(200, offer);
    } else {
      send(200, { ...offer, status: parts[4] === 'decisions' ? 'CLAIMED' : 'ACCEPTED', assignmentId: JSON.parse(raw).assignmentId });
    }
  });
  matchingServer.listen(0, '127.0.0.1');
  await once(matchingServer, 'listening');

  const launchTrip = () =>
    fixture.launch('trip-booking-service', 'TRIP_PORT', {
      ...tripDb.env,
      ...broker.env,
      DRIVER_BASE_URL: 'http://127.0.0.1:' + proxyServer.address().port,
      MATCHING_BASE_URL: 'http://127.0.0.1:' + matchingServer.address().port,
      SVC_TOKEN_TRIP_DRIVER: tokens.tripDriver,
      SVC_TOKEN_TRIP_MATCHING: tokens.tripMatching,
      SVC_TOKEN_TRIP_PRICING: tokens.tripPricing,
      SVC_TOKEN_OPS_TRIP: tokens.ops,
    });
  let tripApp = await launchTrip();

  async function onlineDriver() {
    const credentials = { email: 'saga-' + randomUUID() + '@example.test', password: 'TestPass!2026' };
    const registered = await request(identity.url, '/api/v1/auth/register', {
      method: 'POST',
      body: { ...credentials, displayName: 'Saga Driver', role: 'DRIVER' },
    });

    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const login = await request(identity.url, '/api/v1/auth/login', { method: 'POST', body: credentials });
    const driver = { id: registered.body.id, token: login.body.accessToken, sequence: 0 };

    await driverCall(driver, '/api/v1/drivers/me', 'PUT', { licenseNumber: 'LIC-' + driver.id.slice(0, 8) }, 200);
    await driverCall(
      driver,
      '/api/v1/vehicles',
      'POST',
      { plateNumber: 'R' + driver.id.slice(0, 8), model: 'Vios', color: 'White' },
      201,
      randomUUID(),
    );
    await sendGps(driver);

    const profile = await driverCall(driver, '/api/v1/drivers/me', 'GET', undefined, 200);

    await driverCall(
      driver,
      '/api/v1/drivers/me/status',
      'PATCH',
      { online: true, expectedVersion: profile.version },
      200,
      randomUUID(),
    );

    return driver;
  }

  async function driverCall(driver, route, method, body, status, key) {
    const result = await request(driverApp.url, route, {
      method,
      body,
      headers: {
        Authorization: 'Bearer ' + driver.token,
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
    });

    assert.equal(result.status, status, route + ' ' + JSON.stringify(result.body));

    return result.body;
  }

  function sendGps(driver) {
    driver.sequence += 1;

    return driverCall(
      driver,
      '/api/v1/drivers/me/location',
      'PUT',
      { position: POINT, sequence: driver.sequence, recordedAt: new Date().toISOString() },
      200,
    );
  }

  async function book(driver) {
    const tripId = randomUUID();
    const passengerId = randomUUID();

    await tripDb.appQuery(
      `INSERT INTO trip_schema.trips (id, passenger_id, quote_id, pickup, dropoff, status)
       VALUES ($1, $2, $3, $4::jsonb, $4::jsonb, 'MATCHING')`,
      [tripId, passengerId, randomUUID(), JSON.stringify(POINT)],
    );
    await tripDb.appQuery(
      `INSERT INTO trip_schema.fare_snapshots (trip_id, amount, rule_version, distance_meters, duration_seconds)
       VALUES ($1, 41000, 'CAR_V1', 3000, 600)`,
      [tripId],
    );

    const offer = {
      id: randomUUID(),
      jobId: randomUUID(),
      tripId,
      driverId: driver.id,
      status: 'OPEN',
      expiresAt: new Date(Date.now() + 15000).toISOString(),
      version: 1,
    };

    offers.set(offer.id, offer);

    return { tripId, offer };
  }

  const reservationRow = async id =>
    (await driverDb.query('SELECT status FROM driver_schema.reservations WHERE id = $1', [id])).rows[0]?.status;
  const activeReservations = async driverId =>
    (
      await driverDb.query(
        "SELECT count(*)::int AS n FROM driver_schema.reservations WHERE driver_id = $1 AND status IN ('HELD', 'CONFIRMED')",
        [driverId],
      )
    ).rows[0].n;
  const tripRow = async id =>
    (await tripDb.query('SELECT status, driver_id FROM trip_schema.trips WHERE id = $1', [id])).rows[0];
  const logFor = (reservationId, name) =>
    proxyLog.filter(item => item.reservationId === reservationId && item.name === name);

  async function startAccept(driver, booking) {
    const result = await request(tripApp.url, '/api/v1/trips/' + booking.tripId + '/accept', {
      method: 'POST',
      body: { offerId: booking.offer.id },
      headers: { Authorization: 'Bearer ' + driver.token, 'Idempotency-Key': randomUUID() },
    });

    assert.equal(result.status, 202, JSON.stringify(result.body));

    return result.body;
  }

  async function finished(driver, operationId, timeout = 60000) {
    return eventually(async () => {
      const result = await request(tripApp.url, '/api/v1/operations/' + operationId, {
        headers: { Authorization: 'Bearer ' + driver.token },
      });

      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(TERMINAL.includes(result.body.status), 'still ' + result.body.status);

      return result.body;
    }, timeout);
  }

  function planFor(booking, name, remaining, action, effect) {
    const plan = { tripId: booking.tripId, name, remaining, action, effect };

    plans.push(plan);

    return plan;
  }

  try {
    await t.test('a: the reply of a committed reserve is lost', async () => {
      const driver = await onlineDriver();
      const booking = await book(driver);
      const plan = planFor(booking, 'reserve', 3, 'dropReply');
      const accepted = await startAccept(driver, booking);
      const final = await finished(driver, accepted.id);

      assert.equal(final.status, 'SUCCEEDED', JSON.stringify(final));
      assert.equal(plan.remaining, 0, 'the reply was never dropped');

      const reserves = logFor(accepted.assignmentId, 'reserve').length;
      const lookups = logFor(accepted.assignmentId, 'lookup').length;

      assert.equal(reserves, 3);
      assert.ok(lookups >= 1);
      assert.equal(await reservationRow(accepted.assignmentId), 'CONFIRMED');
      assert.equal(await activeReservations(driver.id), 1);
      assert.equal((await tripRow(booking.tripId)).status, 'ASSIGNED');

      evidence.record({ case: 'a', tripId: booking.tripId, assignmentId: accepted.assignmentId, reserves, lookups, reservation: 'CONFIRMED' });
    });

    await t.test('b: the reply of a committed confirm is lost', async () => {
      const driver = await onlineDriver();
      const booking = await book(driver);
      const plan = planFor(booking, 'confirm', 3, 'dropReply');
      const accepted = await startAccept(driver, booking);
      const final = await finished(driver, accepted.id);

      assert.equal(final.status, 'SUCCEEDED', JSON.stringify(final));
      assert.equal(plan.remaining, 0, 'the reply was never dropped');

      const confirms = logFor(accepted.assignmentId, 'confirm').length;
      const lookups = logFor(accepted.assignmentId, 'lookup').length;

      assert.equal(confirms, 3);
      assert.ok(lookups >= 1);
      assert.equal(await reservationRow(accepted.assignmentId), 'CONFIRMED');
      assert.equal(await activeReservations(driver.id), 1);
      assert.equal((await tripRow(booking.tripId)).status, 'ASSIGNED');

      evidence.record({ case: 'b', tripId: booking.tripId, assignmentId: accepted.assignmentId, confirms, lookups, reservation: 'CONFIRMED' });
    });

    await t.test('c: Trip dies after Driver committed the confirm', async () => {
      const driver = await onlineDriver();
      const booking = await book(driver);
      const plan = planFor(booking, 'confirm', 1, 'dropReply', async () => {
        tripApp.child.kill('SIGKILL');
        await once(tripApp.child, 'exit');
      });
      const accepted = await startAccept(driver, booking);

      await eventually(() => assert.notEqual(tripApp.child.exitCode ?? tripApp.child.signalCode, null));

      const before = await reservationRow(accepted.assignmentId);

      assert.equal(before, 'CONFIRMED');
      assert.equal((await tripRow(booking.tripId)).status, 'ASSIGNING');

      tripApp = await launchTrip();

      const final = await finished(driver, accepted.id, 90000);

      assert.equal(final.status, 'SUCCEEDED', JSON.stringify(final));

      const confirms = logFor(accepted.assignmentId, 'confirm').length;

      assert.equal(confirms, 1);
      assert.ok(logFor(accepted.assignmentId, 'lookup').length >= 1);
      assert.equal((await tripRow(booking.tripId)).status, 'ASSIGNED');

      const published = (
        await tripDb.query(
          "SELECT count(*)::int AS n FROM trip_schema.outbox_events WHERE aggregate_id = $1 AND type = 'trip.accepted'",
          [booking.tripId],
        )
      ).rows[0].n;

      assert.equal(published, 1);
      evidence.record({ case: 'c', tripId: booking.tripId, assignmentId: accepted.assignmentId, confirms, tripAcceptedEvents: published });
    });

    await t.test('d: Driver stops mid-saga past the budget, POST /internal/v1/operations/{operationId}/retry cleans up after restart', async () => {
      const driver = await onlineDriver();
      const booking = await book(driver);
      const plan = planFor(booking, 'confirm', 1, 'killDriverBefore', async () => {
        driverApp.child.kill('SIGKILL');
        await once(driverApp.child, 'exit');
      });
      const accepted = await startAccept(driver, booking);
      const stuck = await finished(driver, accepted.id, 150000);

      assert.equal(stuck.status, 'FAILED_NEEDS_REVIEW', JSON.stringify(stuck));
      assert.equal(stuck.tripStatus, 'ASSIGNING');

      driverApp = await fixture.launch('driver-vehicle-location-service', 'DRIVER_PORT', driverEnv);

      const commandId = randomUUID();
      const retried = await request(tripApp.url, '/internal/v1/operations/' + accepted.id + '/retry', {
        method: 'POST',
        body: { commandId, reason: 'Driver restored' },
        headers: { 'X-Service-Token': tokens.ops },
      });

      assert.equal(retried.status, 202, JSON.stringify(retried.body));

      const final = await finished(driver, accepted.id);

      assert.equal(final.status, 'FAILED_COMPENSATED', JSON.stringify(final));
      assert.equal((await tripRow(booking.tripId)).status, 'MATCHING');
      assert.equal(await activeReservations(driver.id), 0);
      assert.ok(['RELEASED', 'EXPIRED'].includes(await reservationRow(accepted.assignmentId)));

      await sendGps(driver);
      assert.equal((await driverCall(driver, '/api/v1/drivers/me', 'GET', undefined, 200)).status, 'AVAILABLE');

      const audit = (
        await tripDb.query('SELECT from_step, reason FROM trip_schema.operation_retries WHERE operation_id = $1', [accepted.id])
      ).rows;

      assert.deepEqual(audit, [{ from_step: 'RELEASE_DRIVER', reason: 'Driver restored' }]);
      evidence.record({
        case: 'd',
        tripId: booking.tripId,
        assignmentId: accepted.assignmentId,
        stuckStatus: stuck.status,
        finalStatus: final.status,
        reservation: await reservationRow(accepted.assignmentId),
        activeReservations: 0,
        audit,
      });
    });

    await t.test('e: a reserve arriving after the tombstone cannot revive the reservation', async () => {
      const driver = await onlineDriver();
      const booking = await book(driver);
      const plan = planFor(booking, 'reserve', 30, 'hold');
      const accepted = await startAccept(driver, booking);
      const final = await finished(driver, accepted.id, 150000);

      assert.equal(final.status, 'FAILED_COMPENSATED', JSON.stringify(final));
      assert.equal(await reservationRow(accepted.assignmentId), 'RELEASED');
      assert.ok(held.length >= 1, 'no reserve was held');

      const statuses = [];

      for (const item of held) {
        const late = await forward(item.req, item.raw);

        statuses.push({ status: late.status, code: (await late.json()).code });
      }

      await sleep(200);

      for (const item of statuses) {
        assert.deepEqual(item, { status: 409, code: 'RESERVATION_CLOSED' });
      }

      assert.equal(await reservationRow(accepted.assignmentId), 'RELEASED');
      assert.equal(await activeReservations(driver.id), 0);

      await sendGps(driver);
      assert.equal((await driverCall(driver, '/api/v1/drivers/me', 'GET', undefined, 200)).status, 'AVAILABLE');

      evidence.record({
        case: 'e',
        tripId: booking.tripId,
        assignmentId: accepted.assignmentId,
        heldReserves: held.length,
        lateReplies: statuses[0],
        reservation: 'RELEASED',
      });
    });

    evidence.set({ summary: 'Đủ 5 case: mất reply sau commit, chết giữa Saga, cleanup qua POST /internal/v1/operations/{operationId}/retry, tombstone chặn lệnh muộn' });
  } catch (error) {
    evidence.fail(error);
    throw error;
  }
});
