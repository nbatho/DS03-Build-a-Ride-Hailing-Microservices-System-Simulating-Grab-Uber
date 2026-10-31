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
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const { generateKeys } = require('../../../../../scripts/identity/generate-keys.cjs');
const {
  docker,
  eventually,
  healthy,
  port,
  start,
  stop,
} = require('../../../../../tests/helpers/identity-environment.cjs');
const { createMatchingBroker } = require('../../../../../tests/helpers/matching-environment.cjs');
const { createPricingDatabase } = require('../../../../../tests/helpers/pricing-environment.cjs');
const { createTripDatabase } = require('../../../../../tests/helpers/trip-environment.cjs');
const matchingEvents = require('../../../matching-service/src/matching/events.schema.json');
const matchingHttp = require('../../../matching-service/src/matching/http.schema.json');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const ESTIMATE = { pickup: POINT, dropoff: POINT, distanceMeters: 3000, durationSeconds: 600 };

const ajv = new Ajv2020({ strict: false });

addFormats(ajv);
const validEvent = ajv.compile(matchingEvents);
const validTrip = ajv.compile({ ...matchingHttp, $ref: '#/components/schemas/Trip' });

test('Trip APIs, outbox and consumer with real PostgreSQL, RabbitMQ and Pricing', { timeout: 420000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds03-trip-test-'));
  let tripApp, pricingApp, monitorConnection, server;

  t.after(async () => {
    if (tripApp) await stop(tripApp);
    if (pricingApp) await stop(pricingApp);
    await monitorConnection?.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve));

    const resolved = path.resolve(directory);

    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('ds03-trip-test-')
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
  const token = (userId, role = 'PASSENGER') =>
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
    tripPricing: serviceToken(),
    tripMatching: serviceToken(),
    matchingTrip: serviceToken(),
    driverTrip: serviceToken(),
    paymentTrip: serviceToken(),
    opsTrip: serviceToken(),
  };
  const jwtEnv = {
    JWT_PUBLIC_KEY: '',
    JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
    JWT_ISSUER: 'ride-hailing',
    JWT_AUDIENCE: 'ride-api',
  };

  const jobs = new Map();
  const jobCalls = new Map();

  server = http.createServer(async (req, res) => {
    const send = (status, body) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const tripId = req.url.split('/').at(-1);

    if (
      !req.url.startsWith('/internal/v1/matching/jobs/') ||
      req.headers['x-service-token'] !== tokens.tripMatching ||
      !req.headers['x-correlation-id']
    ) {
      send(403, { code: 'INTERNAL_CALLER_FORBIDDEN' });

      return;
    }

    const calls = (jobCalls.get(tripId) ?? 0) + 1;

    jobCalls.set(tripId, calls);

    const scenario = jobs.get(tripId);
    const reply = scenario ? await scenario(calls) : { status: 404, body: { code: 'JOB_NOT_FOUND' } };

    send(reply.status, reply.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const pricingPort = await port();
  const tripPort = await port();
  const origin = 'http://127.0.0.1:' + tripPort;
  const pricingOrigin = 'http://127.0.0.1:' + pricingPort;

  pricingApp = start('pricing-service', {
    ...pricingDb.env,
    ...jwtEnv,
    PRICING_PORT: String(pricingPort),
    SVC_TOKEN_TRIP_PRICING: tokens.tripPricing,
  });
  await healthy(pricingApp, pricingOrigin).catch(error => {
    throw new Error(error.message + '\n' + pricingApp.logs);
  });

  tripApp = start('trip-booking-service', {
    ...db.env,
    ...broker.env,
    ...jwtEnv,
    TRIP_PORT: String(tripPort),
    PRICING_BASE_URL: pricingOrigin,
    MATCHING_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    SVC_TOKEN_TRIP_PRICING: tokens.tripPricing,
    SVC_TOKEN_TRIP_MATCHING: tokens.tripMatching,
    SVC_TOKEN_MATCHING_TRIP: tokens.matchingTrip,
    SVC_TOKEN_DRIVER_TRIP: tokens.driverTrip,
    SVC_TOKEN_PAYMENT_TRIP: tokens.paymentTrip,
    SVC_TOKEN_OPS_TRIP: tokens.opsTrip,
  });
  await healthy(tripApp, origin).catch(error => {
    throw new Error(error.message + '\n' + tripApp.logs);
  });

  const received = { 'matching.events': [], 'notification.events': [], 'trip.events.dlq': [] };
  let publisher;

  async function connectMonitor() {
    await monitorConnection?.close().catch(() => {});
    monitorConnection = await amqp.connect(broker.url);
    monitorConnection.on('error', () => {});
    publisher = await monitorConnection.createConfirmChannel();
    publisher.on('error', () => {});

    const channel = await monitorConnection.createChannel();

    channel.on('error', () => {});

    for (const queue of Object.keys(received)) {
      await channel.consume(queue, message => {
        if (message) {
          received[queue].push({
            event: JSON.parse(message.content.toString()),
            headers: message.properties.headers ?? {},
          });
          channel.ack(message);
        }
      });
    }
  }

  await connectMonitor();

  async function call(route, { method = 'GET', body, headers = {}, base = origin } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  const auth = (userId, role) => ({ Authorization: 'Bearer ' + token(userId, role) });

  async function createQuote(passengerId) {
    const result = await call('/api/v1/quotes', {
      base: pricingOrigin,
      method: 'POST',
      body: ESTIMATE,
      headers: { ...auth(passengerId), 'Idempotency-Key': randomUUID() },
    });

    assert.equal(result.status, 201, JSON.stringify(result.body));

    return result.body;
  }

  const postTrip = (passengerId, quoteId, key = randomUUID(), extra = {}) =>
    call('/api/v1/trips', {
      method: 'POST',
      body: { quoteId, ...extra },
      headers: { ...auth(passengerId), 'Idempotency-Key': key },
    });

  async function createTrip(passengerId = randomUUID()) {
    const quote = await createQuote(passengerId);
    const result = await postTrip(passengerId, quote.id);

    assert.equal(result.status, 201, JSON.stringify(result.body));

    return result.body;
  }

  async function seedTrip(fields = {}) {
    const row = {
      id: randomUUID(),
      passengerId: randomUUID(),
      driverId: null,
      assignmentId: null,
      status: 'MATCHING',
      createdAt: new Date().toISOString(),
      ...fields,
    };

    await db.appQuery(
      `INSERT INTO trip_schema.trips
         (id, passenger_id, driver_id, quote_id, assignment_id, pickup, dropoff, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $6::jsonb, $7, $8, $8)`,
      [
        row.id,
        row.passengerId,
        row.driverId,
        randomUUID(),
        row.assignmentId,
        JSON.stringify(POINT),
        row.status,
        row.createdAt,
      ],
    );
    await db.appQuery(
      `INSERT INTO trip_schema.fare_snapshots (trip_id, amount, rule_version, distance_meters, duration_seconds)
       VALUES ($1, 41000, 'CAR_V1', 3000, 600)`,
      [row.id],
    );

    return row;
  }

  async function seedOperation(tripId, actorId, status = 'PENDING', fields = {}) {
    const id = randomUUID();

    await db.appQuery(
      `INSERT INTO trip_schema.operations
         (id, trip_id, actor_id, type, status, assignment_id, current_step, error_code, correlation_id, next_retry_at)
       VALUES ($1, $2, $3, 'ACCEPT', $4, $5, 'CLAIM_OFFER', $6, $7, now() + interval '1 hour')`,
      [id, tripId, actorId, status, fields.assignmentId ?? null, fields.errorCode ?? null, randomUUID()],
    );

    return id;
  }

  const count = async (table, where, values) =>
    (await db.query(`SELECT count(*)::int AS n FROM trip_schema.${table} WHERE ${where}`, values)).rows[0].n;
  const tripRow = async id =>
    (await db.query('SELECT * FROM trip_schema.trips WHERE id = $1', [id])).rows[0];
  const eventsFor = (queue, tripId) =>
    received[queue].filter(item => item.event.payload.tripId === tripId);

  const envelope = (type, aggregateId, payload, eventId = randomUUID()) => ({
    event_id: eventId,
    type,
    schema_version: 1,
    aggregate_id: aggregateId,
    aggregate_version: payload.jobVersion ?? payload.paymentVersion,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    producer: type.startsWith('payment.') ? 'simulated-payment-service' : 'matching-service',
    payload,
  });

  async function publish(event) {
    publisher.publish('ride.events', event.type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.event_id,
    });
    await publisher.waitForConfirms();

    return event;
  }

  const failedEvent = (tripId, jobId = randomUUID(), eventId) =>
    envelope('matching.failed', jobId, { tripId, jobId, jobVersion: 2, reason: 'NO_CANDIDATE' }, eventId);
  const failedJob = (tripId, jobId, status = 'FAILED') => ({
    status: 200,
    body: { id: jobId, tripId, status, version: 2 },
  });
  const processed = eventId =>
    count('processed_events', 'consumer_name = $1 AND event_id = $2', ['trip-booking-service', eventId]);

  await t.test('API-18 creates a trip, snapshot, history and outbox in one commit', async () => {
    const passengerId = randomUUID();
    const quote = await createQuote(passengerId);
    const result = await postTrip(passengerId, quote.id);

    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.quoteId, quote.id);
    assert.equal(result.body.passengerId, passengerId);
    assert.equal(result.body.amount, '41000');
    assert.equal(result.body.currency, 'VND');
    assert.equal(result.body.status, 'MATCHING');
    assert.equal(result.body.paymentStatus, 'NOT_REQUESTED');
    assert.equal(result.body.version, 1);
    assert.deepEqual(result.body.pickup, POINT);
    assert.ok(validTrip(result.body), JSON.stringify(validTrip.errors));

    const id = result.body.id;
    const fare = (await db.query('SELECT * FROM trip_schema.fare_snapshots WHERE trip_id = $1', [id])).rows[0];

    assert.equal(fare.amount, '41000');
    assert.equal(fare.rule_version, quote.ruleVersion);
    assert.equal(fare.distance_meters, 3000);
    assert.equal(fare.duration_seconds, 600);

    const history = (await db.query('SELECT * FROM trip_schema.state_history WHERE trip_id = $1', [id])).rows;

    assert.equal(history.length, 1);
    assert.equal(history[0].from_status, null);
    assert.equal(history[0].to_status, 'MATCHING');
    assert.equal(history[0].actor_id, passengerId);

    await eventually(async () => {
      const outbox = await db.query('SELECT status FROM trip_schema.outbox_events WHERE aggregate_id = $1', [id]);

      assert.deepEqual(outbox.rows.map(row => row.status), ['PUBLISHED']);
      assert.equal(eventsFor('matching.events', id).length, 1);
    });

    const { event } = eventsFor('matching.events', id)[0];

    assert.ok(validEvent(event), JSON.stringify(validEvent.errors));
    assert.equal(event.type, 'trip.requested');
    assert.equal(event.aggregate_id, event.payload.tripId);
    assert.equal(event.aggregate_version, event.payload.tripVersion);
    assert.equal(event.payload.amount, '41000');
  });

  await t.test('API-18 returns the same trip for the same key, also concurrently', async () => {
    const passengerId = randomUUID();
    const quote = await createQuote(passengerId);
    const key = randomUUID();
    const first = await postTrip(passengerId, quote.id, key);
    const second = await postTrip(passengerId, quote.id, key);

    assert.equal(second.status, 201);
    assert.deepEqual(second.body, first.body);

    const otherQuote = await createQuote(passengerId);
    const otherKey = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postTrip(passengerId, otherQuote.id, otherKey)),
    );

    for (const result of results) {
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.deepEqual(result.body, results[0].body);
    }

    assert.equal(await count('trips', 'quote_id = $1', [otherQuote.id]), 1);
    await eventually(() =>
      assert.equal(eventsFor('matching.events', results[0].body.id).length, 1),
    );
    await sleep(1000);
    assert.equal(eventsFor('matching.events', results[0].body.id).length, 1);
  });

  await t.test('API-18 rejects a changed body and a reused quote', async () => {
    const passengerId = randomUUID();
    const quote = await createQuote(passengerId);
    const key = randomUUID();

    assert.equal((await postTrip(passengerId, quote.id, key)).status, 201);

    const other = await createQuote(passengerId);
    const conflict = await postTrip(passengerId, other.id, key);

    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');

    const reused = await postTrip(passengerId, quote.id);

    assert.equal(reused.status, 409);
    assert.equal(reused.body.code, 'QUOTE_ALREADY_USED');

    const raced = await createQuote(passengerId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postTrip(passengerId, raced.id)),
    );

    assert.equal(results.filter(result => result.status === 201).length, 1);

    for (const result of results.filter(item => item.status !== 201)) {
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.code, 'QUOTE_ALREADY_USED');
    }

    assert.equal(await count('trips', 'quote_id = $1', [raced.id]), 1);
  });

  await t.test('API-18 validates input, role and the quote', async () => {
    const passengerId = randomUUID();
    const quote = await createQuote(passengerId);

    const priced = await postTrip(passengerId, quote.id, randomUUID(), { amount: '1' });

    assert.equal(priced.status, 400);

    const noKey = await call('/api/v1/trips', {
      method: 'POST',
      body: { quoteId: quote.id },
      headers: auth(passengerId),
    });

    assert.equal(noKey.status, 400);

    const driver = await call('/api/v1/trips', {
      method: 'POST',
      body: { quoteId: quote.id },
      headers: { ...auth(randomUUID(), 'DRIVER'), 'Idempotency-Key': randomUUID() },
    });

    assert.equal(driver.status, 403);

    const noToken = await call('/api/v1/trips', {
      method: 'POST',
      body: { quoteId: quote.id },
      headers: { 'Idempotency-Key': randomUUID() },
    });

    assert.equal(noToken.status, 401);

    const foreign = await postTrip(randomUUID(), quote.id);

    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, 'RESOURCE_FORBIDDEN');

    const missing = await postTrip(passengerId, randomUUID());

    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'QUOTE_NOT_FOUND');

    await pricingDb.query(
      `UPDATE pricing_schema.quotes
          SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
        WHERE id = $1`,
      [quote.id],
    );

    const expired = await postTrip(passengerId, quote.id);

    assert.equal(expired.status, 409);
    assert.equal(expired.body.code, 'QUOTE_EXPIRED');
    assert.equal(await count('trips', 'quote_id = $1', [quote.id]), 0);
  });

  await t.test('API-19 pages without gaps and filters by actor', async () => {
    const passengerId = randomUUID();
    const driverId = randomUUID();
    const sameTime = '2026-10-31T01:02:03.123456Z';
    const seeded = [];

    for (let index = 0; index < 5; index++) {
      seeded.push(await seedTrip({ passengerId, createdAt: sameTime }));
    }

    const assigned = await seedTrip({
      passengerId,
      createdAt: '2026-10-31T01:02:03.123400Z',
      status: 'ASSIGNED',
      driverId,
      assignmentId: randomUUID(),
    });

    const headers = auth(passengerId);
    const seen = [];
    let cursor;

    for (let page = 0; page < 3; page++) {
      const result = await call(
        '/api/v1/trips?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        { headers },
      );

      assert.equal(result.status, 200, JSON.stringify(result.body));
      seen.push(...result.body.items.map(item => item.id));
      cursor = result.body.nextCursor;
      assert.equal(result.body.items.length, 2);

      for (const item of result.body.items) {
        assert.ok(validTrip(item), JSON.stringify(validTrip.errors));
      }
    }

    assert.equal(cursor, undefined);
    assert.equal(new Set(seen).size, 6);
    assert.equal(seen.at(-1), assigned.id);

    for (const row of seeded) {
      assert.ok(seen.includes(row.id));
    }

    const driver = await call('/api/v1/trips', { headers: auth(driverId, 'DRIVER') });

    assert.equal(driver.status, 200);
    assert.deepEqual(driver.body.items.map(item => item.id), [assigned.id]);

    const stranger = await call('/api/v1/trips', { headers: auth(randomUUID()) });

    assert.deepEqual(stranger.body, { items: [] });

    const broken = await call('/api/v1/trips?cursor=not-a-cursor', { headers });

    assert.equal(broken.status, 400);
    assert.equal(broken.body.code, 'INVALID_CURSOR');

    for (const limit of ['0', '101', 'x']) {
      assert.equal((await call('/api/v1/trips?limit=' + limit, { headers })).status, 400);
    }
  });

  await t.test('API-20 enforces owner, assigned driver and operation progress', async () => {
    const passengerId = randomUUID();
    const assignedDriver = randomUUID();
    const assignmentId = randomUUID();
    const trip = await seedTrip({
      passengerId,
      status: 'ASSIGNED',
      driverId: assignedDriver,
      assignmentId,
    });
    const read = (userId, role) => call('/api/v1/trips/' + trip.id, { headers: auth(userId, role) });

    const owner = await read(passengerId);

    assert.equal(owner.status, 200);
    assert.equal(owner.body.driverId, assignedDriver);
    assert.ok(validTrip(owner.body), JSON.stringify(validTrip.errors));
    assert.equal((await read(assignedDriver, 'DRIVER')).body.assignmentId, assignmentId);
    assert.equal((await read(randomUUID())).status, 403);
    assert.equal((await read(randomUUID(), 'DRIVER')).status, 403);

    for (const status of ['PENDING', 'RUNNING', 'FAILED_NEEDS_REVIEW']) {
      const driverId = randomUUID();

      await seedOperation(trip.id, driverId, status);

      const progress = await read(driverId, 'DRIVER');

      assert.equal(progress.status, 200, status);
      assert.ok(validTrip(progress.body), JSON.stringify(validTrip.errors));
      assert.equal(progress.body.status, 'ASSIGNED');

      for (const field of ['driverId', 'assignmentId', 'paymentId']) {
        assert.equal(field in progress.body, false, field);
      }
    }

    const compensated = randomUUID();

    await seedOperation(trip.id, compensated, 'FAILED_COMPENSATED');
    assert.equal((await read(compensated, 'DRIVER')).status, 403);

    const missing = await call('/api/v1/trips/' + randomUUID(), { headers: auth(passengerId) });

    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'TRIP_NOT_FOUND');
    assert.equal((await call('/api/v1/trips/not-a-uuid', { headers: auth(passengerId) })).status, 400);
  });

  await t.test('API-26 returns operations to the actor and the owner only', async () => {
    const passengerId = randomUUID();
    const driverId = randomUUID();
    const assignmentId = randomUUID();
    const trip = await seedTrip({ passengerId, status: 'ASSIGNING', assignmentId });
    const operationId = await seedOperation(trip.id, driverId, 'FAILED_NEEDS_REVIEW', {
      assignmentId,
      errorCode: 'DRIVER_UNAVAILABLE',
    });
    const read = (userId, role) =>
      call('/api/v1/operations/' + operationId, { headers: auth(userId, role) });

    const actor = await read(driverId, 'DRIVER');

    assert.equal(actor.status, 200, JSON.stringify(actor.body));
    assert.deepEqual(Object.keys(actor.body).sort(), [
      'assignmentId',
      'errorCode',
      'id',
      'status',
      'tripId',
      'tripStatus',
      'type',
      'updatedAt',
    ]);
    assert.equal(actor.body.tripStatus, 'ASSIGNING');
    assert.equal(actor.body.errorCode, 'DRIVER_UNAVAILABLE');
    assert.equal((await read(passengerId)).status, 200);
    assert.equal((await read(randomUUID(), 'DRIVER')).status, 403);

    const missing = await call('/api/v1/operations/' + randomUUID(), { headers: auth(driverId, 'DRIVER') });

    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'OPERATION_NOT_FOUND');
  });

  await t.test('API-27 is limited to allowed services and matches the Matching schema', async () => {
    const trip = await createTrip();
    const read = (value, id = trip.id) =>
      call('/internal/v1/trips/' + id, { headers: value ? { 'X-Service-Token': value } : {} });

    for (const value of [tokens.matchingTrip, tokens.driverTrip, tokens.paymentTrip]) {
      const result = await read(value);

      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(validTrip(result.body), JSON.stringify(validTrip.errors));
      assert.equal(result.body.id, trip.id);
    }

    assert.equal((await read(undefined)).status, 401);
    assert.equal((await read(serviceToken())).status, 401);
    assert.equal((await read(tokens.opsTrip)).status, 403);

    const missing = await read(tokens.matchingTrip, randomUUID());

    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'TRIP_NOT_FOUND');
  });

  await t.test('matching.failed moves a confirmed trip to NO_DRIVER exactly once', async () => {
    const trip = await createTrip();
    const jobId = randomUUID();

    jobs.set(trip.id, () => failedJob(trip.id, jobId));

    const event = await publish(failedEvent(trip.id, jobId));

    await eventually(() => assert.equal(eventsFor('notification.events', trip.id).length, 1));

    const { event: noDriver } = eventsFor('notification.events', trip.id)[0];

    assert.equal(noDriver.type, 'trip.no_driver');
    assert.equal(noDriver.aggregate_id, trip.id);
    assert.equal(noDriver.aggregate_version, 2);
    assert.deepEqual(noDriver.payload, {
      tripId: trip.id,
      passengerId: trip.passengerId,
      tripVersion: 2,
      reason: 'NO_CANDIDATE',
    });
    assert.equal(noDriver.correlation_id, event.correlation_id);
    assert.equal(noDriver.causation_id, event.event_id);

    const row = await tripRow(trip.id);

    assert.equal(row.status, 'NO_DRIVER');
    assert.equal(row.version, 2);

    const history = (
      await db.query('SELECT * FROM trip_schema.state_history WHERE trip_id = $1 ORDER BY occurred_at', [trip.id])
    ).rows;

    assert.deepEqual(history.map(item => [item.from_status, item.to_status]), [
      [null, 'MATCHING'],
      ['MATCHING', 'NO_DRIVER'],
    ]);
    assert.equal(history[1].actor_id, null);
    assert.equal(history[1].command_id, event.event_id);
    assert.equal(jobCalls.get(trip.id), 1);

    await publish(event);
    await publish(failedEvent(trip.id, jobId));
    await sleep(1500);

    assert.equal(await count('state_history', 'trip_id = $1', [trip.id]), 2);
    assert.equal(await count('outbox_events', "aggregate_id = $1 AND type = 'trip.no_driver'", [trip.id]), 1);
    assert.equal(await processed(event.event_id), 1);
    assert.equal(eventsFor('notification.events', trip.id).length, 1);
    assert.equal(jobCalls.get(trip.id), 1);
  });

  await t.test('matching.failed is ignored when the trip already moved on', async () => {
    const trip = await seedTrip({
      status: 'ASSIGNED',
      driverId: randomUUID(),
      assignmentId: randomUUID(),
    });
    const event = await publish(failedEvent(trip.id));

    await eventually(async () => assert.equal(await processed(event.event_id), 1));
    assert.equal((await tripRow(trip.id)).status, 'ASSIGNED');
    assert.equal(jobCalls.get(trip.id), undefined);

    const assigning = await seedTrip({ status: 'ASSIGNING' });
    const second = await publish(failedEvent(assigning.id));

    await eventually(async () => assert.equal(await processed(second.event_id), 1));
    assert.equal((await tripRow(assigning.id)).status, 'ASSIGNING');
    assert.equal(jobCalls.get(assigning.id), undefined);
  });

  await t.test('matching.failed is dropped when the job has not failed', async () => {
    for (const status of ['SEARCHING', 'OFFERING', 'CLAIMED', 'CANCELLED']) {
      const trip = await createTrip();
      const jobId = randomUUID();

      jobs.set(trip.id, () => failedJob(trip.id, jobId, status));

      const event = await publish(failedEvent(trip.id, jobId));

      await eventually(async () => assert.equal(await processed(event.event_id), 1));

      const row = await tripRow(trip.id);

      assert.equal(row.status, 'MATCHING', status);
      assert.equal(row.version, 1);
      assert.equal(await count('outbox_events', "aggregate_id = $1 AND type = 'trip.no_driver'", [trip.id]), 0);
    }

    const older = await createTrip();
    const jobId = randomUUID();

    jobs.set(older.id, () => ({
      status: 200,
      body: { id: jobId, tripId: older.id, status: 'FAILED', version: 1 },
    }));

    const event = await publish(failedEvent(older.id, jobId));

    await eventually(async () => assert.equal(await processed(event.event_id), 1));
    assert.equal((await tripRow(older.id)).status, 'MATCHING');
  });

  await t.test('matching.failed loses the race against a trip that changed during reconciliation', async () => {
    const trip = await createTrip();
    const jobId = randomUUID();

    jobs.set(trip.id, async () => {
      await db.appQuery("UPDATE trip_schema.trips SET status = 'ASSIGNING' WHERE id = $1", [trip.id]);

      return failedJob(trip.id, jobId);
    });

    const event = await publish(failedEvent(trip.id, jobId));

    await eventually(async () => assert.equal(await processed(event.event_id), 1));
    assert.equal((await tripRow(trip.id)).status, 'ASSIGNING');
    assert.equal(await count('outbox_events', "aggregate_id = $1 AND type = 'trip.no_driver'", [trip.id]), 0);
    assert.equal(await count('state_history', 'trip_id = $1', [trip.id]), 1);
  });

  await t.test('invalid matching.failed events go to the DLQ with a clear code', async () => {
    const dlqCode = eventId => {
      const item = received['trip.events.dlq'].find(entry => entry.event.event_id === eventId);

      assert.ok(item, 'event not in DLQ yet');

      return item.headers['x-error-code'];
    };

    const unknown = await publish(failedEvent(randomUUID()));

    await eventually(() => assert.equal(dlqCode(unknown.event_id), 'TRIP_NOT_FOUND'));

    const noJob = await createTrip();
    const missing = await publish(failedEvent(noJob.id));

    await eventually(() => assert.equal(dlqCode(missing.event_id), 'JOB_NOT_FOUND'));
    assert.equal((await tripRow(noJob.id)).status, 'MATCHING');

    const otherJob = await createTrip();

    jobs.set(otherJob.id, () => failedJob(otherJob.id, randomUUID()));

    const mismatch = await publish(failedEvent(otherJob.id));

    await eventually(() => assert.equal(dlqCode(mismatch.event_id), 'JOB_MISMATCH'));
    assert.equal((await tripRow(otherJob.id)).status, 'MATCHING');
    assert.equal(await processed(mismatch.event_id), 0);

    const wrongAggregate = await createTrip();
    const jobId = randomUUID();
    const badAggregate = await publish({
      ...failedEvent(wrongAggregate.id, jobId),
      aggregate_id: randomUUID(),
    });

    await eventually(() => assert.equal(dlqCode(badAggregate.event_id), 'INVALID_EVENT'));

    const paymentId = randomUUID();
    const payment = await publish(
      envelope('payment.succeeded', paymentId, {
        paymentId,
        tripId: randomUUID(),
        passengerId: randomUUID(),
        amount: '41000',
        currency: 'VND',
        attemptNo: 1,
        paymentVersion: 2,
      }),
    );

    await eventually(() => assert.equal(dlqCode(payment.event_id), 'UNHANDLED_EVENT_TYPE'));
  });

  await t.test('API-29 failures are retried, then the event goes to the DLQ', async () => {
    const trip = await createTrip();
    const jobId = randomUUID();

    jobs.set(trip.id, calls =>
      calls <= 3 ? { status: 503, body: { code: 'DEPENDENCY_UNAVAILABLE' } } : failedJob(trip.id, jobId),
    );
    await publish(failedEvent(trip.id, jobId));

    await eventually(async () => assert.equal((await tripRow(trip.id)).status, 'NO_DRIVER'));
    assert.equal(jobCalls.get(trip.id), 4);

    const stuck = await createTrip();

    jobs.set(stuck.id, () => ({ status: 503, body: { code: 'DEPENDENCY_UNAVAILABLE' } }));

    const event = await publish(failedEvent(stuck.id));

    await eventually(() => {
      const item = received['trip.events.dlq'].find(entry => entry.event.event_id === event.event_id);

      assert.ok(item, 'event not in DLQ yet');
      assert.equal(item.headers['x-error-code'], 'RETRIES_EXHAUSTED');
    }, 90000);
    assert.equal((await tripRow(stuck.id)).status, 'MATCHING');
    assert.equal(await processed(event.event_id), 0);
  });

  await t.test('outbox keeps the event while RabbitMQ is down and sends it afterwards', async () => {
    docker(['stop', broker.name]);

    let trip;

    try {
      await eventually(async () => {
        const ready = await fetch(origin + '/health/ready', { signal: AbortSignal.timeout(3000) });

        assert.notEqual(ready.status, 200);
      }, 30000);

      trip = await createTrip();

      const pending = await db.query('SELECT status FROM trip_schema.outbox_events WHERE aggregate_id = $1', [
        trip.id,
      ]);

      assert.deepEqual(pending.rows.map(row => row.status), ['PENDING']);
    } finally {
      docker(['start', broker.name]);
    }

    await eventually(async () => {
      const outbox = await db.query('SELECT status FROM trip_schema.outbox_events WHERE aggregate_id = $1', [
        trip.id,
      ]);

      assert.deepEqual(outbox.rows.map(row => row.status), ['PUBLISHED']);
    }, 120000);

    await eventually(() => connectMonitor(), 60000);
    await eventually(() => assert.equal(eventsFor('matching.events', trip.id).length, 1));
  });

  await t.test('a completed key still answers while Pricing is down', async () => {
    const passengerId = randomUUID();
    const quote = await createQuote(passengerId);
    const key = randomUUID();
    const first = await postTrip(passengerId, quote.id, key);
    const spare = await createQuote(passengerId);

    assert.equal(first.status, 201);
    await stop(pricingApp);

    const replay = await postTrip(passengerId, quote.id, key);

    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, first.body);

    const conflict = await postTrip(passengerId, spare.id, key);

    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');

    const unavailable = await postTrip(passengerId, spare.id);

    assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
    assert.equal(unavailable.body.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(await count('trips', 'quote_id = $1', [spare.id]), 0);
  });
});
