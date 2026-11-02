const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { JwtService } = require('@nestjs/jwt');
const amqp = require('amqplib');
const { generateKeys } = require('../../../../../scripts/identity/generate-keys.cjs');
const {
  eventually,
  healthy,
  port,
  start,
  stop,
} = require('../../../../../tests/helpers/identity-environment.cjs');
const { createMatchingBroker } = require('../../../../../tests/helpers/matching-environment.cjs');
const { createPricingDatabase } = require('../../../../../tests/helpers/pricing-environment.cjs');
const { createTripDatabase } = require('../../../../../tests/helpers/trip-environment.cjs');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const ESTIMATE = { pickup: POINT, dropoff: POINT, distanceMeters: 3000, durationSeconds: 600 };
const UNAVAILABLE = { status: 503, body: { code: 'DEPENDENCY_UNAVAILABLE' } };
const TERMINAL = ['SUCCEEDED', 'FAILED_COMPENSATED', 'FAILED_NEEDS_REVIEW'];

const conflict = code => ({ status: 409, body: { code } });

test('Accept and reject saga against scripted Matching and Driver', { timeout: 780000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds03-saga-test-'));
  const running = new Set();
  let pricingApp, monitorConnection, server;

  t.after(async () => {
    for (const app of running) await stop(app);
    if (pricingApp) await stop(pricingApp);
    await monitorConnection?.close().catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }

    const resolved = path.resolve(directory);

    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('ds03-saga-test-')
    ) {
      throw new Error('Unsafe temporary cleanup target');
    }

    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const db = await createTripDatabase(t);
  const pricingDb = await createPricingDatabase(t);
  const broker = await createMatchingBroker(t);

  generateKeys(directory);
  const privateKey = fs.readFileSync(path.join(directory, 'identity-private.pem'));
  const jwt = new JwtService({});
  const token = (userId, role) =>
    jwt.sign(
      { role },
      {
        privateKey,
        algorithm: 'RS256',
        subject: userId,
        issuer: 'ride-hailing',
        audience: 'ride-api',
        expiresIn: 3600,
      },
    );
  const serviceToken = () => randomBytes(32).toString('base64url');
  const tokens = {
    pricing: serviceToken(),
    matching: serviceToken(),
    driver: serviceToken(),
    ops: serviceToken(),
    matchingCaller: serviceToken(),
  };
  const jwtEnv = {
    JWT_PUBLIC_KEY: '',
    JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
    JWT_ISSUER: 'ride-hailing',
    JWT_AUDIENCE: 'ride-api',
  };

  const offers = new Map();
  const jobIds = new Map();
  const scripts = new Map();
  const assignments = new Map();
  const calls = [];

  // Phản hồi theo kịch bản: mỗi lời gọi lấy một mục; hết kịch bản thì trả mặc định đúng contract.
  const on = (name, tripId, ...replies) => scripts.set(name + ':' + tripId, replies);
  const always = (name, tripId, reply) =>
    scripts.set(name + ':' + tripId, { always: reply });

  const defaults = {
    getOffer: ({ id }) =>
      offers.has(id)
        ? { status: 200, body: offers.get(id) }
        : { status: 404, body: { code: 'OFFER_NOT_FOUND' } },
    decide: ({ id, body }) => {
      const offer = offers.get(id);

      return {
        status: 200,
        body: {
          ...offer,
          status: body.action === 'ACCEPT' ? 'CLAIMED' : 'REJECTED',
          assignmentId: body.assignmentId,
        },
      };
    },
    resolve: ({ id, body }) => ({
      status: 200,
      body: {
        ...offers.get(id),
        status: body.result === 'ASSIGNED' ? 'ACCEPTED' : 'CANCELLED',
        assignmentId: body.assignmentId,
      },
    }),
    job: ({ tripId }) => ({
      status: 200,
      body: { id: jobIds.get(tripId) ?? randomUUID(), tripId, status: 'SEARCHING', version: 2 },
    }),
    cancelJob: ({ tripId }) => ({
      status: 200,
      body: { id: jobIds.get(tripId) ?? randomUUID(), tripId, status: 'CANCELLED', version: 3 },
    }),
    lookup: () => ({ status: 404, body: { code: 'RESERVATION_NOT_FOUND' } }),
    reserve: ({ id, body }) => ({
      status: 200,
      body: { id, ...body, status: 'HELD', version: 1 },
    }),
    confirm: ({ id, body }) => ({
      status: 200,
      body: { id, tripId: body.tripId, driverId: body.driverId, status: 'CONFIRMED', version: 2 },
    }),
    release: ({ id, body }) => ({
      status: 200,
      body: { id, tripId: body.tripId, driverId: body.driverId, status: 'RELEASED', version: 3 },
    }),
  };

  function route(method, url) {
    const parts = url.split('/').filter(Boolean);
    const id = parts[3];

    if (url.startsWith('/internal/v1/offers/')) {
      if (method === 'GET') return { name: 'getOffer', id, token: tokens.matching };

      return { name: parts[4] === 'decisions' ? 'decide' : 'resolve', id, token: tokens.matching };
    }

    if (url.startsWith('/internal/v1/matching/jobs/')) {
      return { name: parts[5] === 'cancel' ? 'cancelJob' : 'job', id: parts[4], token: tokens.matching };
    }

    if (url.startsWith('/internal/v1/reservations/')) {
      return {
        name: parts[4] ?? (method === 'GET' ? 'lookup' : 'reserve'),
        id,
        token: tokens.driver,
      };
    }

    return null;
  }

  server = http.createServer(async (req, res) => {
    const send = reply =>
      res
        .writeHead(reply.status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(reply.body));
    let raw = '';

    for await (const chunk of req) raw += chunk;

    const target = route(req.method, req.url);

    if (!target || req.headers['x-service-token'] !== target.token || !req.headers['x-correlation-id']) {
      send({ status: 403, body: { code: 'INTERNAL_CALLER_FORBIDDEN' } });

      return;
    }

    const body = raw ? JSON.parse(raw) : undefined;
    const tripId = ['job', 'cancelJob'].includes(target.name)
      ? target.id
      : (body?.tripId ?? offers.get(target.id)?.tripId ?? assignments.get(target.id));
    const context = { id: target.id, body, tripId };

    calls.push({ name: target.name, ...context });

    const script = scripts.get(target.name + ':' + tripId);
    const entry = Array.isArray(script) ? script.shift() : script?.always;
    const reply = typeof entry === 'function' ? await entry(context) : entry;

    send(reply ?? defaults[target.name](context));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const upstream = 'http://127.0.0.1:' + server.address().port;
  const pricingPort = await port();
  const pricingOrigin = 'http://127.0.0.1:' + pricingPort;

  pricingApp = start('pricing-service', {
    ...pricingDb.env,
    ...jwtEnv,
    PRICING_PORT: String(pricingPort),
    SVC_TOKEN_TRIP_PRICING: tokens.pricing,
  });
  await healthy(pricingApp, pricingOrigin).catch(error => {
    throw new Error(error.message + '\n' + pricingApp.logs);
  });

  async function launchTrip(appPort) {
    const app = start('trip-booking-service', {
      ...db.env,
      ...broker.env,
      ...jwtEnv,
      TRIP_PORT: String(appPort),
      PRICING_BASE_URL: pricingOrigin,
      MATCHING_BASE_URL: upstream,
      DRIVER_BASE_URL: upstream,
      SVC_TOKEN_TRIP_PRICING: tokens.pricing,
      SVC_TOKEN_TRIP_MATCHING: tokens.matching,
      SVC_TOKEN_TRIP_DRIVER: tokens.driver,
      SVC_TOKEN_OPS_TRIP: tokens.ops,
      SVC_TOKEN_MATCHING_TRIP: tokens.matchingCaller,
    });

    running.add(app);
    await healthy(app, 'http://127.0.0.1:' + appPort).catch(error => {
      throw new Error(error.message + '\n' + app.logs);
    });

    return app;
  }

  const tripPort = await port();
  const origin = 'http://127.0.0.1:' + tripPort;
  let tripApp = await launchTrip(tripPort);

  const noDriver = [];
  const accepted = [];
  const cancelled = [];

  monitorConnection = await amqp.connect(broker.url);
  monitorConnection.on('error', () => {});

  const publisher = await monitorConnection.createConfirmChannel();
  const monitor = await monitorConnection.createChannel();

  await monitor.consume('notification.events', message => {
    if (message) {
      const event = JSON.parse(message.content.toString());

      if (event.type === 'trip.no_driver') noDriver.push(event);
      if (event.type === 'trip.accepted') accepted.push(event);
      if (event.type === 'trip.cancelled') cancelled.push(event);
      monitor.ack(message);
    }
  });

  async function call(route_, { method = 'GET', body, headers = {}, base = origin } = {}) {
    const response = await fetch(base + route_, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  const auth = (userId, role) => ({ Authorization: 'Bearer ' + token(userId, role) });

  async function createTrip() {
    const passengerId = randomUUID();
    const quote = await call('/api/v1/quotes', {
      base: pricingOrigin,
      method: 'POST',
      body: ESTIMATE,
      headers: { ...auth(passengerId, 'PASSENGER'), 'Idempotency-Key': randomUUID() },
    });

    assert.equal(quote.status, 201, JSON.stringify(quote.body));

    const trip = await call('/api/v1/trips', {
      method: 'POST',
      body: { quoteId: quote.body.id },
      headers: { ...auth(passengerId, 'PASSENGER'), 'Idempotency-Key': randomUUID() },
    });

    assert.equal(trip.status, 201, JSON.stringify(trip.body));

    return trip.body;
  }

  function addOffer(tripId, driverId, status = 'OPEN') {
    const offer = {
      id: randomUUID(),
      jobId: jobIds.get(tripId) ?? randomUUID(),
      tripId,
      driverId,
      status,
      expiresAt: new Date(Date.now() + 15000).toISOString(),
      version: 1,
    };

    jobIds.set(tripId, offer.jobId);
    offers.set(offer.id, offer);

    return offer;
  }

  async function book() {
    const trip = await createTrip();
    const driverId = randomUUID();

    return { trip, driverId, offer: addOffer(trip.id, driverId) };
  }

  const command = (action, tripId, driverId, body, key = randomUUID(), role = 'DRIVER') =>
    call('/api/v1/trips/' + tripId + '/' + action, {
      method: 'POST',
      body,
      headers: { ...auth(driverId, role), 'Idempotency-Key': key },
    });

  async function accept({ trip, driverId, offer }, key) {
    const result = await command('accept', trip.id, driverId, { offerId: offer.id }, key);

    assert.equal(result.status, 202, JSON.stringify(result.body));
    assignments.set(result.body.assignmentId, trip.id);

    return result.body;
  }

  async function finished(operationId, driverId, timeout = 30000) {
    return eventually(async () => {
      const result = await call('/api/v1/operations/' + operationId, {
        headers: auth(driverId, 'DRIVER'),
      });

      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(TERMINAL.includes(result.body.status), 'still ' + result.body.status);

      return result.body;
    }, timeout);
  }

  const namesFor = tripId => calls.filter(item => item.tripId === tripId).map(item => item.name);
  const callsOf = (name, tripId) =>
    calls.filter(item => item.name === name && item.tripId === tripId);
  const tripRow = async id =>
    (await db.query('SELECT * FROM trip_schema.trips WHERE id = $1', [id])).rows[0];
  const count = async (table, where, values) =>
    (await db.query(`SELECT count(*)::int AS n FROM trip_schema.${table} WHERE ${where}`, values)).rows[0].n;
  const history = async tripId =>
    (
      await db.query(
        'SELECT from_status, to_status FROM trip_schema.state_history WHERE trip_id = $1 ORDER BY occurred_at',
        [tripId],
      )
    ).rows.map(row => row.to_status);

  async function publishFailed(tripId, jobId) {
    const event = {
      event_id: randomUUID(),
      type: 'matching.failed',
      schema_version: 1,
      aggregate_id: jobId,
      aggregate_version: 2,
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      causation_id: randomUUID(),
      producer: 'matching-service',
      payload: { tripId, jobId, jobVersion: 2, reason: 'SEARCH_TIMEOUT' },
    };

    publisher.publish('ride.events', event.type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.event_id,
    });
    await publisher.waitForConfirms();

    return event;
  }

  const failedJob = tripId => ({
    status: 200,
    body: { id: jobIds.get(tripId), tripId, status: 'FAILED', version: 2 },
  });

  await t.test('API-21 returns the operation and stores every step command', async () => {
    const booking = await book();
    const key = randomUUID();
    const operation = await accept(booking, key);

    assert.equal(operation.type, 'ACCEPT');
    assert.equal(operation.status, 'PENDING');
    assert.equal(operation.tripStatus, 'ASSIGNING');
    assert.equal(operation.tripId, booking.trip.id);
    assert.ok(operation.assignmentId);

    const steps = (
      await db.query('SELECT step, command_id FROM trip_schema.saga_steps WHERE operation_id = $1', [operation.id])
    ).rows;

    assert.equal(steps.length, 10);
    assert.equal(steps.find(step => step.step === 'CLAIM_OFFER').command_id, operation.assignmentId);

    const replay = await accept(booking, key);

    assert.deepEqual(replay, operation);

    const final = await finished(operation.id, booking.driverId);

    assert.equal(final.status, 'SUCCEEDED');

    const again = await command('accept', booking.trip.id, booking.driverId, { offerId: booking.offer.id });

    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'INVALID_STATE');

    always('getOffer', booking.trip.id, UNAVAILABLE);
    assert.deepEqual(await accept(booking, key), operation);
  });

  await t.test('API-21 checks the offer before changing the trip', async () => {
    const booking = await book();
    const { trip, driverId, offer } = booking;
    const send = (...args) => command('accept', trip.id, ...args);
    const unchanged = async () => {
      const row = await tripRow(trip.id);

      assert.equal(row.status, 'MATCHING');
      assert.equal(row.version, 1);
    };

    const foreign = await send(randomUUID(), { offerId: offer.id });

    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, 'RESOURCE_FORBIDDEN');

    const otherTrip = addOffer(randomUUID(), driverId);

    assert.equal((await send(driverId, { offerId: otherTrip.id })).status, 403);

    const missing = await send(driverId, { offerId: randomUUID() });

    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'OFFER_NOT_FOUND');

    const expired = addOffer(trip.id, driverId, 'EXPIRED');
    const closed = await send(driverId, { offerId: expired.id });

    assert.equal(closed.status, 409);
    assert.equal(closed.body.code, 'OFFER_CONFLICT');

    assert.equal((await send(driverId, { offerId: offer.id }, randomUUID(), 'PASSENGER')).status, 403);
    assert.equal((await send(driverId, { offerId: offer.id, driverId })).status, 400);

    const noKey = await call('/api/v1/trips/' + trip.id + '/accept', {
      method: 'POST',
      body: { offerId: offer.id },
      headers: auth(driverId, 'DRIVER'),
    });

    assert.equal(noKey.status, 400);

    const unknownTrip = await command('accept', randomUUID(), driverId, { offerId: offer.id });

    assert.equal(unknownTrip.status, 404);
    assert.equal(unknownTrip.body.code, 'TRIP_NOT_FOUND');

    await unchanged();

    const down = await book();

    always('getOffer', down.trip.id, UNAVAILABLE);

    const unavailable = await command('accept', down.trip.id, down.driverId, { offerId: down.offer.id });

    assert.equal(unavailable.status, 503);
    assert.equal((await tripRow(down.trip.id)).status, 'MATCHING');

    const finishedTrip = await book();

    await db.appQuery("UPDATE trip_schema.trips SET status = 'NO_DRIVER' WHERE id = $1", [finishedTrip.trip.id]);

    const terminal = await command('accept', finishedTrip.trip.id, finishedTrip.driverId, {
      offerId: finishedTrip.offer.id,
    });

    assert.equal(terminal.status, 409);
    assert.equal(terminal.body.code, 'INVALID_STATE');
  });

  await t.test('two concurrent accepts: one operation, the other gets INVALID_STATE', async () => {
    const booking = await book();
    const results = await Promise.all(
      [1, 2].map(() =>
        command('accept', booking.trip.id, booking.driverId, { offerId: booking.offer.id }),
      ),
    );

    assert.deepEqual(results.map(result => result.status).sort(), [202, 409]);

    const winner = results.find(result => result.status === 202);

    assert.equal((await finished(winner.body.id, booking.driverId)).status, 'SUCCEEDED');
    assert.equal(await count('operations', 'trip_id = $1', [booking.trip.id]), 1);
  });

  await t.test('the straight path assigns the driver and sends trip.accepted once', async () => {
    const booking = await book();
    let progress, running_;

    on('confirm', booking.trip.id, async () => {
      progress = await call('/api/v1/trips/' + booking.trip.id, {
        headers: auth(booking.driverId, 'DRIVER'),
      });
      running_ = await call('/api/v1/operations/' + current.id, {
        headers: auth(booking.driverId, 'DRIVER'),
      });
    });

    const current = await accept(booking);
    const final = await finished(current.id, booking.driverId);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.tripStatus, 'ASSIGNED');
    assert.equal(final.errorCode, undefined);
    assert.deepEqual(namesFor(booking.trip.id), ['getOffer', 'decide', 'reserve', 'confirm', 'resolve']);

    assert.equal(progress.status, 200);
    assert.equal(progress.body.status, 'ASSIGNING');

    for (const field of ['driverId', 'assignmentId', 'paymentId']) {
      assert.equal(field in progress.body, false, field);
    }

    assert.equal(running_.body.status, 'RUNNING');

    const [decide] = callsOf('decide', booking.trip.id);
    const [reserve] = callsOf('reserve', booking.trip.id);
    const [resolve] = callsOf('resolve', booking.trip.id);

    assert.equal(decide.id, booking.offer.id);
    assert.deepEqual(decide.body, {
      assignmentId: current.assignmentId,
      tripId: booking.trip.id,
      driverId: booking.driverId,
      action: 'ACCEPT',
    });
    assert.equal(reserve.id, current.assignmentId);
    assert.deepEqual(reserve.body, {
      tripId: booking.trip.id,
      driverId: booking.driverId,
      offerId: booking.offer.id,
    });
    assert.equal(resolve.body.result, 'ASSIGNED');

    const row = await tripRow(booking.trip.id);

    assert.equal(row.status, 'ASSIGNED');
    assert.equal(row.driver_id, booking.driverId);
    assert.equal(row.assignment_id, current.assignmentId);
    assert.equal(row.version, 3);
    assert.deepEqual(await history(booking.trip.id), ['MATCHING', 'ASSIGNING', 'ASSIGNED']);

    await eventually(() =>
      assert.equal(accepted.filter(event => event.payload.tripId === booking.trip.id).length, 1),
    );

    const event = accepted.find(item => item.payload.tripId === booking.trip.id);

    assert.equal(event.aggregate_version, 3);
    assert.deepEqual(event.payload, {
      tripId: booking.trip.id,
      passengerId: booking.trip.passengerId,
      driverId: booking.driverId,
      tripVersion: 3,
      status: 'ASSIGNED',
    });

    const steps = (
      await db.query(
        "SELECT step, command_id FROM trip_schema.saga_steps WHERE operation_id = $1 AND status = 'PENDING'",
        [current.id],
      )
    ).rows.map(step => step.step);

    assert.deepEqual(steps.sort(), ['CHECK_JOB', 'RELEASE_DRIVER', 'RESOLVE_RETRY', 'RETURN_TO_MATCHING']);
  });

  await t.test('a rejected claim returns the trip without releasing a driver', async () => {
    for (const reply of [conflict('OFFER_EXPIRED'), { status: 403, body: { code: 'DRIVER_MISMATCH' } }]) {
      const booking = await book();

      on('decide', booking.trip.id, reply);

      const operation = await accept(booking);
      const final = await finished(operation.id, booking.driverId);

      assert.equal(final.status, 'FAILED_COMPENSATED');
      assert.equal(final.errorCode, reply.body.code);
      assert.deepEqual(namesFor(booking.trip.id), ['getOffer', 'decide', 'job']);

      const row = await tripRow(booking.trip.id);

      assert.equal(row.status, 'MATCHING');
      assert.equal(row.assignment_id, null);
      assert.equal(row.driver_id, null);
      assert.equal(row.version, 3);
    }
  });

  await t.test('rejected reserve or confirm releases, resolves RETRY and returns the trip', async () => {
    for (const [name, code] of [
      ['reserve', 'DRIVER_UNAVAILABLE'],
      ['confirm', 'RESERVATION_EXPIRED'],
    ]) {
      const booking = await book();

      on(name, booking.trip.id, conflict(code));

      const operation = await accept(booking);
      const final = await finished(operation.id, booking.driverId);

      assert.equal(final.status, 'FAILED_COMPENSATED');
      assert.equal(final.errorCode, code);

      const [release] = callsOf('release', booking.trip.id);

      assert.equal(release.id, operation.assignmentId);
      assert.equal(release.body.reason, 'ASSIGNMENT_FAILED');
      assert.equal(callsOf('resolve', booking.trip.id)[0].body.result, 'RETRY');

      const row = await tripRow(booking.trip.id);

      assert.equal(row.status, 'MATCHING');
      assert.equal(row.assignment_id, null);
      assert.deepEqual(await history(booking.trip.id), ['MATCHING', 'ASSIGNING', 'MATCHING']);

      const names = namesFor(booking.trip.id);

      assert.ok(names.indexOf('release') < names.indexOf('resolve'));
      assert.ok(names.indexOf('resolve') < names.indexOf('job'));
    }
  });

  await t.test('a rejected finalize keeps the assignment and needs review', async () => {
    const booking = await book();

    on('resolve', booking.trip.id, conflict('JOB_CANCELLED'));

    const operation = await accept(booking);
    const final = await finished(operation.id, booking.driverId);

    assert.equal(final.status, 'FAILED_NEEDS_REVIEW');
    assert.equal(final.errorCode, 'JOB_CANCELLED');
    assert.equal(final.tripStatus, 'ASSIGNED');
    assert.equal(callsOf('release', booking.trip.id).length, 0);
    assert.equal((await tripRow(booking.trip.id)).status, 'ASSIGNED');
  });

  await t.test('temporary failures retry with the same identifiers', async () => {
    const booking = await book();

    for (const name of ['decide', 'reserve', 'confirm', 'resolve']) {
      on(name, booking.trip.id, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE);
    }

    const operation = await accept(booking);
    const final = await finished(operation.id, booking.driverId, 60000);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.errorCode, undefined);

    for (const name of ['decide', 'reserve', 'confirm', 'resolve']) {
      const seen = callsOf(name, booking.trip.id);

      assert.equal(seen.length, 4, name);
      assert.equal(new Set(seen.map(item => item.id + JSON.stringify(item.body))).size, 1, name);
    }

    assert.equal(accepted.filter(event => event.payload.tripId === booking.trip.id).length <= 1, true);
  });

  await t.test('a configuration error is retried, not treated as the driver refusing', async () => {
    const booking = await book();

    on('decide', booking.trip.id, { status: 401, body: { code: 'INTERNAL_CALLER_FORBIDDEN' } });

    const operation = await accept(booking);
    const final = await finished(operation.id, booking.driverId);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(callsOf('decide', booking.trip.id).length, 2);
    assert.equal(callsOf('release', booking.trip.id).length, 0);
  });

  await t.test('after five failed cycles the saga compensates, and needs review if that fails too', async () => {
    const driverDown = await book();
    const claimUnknown = await book();
    const nothingWorks = await book();

    always('reserve', driverDown.trip.id, UNAVAILABLE);
    always('decide', claimUnknown.trip.id, UNAVAILABLE);
    on('resolve', claimUnknown.trip.id, conflict('ASSIGNMENT_MISMATCH'));
    always('reserve', nothingWorks.trip.id, UNAVAILABLE);
    always('release', nothingWorks.trip.id, UNAVAILABLE);

    const [first, second, third] = await Promise.all(
      [driverDown, claimUnknown, nothingWorks].map(async booking => {
        const operation = await accept(booking);

        return finished(operation.id, booking.driverId, 150000);
      }),
    );

    assert.equal(first.status, 'FAILED_COMPENSATED');
    assert.equal(first.errorCode, 'DEPENDENCY_UNAVAILABLE');
    assert.equal((await tripRow(driverDown.trip.id)).status, 'MATCHING');
    assert.equal(callsOf('release', driverDown.trip.id).length, 1);

    assert.equal(second.status, 'FAILED_COMPENSATED');
    assert.equal(callsOf('reserve', claimUnknown.trip.id).length, 0);
    assert.equal(callsOf('release', claimUnknown.trip.id).length, 1);
    assert.equal((await tripRow(claimUnknown.trip.id)).status, 'MATCHING');

    assert.equal(third.status, 'FAILED_NEEDS_REVIEW');
    assert.equal(third.errorCode, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(third.tripStatus, 'ASSIGNING');
    assert.equal(callsOf('resolve', nothingWorks.trip.id).length, 0);
  });

  await t.test('CHECK_JOB ends the trip when the job has failed', async () => {
    const booking = await book();

    on('reserve', booking.trip.id, conflict('DRIVER_UNAVAILABLE'));
    always('job', booking.trip.id, failedJob(booking.trip.id));

    const operation = await accept(booking);
    const final = await finished(operation.id, booking.driverId);

    assert.equal(final.status, 'FAILED_COMPENSATED');
    assert.equal(final.tripStatus, 'NO_DRIVER');
    assert.deepEqual(await history(booking.trip.id), ['MATCHING', 'ASSIGNING', 'MATCHING', 'NO_DRIVER']);

    await eventually(() =>
      assert.equal(noDriver.filter(event => event.payload.tripId === booking.trip.id).length, 1),
    );
    assert.equal(noDriver.find(event => event.payload.tripId === booking.trip.id).payload.reason, 'NO_CANDIDATE');
  });

  await t.test('matching.failed ignored during ASSIGNING does not leave the trip stuck', async () => {
    const booking = await book();
    const { trip } = booking;

    always('job', trip.id, failedJob(trip.id));
    on('decide', trip.id, async () => {
      const event = await publishFailed(trip.id, jobIds.get(trip.id));

      await eventually(
        async () =>
          assert.equal(await count('processed_events', 'event_id = $1', [event.event_id]), 1),
        1500,
      );

      return conflict('OFFER_EXPIRED');
    });

    const operation = await accept(booking);
    const final = await finished(operation.id, booking.driverId);

    assert.equal(final.status, 'FAILED_COMPENSATED');
    assert.equal((await tripRow(trip.id)).status, 'NO_DRIVER');

    await eventually(() =>
      assert.equal(noDriver.filter(event => event.payload.tripId === trip.id).length, 1),
    );
  });

  await t.test('matching.failed racing CHECK_JOB still produces one trip.no_driver', async () => {
    const booking = await book();
    const { trip } = booking;
    let published = false;

    on('reserve', trip.id, conflict('DRIVER_UNAVAILABLE'));
    always('job', trip.id, async () => {
      if (!published) {
        published = true;
        await publishFailed(trip.id, jobIds.get(trip.id));
        await sleep(500);
      }

      return failedJob(trip.id);
    });

    const operation = await accept(booking);
    const final = await finished(operation.id, booking.driverId);

    assert.equal(final.status, 'FAILED_COMPENSATED');

    await eventually(() =>
      assert.equal(noDriver.filter(event => event.payload.tripId === trip.id).length, 1),
    );
    await sleep(1500);

    assert.equal(noDriver.filter(event => event.payload.tripId === trip.id).length, 1);
    assert.equal(await count('state_history', "trip_id = $1 AND to_status = 'NO_DRIVER'", [trip.id]), 1);
    assert.equal((await tripRow(trip.id)).status, 'NO_DRIVER');
  });

  await t.test('a trip that started cancelling is not assigned', async () => {
    const booking = await book();
    const { trip } = booking;

    on('confirm', trip.id, async () => {
      await db.appQuery("UPDATE trip_schema.trips SET status = 'CANCELLING' WHERE id = $1", [trip.id]);
    });

    const operation = await accept(booking);
    const final = await finished(operation.id, booking.driverId);

    assert.equal(final.status, 'FAILED_COMPENSATED');
    assert.equal(final.errorCode, 'TRIP_STATE_CHANGED');
    assert.equal(callsOf('release', trip.id).length, 1);
    assert.equal(callsOf('resolve', trip.id)[0].body.result, 'CANCELLED');

    const row = await tripRow(trip.id);

    assert.equal(row.status, 'CANCELLING');
    assert.equal(row.assignment_id, operation.assignmentId);
  });

  await t.test('a driver already on another trip fails the commit and is released', async () => {
    const booking = await book();
    const busy = await createTrip();

    await db.appQuery(
      "UPDATE trip_schema.trips SET status = 'ASSIGNED', driver_id = $2, assignment_id = $3 WHERE id = $1",
      [busy.id, booking.driverId, randomUUID()],
    );

    const operation = await accept(booking);
    const final = await finished(operation.id, booking.driverId);

    assert.equal(final.status, 'FAILED_COMPENSATED');
    assert.equal(final.errorCode, 'DRIVER_UNAVAILABLE');
    assert.equal(callsOf('release', booking.trip.id).length, 1);
    assert.equal((await tripRow(booking.trip.id)).status, 'MATCHING');
  });

  await t.test('API-22 rejects through Matching and leaves the trip searching', async () => {
    const booking = await book();
    const { trip, driverId, offer } = booking;
    const body = { offerId: offer.id, reason: 'UNAVAILABLE' };

    assert.equal((await command('reject', trip.id, driverId, { offerId: offer.id })).status, 400);
    assert.equal((await command('reject', trip.id, randomUUID(), body)).status, 403);

    const key = randomUUID();
    const result = await command('reject', trip.id, driverId, body, key);

    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.type, 'REJECT');
    assert.equal(result.body.tripStatus, 'MATCHING');
    assert.equal('assignmentId' in result.body, false);
    assert.deepEqual((await command('reject', trip.id, driverId, body, key)).body, result.body);

    const changed = await command('reject', trip.id, driverId, { ...body, reason: 'NOT_INTERESTED' }, key);

    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'IDEMPOTENCY_CONFLICT');

    const final = await finished(result.body.id, driverId);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.tripStatus, 'MATCHING');

    const [decide] = callsOf('decide', trip.id);

    assert.equal(decide.body.action, 'REJECT');
    assert.equal(decide.body.driverId, driverId);

    const [step] = (
      await db.query("SELECT command_id FROM trip_schema.saga_steps WHERE operation_id = $1 AND step = 'REJECT_OFFER'", [
        result.body.id,
      ])
    ).rows;

    assert.equal(decide.body.assignmentId, step.command_id);
    assert.deepEqual([...new Set(namesFor(trip.id))].sort(), ['decide', 'getOffer']);

    const row = await tripRow(trip.id);

    assert.equal(row.status, 'MATCHING');
    assert.equal(row.version, 1);
  });

  await t.test('a refused reject ends without touching the trip', async () => {
    const booking = await book();

    on('decide', booking.trip.id, conflict('OFFER_EXPIRED'));

    const result = await command('reject', booking.trip.id, booking.driverId, {
      offerId: booking.offer.id,
      reason: 'NOT_INTERESTED',
    });
    const final = await finished(result.body.id, booking.driverId);

    assert.equal(final.status, 'FAILED_COMPENSATED');
    assert.equal(final.errorCode, 'OFFER_EXPIRED');
    assert.equal((await tripRow(booking.trip.id)).status, 'MATCHING');
  });

  await t.test('a killed Trip resumes from the database with the same commands', async () => {
    const booking = await book();
    const { trip, driverId } = booking;

    on('confirm', trip.id, async () => {
      tripApp.child.kill('SIGKILL');
      await once(tripApp.child, 'exit');

      return UNAVAILABLE;
    });

    const operation = await accept(booking);

    await eventually(() => assert.notEqual(tripApp.child.exitCode ?? tripApp.child.signalCode, null));
    running.delete(tripApp);

    const [row] = (
      await db.query('SELECT status, current_step, lease_token FROM trip_schema.operations WHERE id = $1', [
        operation.id,
      ])
    ).rows;

    assert.equal(row.status, 'RUNNING');
    assert.equal(row.current_step, 'CONFIRM_DRIVER');
    assert.ok(row.lease_token);

    tripApp = await launchTrip(tripPort);

    const final = await finished(operation.id, driverId, 60000);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(callsOf('reserve', trip.id).length, 1);

    const confirms = callsOf('confirm', trip.id);

    assert.ok(confirms.length >= 2);
    assert.equal(new Set(confirms.map(item => item.body.commandId)).size, 1);
    assert.equal(await count('outbox_events', "aggregate_id = $1 AND type = 'trip.accepted'", [trip.id]), 1);
    assert.equal((await tripRow(trip.id)).status, 'ASSIGNED');
  });

  await t.test('two Trip instances run each operation once', async () => {
    const otherPort = await port();
    const other = await launchTrip(otherPort);

    try {
      const bookings = await Promise.all(Array.from({ length: 5 }, () => book()));
      const operations = await Promise.all(bookings.map(booking => accept(booking)));

      for (const [index, operation] of operations.entries()) {
        const { trip, driverId } = bookings[index];

        assert.equal((await finished(operation.id, driverId, 60000)).status, 'SUCCEEDED');

        for (const name of ['decide', 'reserve', 'confirm', 'resolve']) {
          assert.equal(callsOf(name, trip.id).length, 1, name);
        }
      }
    } finally {
      await stop(other);
      running.delete(other);
    }
  });

  const cancelTrip = (trip, { key = randomUUID(), reason = 'CHANGE_PLAN', actor = trip.passengerId, role = 'PASSENGER' } = {}) =>
    command('cancel', trip.id, actor, { reason }, key, role);

  async function cancelled202(trip, options) {
    const result = await cancelTrip(trip, options);

    assert.equal(result.status, 202, JSON.stringify(result.body));

    return result.body;
  }

  async function assignedBooking() {
    const booking = await book();
    const operation = await accept(booking);

    assert.equal((await finished(operation.id, booking.driverId)).status, 'SUCCEEDED');

    return { ...booking, assignmentId: operation.assignmentId };
  }

  const setTripStatus = (tripId, status) =>
    db.appQuery(
      'UPDATE trip_schema.trips SET status = $2, driver_id = $3, assignment_id = $4 WHERE id = $1',
      [tripId, status, randomUUID(), randomUUID()],
    );

  await t.test('API-23 enforces the owner, the reason and the trip state', async () => {
    const trip = await createTrip();

    assert.equal((await cancelTrip(trip, { actor: randomUUID() })).status, 403);
    assert.equal((await cancelTrip(trip, { role: 'DRIVER' })).status, 403);
    assert.equal((await cancelTrip(trip, { reason: 'BORED' })).status, 400);
    assert.equal((await cancelTrip({ ...trip, id: randomUUID() })).status, 404);
    assert.equal((await tripRow(trip.id)).status, 'MATCHING');

    const key = randomUUID();
    const first = await cancelled202(trip, { key });

    assert.equal(first.type, 'CANCEL');
    assert.equal(first.status, 'PENDING');
    assert.equal(first.tripStatus, 'CANCELLING');
    assert.deepEqual(await cancelled202(trip, { key }), first);

    const started = await createTrip();

    await setTripStatus(started.id, 'IN_PROGRESS');

    const late = await cancelTrip(started);

    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'TRIP_ALREADY_STARTED');

    for (const status of ['COMPLETED', 'NO_DRIVER', 'CANCELLING', 'CANCELLED']) {
      const other = await createTrip();

      await setTripStatus(other.id, status);

      const refused = await cancelTrip(other);

      assert.equal(refused.status, 409, status);
      assert.equal(refused.body.code, 'INVALID_STATE', status);
    }
  });

  await t.test('cancelling a searching trip cancels the job without touching a driver', async () => {
    const trip = await createTrip();
    const operation = await cancelled202(trip, { reason: 'WAIT_TOO_LONG' });
    const final = await finished(operation.id, trip.passengerId);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.tripStatus, 'CANCELLED');

    const [job] = callsOf('cancelJob', trip.id);

    assert.equal(job.body.tripVersion, 2);
    assert.equal(callsOf('release', trip.id).length, 0);
    assert.deepEqual(await history(trip.id), ['MATCHING', 'CANCELLING', 'CANCELLED']);

    await eventually(() =>
      assert.equal(cancelled.filter(event => event.payload.tripId === trip.id).length, 1),
    );
    assert.deepEqual(cancelled.find(event => event.payload.tripId === trip.id).payload, {
      tripId: trip.id,
      passengerId: trip.passengerId,
      affectedDriverIds: [],
      tripVersion: 3,
      reason: 'WAIT_TOO_LONG',
    });
  });

  await t.test('cancelling an assigned trip releases the driver before CANCELLED', async () => {
    const { trip, driverId, assignmentId } = await assignedBooking();
    let statusAtRelease;

    on('release', trip.id, async () => {
      statusAtRelease = (await tripRow(trip.id)).status;
    });

    const operation = await cancelled202(trip);

    assert.equal(operation.assignmentId, assignmentId);

    const final = await finished(operation.id, trip.passengerId);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(statusAtRelease, 'CANCELLING');

    const [release] = callsOf('release', trip.id);

    assert.equal(release.id, assignmentId);
    assert.equal(release.body.reason, 'TRIP_CANCELLED');
    assert.equal(release.body.driverId, driverId);

    await eventually(() =>
      assert.equal(cancelled.filter(event => event.payload.tripId === trip.id).length, 1),
    );
    assert.deepEqual(
      cancelled.find(event => event.payload.tripId === trip.id).payload.affectedDriverIds,
      [driverId],
    );
  });

  await t.test('cancelling during the accept saga never assigns the driver', async () => {
    for (const name of ['decide', 'reserve', 'confirm']) {
      const booking = await book();
      const { trip, driverId } = booking;
      let operation;

      on(name, trip.id, async () => {
        operation = await cancelled202(trip);
      });

      const accepting = await accept(booking);
      const acceptance = await finished(accepting.id, driverId);

      assert.equal(acceptance.status, 'FAILED_COMPENSATED', name);
      assert.equal(acceptance.errorCode, 'TRIP_STATE_CHANGED', name);
      assert.equal((await finished(operation.id, trip.passengerId)).status, 'SUCCEEDED', name);

      const row = await tripRow(trip.id);

      assert.equal(row.status, 'CANCELLED', name);
      assert.equal(row.driver_id, null, name);
      assert.ok(!(await history(trip.id)).includes('ASSIGNED'), name);
      assert.ok(callsOf('release', trip.id).length >= 1, name);
      assert.deepEqual(
        [...new Set(callsOf('release', trip.id).map(item => item.id))],
        [accepting.assignmentId],
        name,
      );
    }
  });

  await t.test('cancelling during finalize ends the accept without needing review', async () => {
    const booking = await book();
    const { trip, driverId } = booking;
    let operation;

    on('resolve', trip.id, async () => {
      operation = await cancelled202(trip);

      return conflict('JOB_CANCELLED');
    });

    const accepting = await accept(booking);
    const acceptance = await finished(accepting.id, driverId);

    assert.equal(acceptance.status, 'FAILED_COMPENSATED');
    assert.equal(acceptance.errorCode, 'JOB_CANCELLED');
    assert.equal((await finished(operation.id, trip.passengerId)).status, 'SUCCEEDED');
    assert.equal((await tripRow(trip.id)).status, 'CANCELLED');
    assert.equal(callsOf('release', trip.id)[0].body.reason, 'TRIP_CANCELLED');
  });

  await t.test('temporary failures while cancelling retry with the same commands', async () => {
    const { trip } = await assignedBooking();

    on('cancelJob', trip.id, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE);
    on('release', trip.id, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE);

    const operation = await cancelled202(trip);

    assert.equal((await finished(operation.id, trip.passengerId, 60000)).status, 'SUCCEEDED');

    for (const name of ['cancelJob', 'release']) {
      const seen = callsOf(name, trip.id);

      assert.equal(seen.length, 4, name);
      assert.equal(new Set(seen.map(item => item.body.commandId)).size, 1, name);
    }
  });

  const retryOperation = (operationId, { commandId = randomUUID(), reason = 'Dependency restored', token: value = tokens.ops } = {}) =>
    call('/internal/v1/operations/' + operationId + '/retry', {
      method: 'POST',
      body: { commandId, reason },
      headers: value ? { 'X-Service-Token': value } : {},
    });

  await t.test('API-28 resumes an operation needing review, with audit', async () => {
    const { trip } = await assignedBooking();

    always('cancelJob', trip.id, UNAVAILABLE);

    const operation = await cancelled202(trip);
    const stuck = await finished(operation.id, trip.passengerId, 90000);

    assert.equal(stuck.status, 'FAILED_NEEDS_REVIEW');
    assert.equal(stuck.errorCode, 'DEPENDENCY_UNAVAILABLE');
    assert.equal((await tripRow(trip.id)).status, 'CANCELLING');

    assert.equal((await retryOperation(operation.id, { token: serviceToken() })).status, 401);
    assert.equal((await retryOperation(operation.id, { token: tokens.matchingCaller })).status, 403);
    assert.equal((await retryOperation(operation.id, { reason: 'x' })).status, 400);

    const missing = await retryOperation(randomUUID());

    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'OPERATION_NOT_FOUND');

    const blocked = await retryOperation(operation.id);

    assert.equal(blocked.status, 202, JSON.stringify(blocked.body));
    assert.equal(
      (await finished(operation.id, trip.passengerId, 90000)).status,
      'FAILED_NEEDS_REVIEW',
    );

    scripts.delete('cancelJob:' + trip.id);

    const commandId = randomUUID();
    const retried = await retryOperation(operation.id, { commandId });

    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.body.status, 'PENDING');
    assert.equal(retried.body.errorCode, undefined);

    const replay = await retryOperation(operation.id, { commandId });

    assert.equal(replay.status, 202);
    assert.deepEqual(replay.body, retried.body);

    const changed = await retryOperation(operation.id, { commandId, reason: 'Something else' });

    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'PAYLOAD_MISMATCH');

    const final = await finished(operation.id, trip.passengerId);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.tripStatus, 'CANCELLED');
    assert.equal(new Set(callsOf('cancelJob', trip.id).map(item => item.body.commandId)).size, 1);

    const notRetryable = await retryOperation(operation.id);

    assert.equal(notRetryable.status, 409);
    assert.equal(notRetryable.body.code, 'OPERATION_NOT_RETRYABLE');

    const audit = (
      await db.query(
        'SELECT caller, reason, from_step, previous_error_code, command_id FROM trip_schema.operation_retries WHERE operation_id = $1 ORDER BY created_at',
        [operation.id],
      )
    ).rows;

    assert.equal(audit.length, 2);
    assert.equal(audit[1].caller, 'OPS');
    assert.equal(audit[1].reason, 'Dependency restored');
    assert.equal(audit[1].from_step, 'CANCEL_JOB');
    assert.equal(audit[1].previous_error_code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(audit[1].command_id, commandId);
  });

  await t.test('API-28 lets a completed trip release the driver and request payment once', async () => {
    const { trip, driverId } = await assignedBooking();
    const started = await command('start', trip.id, driverId, {});

    assert.equal(started.status, 200, JSON.stringify(started.body));

    always('release', trip.id, UNAVAILABLE);

    const completing = await command('complete', trip.id, driverId, {});

    assert.equal(completing.status, 202, JSON.stringify(completing.body));

    const stuck = await finished(completing.body.id, driverId, 90000);

    assert.equal(stuck.status, 'FAILED_NEEDS_REVIEW');
    assert.equal(await count('outbox_events', "aggregate_id = $1 AND type = 'payment.requested'", [trip.id]), 0);

    scripts.delete('release:' + trip.id);

    const results = await Promise.all([retryOperation(completing.body.id), retryOperation(completing.body.id)]);

    assert.deepEqual(results.map(result => result.status).sort(), [202, 409]);
    assert.equal((await finished(completing.body.id, driverId)).status, 'SUCCEEDED');
    assert.equal(await count('outbox_events', "aggregate_id = $1 AND type = 'payment.requested'", [trip.id]), 1);
    assert.equal((await tripRow(trip.id)).status, 'COMPLETED');
  });

  await t.test('API-12 decides the next step when the previous outcome is unknown', async () => {
    const reservation = (id, tripId, driverId, status) => ({
      status: 200,
      body: { id, tripId, driverId, status, version: 2 },
    });

    async function scenario(failing, status) {
      const booking = await book();
      const { trip, driverId } = booking;

      on(failing, trip.id, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE);

      if (status) {
        on('lookup', trip.id, ({ id }) => reservation(id, trip.id, driverId, status));
      }

      const operation = await accept(booking);

      return { trip, final: await finished(operation.id, driverId, 60000) };
    }

    const held = await scenario('reserve', 'HELD');

    assert.equal(held.final.status, 'SUCCEEDED');
    assert.equal(callsOf('reserve', held.trip.id).length, 3);
    assert.equal(callsOf('confirm', held.trip.id).length, 1);

    const confirmedAtReserve = await scenario('reserve', 'CONFIRMED');

    assert.equal(confirmedAtReserve.final.status, 'SUCCEEDED');
    assert.equal(callsOf('confirm', confirmedAtReserve.trip.id).length, 0);

    const released = await scenario('reserve', 'RELEASED');

    assert.equal(released.final.status, 'FAILED_COMPENSATED');
    assert.equal(released.final.errorCode, 'RESERVATION_RELEASED');
    assert.equal(callsOf('confirm', released.trip.id).length, 0);

    const missing = await scenario('reserve');

    assert.equal(missing.final.status, 'SUCCEEDED');
    assert.equal(callsOf('reserve', missing.trip.id).length, 4);

    const confirmed = await scenario('confirm', 'CONFIRMED');

    assert.equal(confirmed.final.status, 'SUCCEEDED');
    assert.equal(callsOf('confirm', confirmed.trip.id).length, 3);

    const stillHeld = await scenario('confirm', 'HELD');

    assert.equal(stillHeld.final.status, 'SUCCEEDED');
    assert.equal(callsOf('confirm', stillHeld.trip.id).length, 4);

    const expired = await scenario('confirm', 'EXPIRED');

    assert.equal(expired.final.status, 'FAILED_COMPENSATED');
    assert.equal(expired.final.errorCode, 'RESERVATION_EXPIRED');

    const clean = await book();
    const operation = await accept(clean);

    assert.equal((await finished(operation.id, clean.driverId)).status, 'SUCCEEDED');
    assert.equal(callsOf('lookup', clean.trip.id).length, 0);
  });
});
