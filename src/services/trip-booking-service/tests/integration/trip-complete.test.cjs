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
const { createCEnvironment } = require('../../../../../tests/helpers/c-environment.cjs');
const {
  eventually,
  healthy,
  port,
  start,
  stop,
} = require('../../../../../tests/helpers/identity-environment.cjs');
const { createTripDatabase } = require('../../../../../tests/helpers/trip-environment.cjs');

const POINT = JSON.stringify({ lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' });
const UNAVAILABLE = { status: 503, body: { code: 'DEPENDENCY_UNAVAILABLE' } };
const TERMINAL = ['SUCCEEDED', 'FAILED_COMPENSATED', 'FAILED_NEEDS_REVIEW'];

test('Start, complete and payment with real Payment, Notification and RabbitMQ', { timeout: 540000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds03-complete-test-'));
  let tripApp, environment, monitorConnection, server;

  t.after(async () => {
    if (tripApp) await stop(tripApp);
    await monitorConnection?.close().catch(() => {});
    if (environment) await environment.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }

    const resolved = path.resolve(directory);

    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('ds03-complete-test-')
    ) {
      throw new Error('Unsafe temporary cleanup target');
    }

    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const db = await createTripDatabase(t);

  environment = await createCEnvironment({ prefix: 'ds03-trip-complete' });
  await environment.startApp('payment');
  await environment.startApp('notification');

  generateKeys(directory);
  const privateKey = fs.readFileSync(path.join(directory, 'identity-private.pem'));
  const jwt = new JwtService({});
  const token = (userId, role = 'DRIVER') =>
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
  const driverToken = randomBytes(32).toString('base64url');
  const paymentToken = randomBytes(32).toString('base64url');
  const releases = [];
  const scripts = new Map();
  const paymentReplies = new Map();
  const paymentCalls = [];

  server = http.createServer(async (req, res) => {
    let raw = '';

    for await (const chunk of req) raw += chunk;

    const send = reply =>
      res
        .writeHead(reply.status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(reply.body));
    const id = req.url.split('/')[4];

    if (req.url.startsWith('/internal/v1/payments/') && req.headers['x-service-token'] === paymentToken) {
      paymentCalls.push(id);
      send(paymentReplies.get(id) ?? { status: 404, body: { code: 'PAYMENT_NOT_FOUND' } });

      return;
    }

    if (!req.url.endsWith('/release') || req.headers['x-service-token'] !== driverToken) {
      send({ status: 403, body: { code: 'INTERNAL_CALLER_FORBIDDEN' } });

      return;
    }

    const body = JSON.parse(raw);

    releases.push({ id, ...body });

    const script = scripts.get(body.tripId);
    const entry = Array.isArray(script) ? script.shift() : script?.always;
    const reply = typeof entry === 'function' ? await entry() : entry;

    send(
      reply ?? {
        status: 200,
        body: { id, tripId: body.tripId, driverId: body.driverId, status: 'RELEASED', version: 3 },
      },
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const tripPort = await port();
  const origin = 'http://127.0.0.1:' + tripPort;

  async function launchTrip(appPort = tripPort) {
    const app = start('trip-booking-service', {
      ...db.env,
      RABBITMQ_URL: environment.rabbitUrl,
      JWT_PUBLIC_KEY: '',
      JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
      JWT_ISSUER: 'ride-hailing',
      JWT_AUDIENCE: 'ride-api',
      TRIP_PORT: String(appPort),
      DRIVER_BASE_URL: 'http://127.0.0.1:' + server.address().port,
      SVC_TOKEN_TRIP_DRIVER: driverToken,
      PAYMENT_BASE_URL: 'http://127.0.0.1:' + server.address().port,
      SVC_TOKEN_TRIP_PAYMENT: paymentToken,
      TRIP_PAYMENT_RECONCILE_INTERVAL_MS: '300',
    });

    await healthy(app, 'http://127.0.0.1:' + appPort).catch(error => {
      throw new Error(error.message + '\n' + app.logs);
    });

    return app;
  }

  tripApp = await launchTrip();

  const deadLetters = [];

  monitorConnection = await amqp.connect(environment.rabbitUrl);
  monitorConnection.on('error', () => {});

  const publisher = await monitorConnection.createConfirmChannel();
  const monitor = await monitorConnection.createChannel();

  await monitor.consume('trip.events.dlq', message => {
    if (message) {
      deadLetters.push({
        event: JSON.parse(message.content.toString()),
        code: message.properties.headers?.['x-error-code'],
      });
      monitor.ack(message);
    }
  });

  async function seedTrip(status, fields = {}) {
    const row = {
      id: randomUUID(),
      passengerId: randomUUID(),
      driverId: randomUUID(),
      assignmentId: randomUUID(),
      paymentId: null,
      paymentStatus: 'NOT_REQUESTED',
      ...fields,
    };

    await db.appQuery(
      `INSERT INTO trip_schema.trips
         (id, passenger_id, driver_id, quote_id, assignment_id, pickup, dropoff, status, payment_id, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $6::jsonb, $7, $8, $9)`,
      [
        row.id,
        row.passengerId,
        row.driverId,
        randomUUID(),
        row.assignmentId,
        POINT,
        status,
        row.paymentId,
        row.paymentStatus,
      ],
    );
    await db.appQuery(
      `INSERT INTO trip_schema.fare_snapshots (trip_id, amount, rule_version, distance_meters, duration_seconds)
       VALUES ($1, 41000, 'CAR_V1', 3000, 600)`,
      [row.id],
    );

    return row;
  }

  async function command(action, tripId, driverId, { key = randomUUID(), body = {}, role, omitKey } = {}) {
    const response = await fetch(origin + '/api/v1/trips/' + tripId + '/' + action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token(driverId, role),
        ...(omitKey ? {} : { 'Idempotency-Key': key }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    return { status: response.status, body: await response.json() };
  }

  async function finished(operationId, driverId, timeout = 30000) {
    return eventually(async () => {
      const response = await fetch(origin + '/api/v1/operations/' + operationId, {
        headers: { Authorization: 'Bearer ' + token(driverId) },
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.json();

      assert.equal(response.status, 200, JSON.stringify(body));
      assert.ok(TERMINAL.includes(body.status), 'still ' + body.status);

      return body;
    }, timeout);
  }

  const tripRow = async id =>
    (await db.query('SELECT * FROM trip_schema.trips WHERE id = $1', [id])).rows[0];
  const outbox = async (tripId, type) =>
    (
      await db.query(
        'SELECT event_id, status, envelope_json, next_retry_at FROM trip_schema.outbox_events WHERE aggregate_id = $1 AND type = $2 ORDER BY created_at',
        [tripId, type],
      )
    ).rows;
  const paymentRows = async paymentId =>
    environment.sql('payment', 'SELECT * FROM payment_schema.payments WHERE id = $1', [paymentId]);
  const attemptRows = async paymentId =>
    environment.sql(
      'payment',
      'SELECT * FROM payment_schema.payment_attempts WHERE payment_id = $1 ORDER BY attempt_no',
      [paymentId],
    );
  const releasesOf = tripId => releases.filter(item => item.tripId === tripId);

  async function completeTrip(fields) {
    const trip = await seedTrip('IN_PROGRESS', fields);
    const result = await command('complete', trip.id, trip.driverId);

    assert.equal(result.status, 202, JSON.stringify(result.body));

    return { trip, operation: result.body };
  }

  async function switchPayment(mode) {
    await environment.killApp('payment');
    await environment.startApp('payment', { PAYMENT_SIMULATION_MODE: mode });
  }

  await t.test('API-24 starts only the assigned trip of the assigned driver', async () => {
    const trip = await seedTrip('ASSIGNED');
    const key = randomUUID();
    const result = await command('start', trip.id, trip.driverId, { key });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'IN_PROGRESS');
    assert.equal(result.body.driverId, trip.driverId);
    assert.equal(result.body.amount, '41000');
    assert.equal(result.body.version, 2);
    assert.equal('paymentAttemptNo' in result.body, false);

    const replay = await command('start', trip.id, trip.driverId, { key });

    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, result.body);

    const again = await command('start', trip.id, trip.driverId);

    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'INVALID_STATE');

    await eventually(async () => {
      const events = await outbox(trip.id, 'trip.started');

      assert.equal(events.length, 1);
      assert.equal(events[0].status, 'PUBLISHED');
      assert.equal(events[0].envelope_json.payload.tripVersion, 2);
      assert.equal(events[0].envelope_json.payload.status, 'IN_PROGRESS');
    });
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM trip_schema.state_history WHERE trip_id = $1', [trip.id])).rows[0].n,
      1,
    );

    await eventually(async () => {
      const notices = await environment.sql(
        'notification',
        "SELECT recipient_id FROM notification_schema.notifications WHERE trip_id = $1 AND type = 'TRIP_STATUS'",
        [trip.id],
      );

      assert.deepEqual(notices.map(row => row.recipient_id).sort(), [trip.driverId, trip.passengerId].sort());
    });
  });

  await t.test('API-24 and API-25 reject the wrong actor, state and input', async () => {
    const assigned = await seedTrip('ASSIGNED');
    const running = await seedTrip('IN_PROGRESS');

    for (const [action, trip] of [
      ['start', assigned],
      ['complete', running],
    ]) {
      const foreign = await command(action, trip.id, randomUUID());

      assert.equal(foreign.status, 403, action);
      assert.equal(foreign.body.code, 'RESOURCE_FORBIDDEN');
      assert.equal((await command(action, trip.id, trip.passengerId, { role: 'PASSENGER' })).status, 403);
      assert.equal((await command(action, trip.id, trip.driverId, { body: { driverId: randomUUID() } })).status, 400);
      assert.equal((await command(action, trip.id, trip.driverId, { omitKey: true })).status, 400);

      const missing = await command(action, randomUUID(), trip.driverId);

      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, 'TRIP_NOT_FOUND');
    }

    assert.equal((await command('start', running.id, running.driverId)).body.code, 'INVALID_STATE');
    assert.equal((await command('complete', assigned.id, assigned.driverId)).body.code, 'INVALID_STATE');
    assert.equal((await tripRow(assigned.id)).status, 'ASSIGNED');
    assert.equal((await tripRow(running.id)).status, 'IN_PROGRESS');

    const noBody = await fetch(origin + '/api/v1/trips/' + assigned.id + '/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token(assigned.driverId),
        'Idempotency-Key': randomUUID(),
      },
      signal: AbortSignal.timeout(15000),
    });

    assert.equal(noBody.status, 200, await noBody.clone().text());
  });

  await t.test('API-25 completes once, releases the driver, then requests payment', async () => {
    const trip = await seedTrip('IN_PROGRESS');
    let requestedAtRelease;

    scripts.set(trip.id, [
      async () => {
        requestedAtRelease = (await outbox(trip.id, 'payment.requested')).length;
      },
    ]);

    const key = randomUUID();
    const result = await command('complete', trip.id, trip.driverId, { key });

    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.type, 'COMPLETE');
    assert.equal(result.body.status, 'PENDING');
    assert.equal(result.body.tripStatus, 'COMPLETED');
    assert.equal(result.body.assignmentId, trip.assignmentId);
    assert.deepEqual((await command('complete', trip.id, trip.driverId, { key })).body, result.body);

    const row = await tripRow(trip.id);

    assert.equal(row.status, 'COMPLETED');
    assert.ok(row.payment_id);

    const final = await finished(result.body.id, trip.driverId);

    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(requestedAtRelease, 0);

    const [release] = releasesOf(trip.id);

    assert.equal(release.id, trip.assignmentId);
    assert.equal(release.reason, 'TRIP_COMPLETED');
    assert.equal(release.driverId, trip.driverId);

    const requests = await outbox(trip.id, 'payment.requested');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'PUBLISHED');
    assert.deepEqual(requests[0].envelope_json.payload, {
      paymentId: row.payment_id,
      tripId: trip.id,
      passengerId: trip.passengerId,
      amount: '41000',
      currency: 'VND',
      attemptNo: 1,
    });
    assert.equal(requests[0].envelope_json.aggregate_id, trip.id);
    assert.equal((await outbox(trip.id, 'trip.completed')).length, 1);

    await eventually(async () => {
      const paid = await tripRow(trip.id);

      assert.equal(paid.payment_status, 'SUCCEEDED');
      assert.equal(paid.status, 'COMPLETED');
      assert.equal(paid.payment_attempt_no, 1);
      assert.ok(paid.version > row.version);
    });

    assert.equal((await paymentRows(row.payment_id)).length, 1);
    assert.equal((await attemptRows(row.payment_id)).length, 1);

    await eventually(async () => {
      const notices = await environment.sql(
        'notification',
        'SELECT type, recipient_id FROM notification_schema.notifications WHERE trip_id = $1',
        [trip.id],
      );

      assert.ok(notices.some(item => item.type === 'PAYMENT_STATUS' && item.recipient_id === trip.passengerId));
      assert.ok(notices.some(item => item.type === 'TRIP_STATUS' && item.recipient_id === trip.driverId));
    });
  });

  await t.test('two concurrent completes create one operation and one payment', async () => {
    const trip = await seedTrip('IN_PROGRESS');
    const results = await Promise.all([1, 2].map(() => command('complete', trip.id, trip.driverId)));

    assert.deepEqual(results.map(result => result.status).sort(), [202, 409]);

    const winner = results.find(result => result.status === 202);

    assert.equal((await finished(winner.body.id, trip.driverId)).status, 'SUCCEEDED');
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM trip_schema.operations WHERE trip_id = $1', [trip.id])).rows[0].n,
      1,
    );
    assert.equal((await outbox(trip.id, 'payment.requested')).length, 1);
  });

  await t.test('a temporary Driver failure retries with the same command', async () => {
    const { trip, operation } = await completeTrip({});

    scripts.set(trip.id, [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);

    const final = await finished(operation.id, trip.driverId, 60000);

    assert.equal(final.status, 'SUCCEEDED');

    const seen = releasesOf(trip.id);

    assert.ok(seen.length >= 1);
    assert.equal(new Set(seen.map(item => item.commandId)).size, 1);
    assert.equal((await outbox(trip.id, 'payment.requested')).length, 1);
  });

  await t.test('a failed release needs review and does not request payment', async () => {
    const refused = await seedTrip('IN_PROGRESS');

    scripts.set(refused.id, [{ status: 409, body: { code: 'PAYLOAD_MISMATCH' } }]);

    const down = await seedTrip('IN_PROGRESS');

    scripts.set(down.id, { always: UNAVAILABLE });

    const [first, second] = await Promise.all(
      [refused, down].map(async trip => {
        const result = await command('complete', trip.id, trip.driverId);

        return finished(result.body.id, trip.driverId, 120000);
      }),
    );

    assert.equal(first.status, 'FAILED_NEEDS_REVIEW');
    assert.equal(first.errorCode, 'PAYLOAD_MISMATCH');
    assert.equal(second.status, 'FAILED_NEEDS_REVIEW');
    assert.equal(second.errorCode, 'DEPENDENCY_UNAVAILABLE');

    for (const trip of [refused, down]) {
      const row = await tripRow(trip.id);

      assert.equal(row.status, 'COMPLETED');
      assert.equal(row.payment_status, 'PENDING');
      assert.equal((await outbox(trip.id, 'payment.requested')).length, 0);
      assert.equal((await paymentRows(row.payment_id)).length, 0);
    }
  });

  await t.test('a killed Trip resumes the release and requests payment once', async () => {
    const trip = await seedTrip('IN_PROGRESS');

    scripts.set(trip.id, [
      async () => {
        tripApp.child.kill('SIGKILL');
        await once(tripApp.child, 'exit');

        return UNAVAILABLE;
      },
    ]);

    const result = await command('complete', trip.id, trip.driverId);

    await eventually(() => assert.notEqual(tripApp.child.exitCode ?? tripApp.child.signalCode, null));

    tripApp = await launchTrip();

    assert.equal((await finished(result.body.id, trip.driverId, 60000)).status, 'SUCCEEDED');
    assert.equal(new Set(releasesOf(trip.id).map(item => item.commandId)).size, 1);
    assert.equal((await outbox(trip.id, 'payment.requested')).length, 1);
  });

  await t.test('FAIL_ONCE retries after 5 seconds with the same paymentId', async () => {
    await switchPayment('FAIL_ONCE');

    const { trip } = await completeTrip({});
    const { payment_id: paymentId } = await tripRow(trip.id);

    await eventually(async () => assert.equal((await tripRow(trip.id)).payment_status, 'PENDING_RETRY'));
    assert.equal((await tripRow(trip.id)).status, 'COMPLETED');

    await eventually(async () => assert.equal((await tripRow(trip.id)).payment_status, 'SUCCEEDED'));

    const attempts = await attemptRows(paymentId);

    assert.deepEqual(attempts.map(item => item.attempt_no), [1, 2]);
    assert.deepEqual(attempts.map(item => item.result), ['TEMPORARY_FAILURE', 'SUCCESS']);
    assert.ok(attempts[1].created_at - attempts[0].created_at >= 4500);
    assert.equal((await paymentRows(paymentId)).length, 1);

    const requests = await outbox(trip.id, 'payment.requested');

    assert.deepEqual(requests.map(item => item.envelope_json.payload.attemptNo), [1, 2]);
    assert.deepEqual([...new Set(requests.map(item => item.envelope_json.payload.paymentId))], [paymentId]);

    const row = await tripRow(trip.id);

    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.payment_attempt_no, 2);
  });

  await t.test('TEMPORARY stops after three attempts and keeps the trip completed', async () => {
    await switchPayment('TEMPORARY');

    const { trip } = await completeTrip({});
    const { payment_id: paymentId } = await tripRow(trip.id);

    await eventually(async () => assert.equal((await tripRow(trip.id)).payment_status, 'FAILED'), 60000);

    assert.equal((await attemptRows(paymentId)).length, 3);
    assert.equal((await outbox(trip.id, 'payment.requested')).length, 3);

    const row = await tripRow(trip.id);

    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.payment_attempt_no, 3);
  });

  await t.test('FINAL fails on the first attempt without a retry', async () => {
    await switchPayment('FINAL');

    const { trip } = await completeTrip({});
    const { payment_id: paymentId } = await tripRow(trip.id);

    await eventually(async () => assert.equal((await tripRow(trip.id)).payment_status, 'FAILED'));
    await sleep(1000);

    assert.equal((await attemptRows(paymentId)).length, 1);
    assert.equal((await outbox(trip.id, 'payment.requested')).length, 1);
    assert.equal((await tripRow(trip.id)).status, 'COMPLETED');
  });

  // Tắt Payment để các event tự gửi dưới đây không bị Payment thật trả lời thêm.
  await environment.killApp('payment');

  async function publishResult(type, trip, fields, eventId = randomUUID()) {
    const paymentId = fields.paymentId ?? trip.paymentId;
    const paymentVersion = fields.paymentVersion;
    const event = {
      event_id: eventId,
      type,
      schema_version: 1,
      aggregate_id: paymentId,
      aggregate_version: paymentVersion,
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      causation_id: randomUUID(),
      producer: 'simulated-payment-service',
      payload:
        type === 'payment.succeeded'
          ? {
              paymentId,
              tripId: fields.tripId ?? trip.id,
              passengerId: trip.passengerId,
              amount: fields.amount ?? '41000',
              currency: 'VND',
              attemptNo: fields.attemptNo ?? 1,
              paymentVersion,
            }
          : {
              paymentId,
              tripId: fields.tripId ?? trip.id,
              passengerId: trip.passengerId,
              attemptNo: fields.attemptNo ?? 1,
              paymentVersion,
              retryable: fields.retryable ?? true,
              reason: 'SIMULATED_TEMPORARY_FAILURE',
            },
    };

    publisher.publish('ride.events', type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.event_id,
    });
    await publisher.waitForConfirms();

    return event;
  }

  const processed = async eventId =>
    (
      await db.query(
        "SELECT count(*)::int AS n FROM trip_schema.processed_events WHERE consumer_name = 'trip-booking-service' AND event_id = $1",
        [eventId],
      )
    ).rows[0].n;
  const seedPaying = () => seedTrip('COMPLETED', { paymentId: randomUUID(), paymentStatus: 'PENDING' });

  await t.test('an old failure after a success changes nothing, and neither does a duplicate', async () => {
    const trip = await seedPaying();
    const success = await publishResult('payment.succeeded', trip, { paymentVersion: 3, attemptNo: 2 });

    await eventually(async () => assert.equal((await tripRow(trip.id)).payment_status, 'SUCCEEDED'));

    const before = await tripRow(trip.id);
    const stale = await publishResult('payment.failed', trip, { paymentVersion: 2, attemptNo: 1 });

    await eventually(async () => assert.equal(await processed(stale.event_id), 1));
    await publishResult('payment.succeeded', trip, { paymentVersion: 3, attemptNo: 2 }, success.event_id);
    await sleep(1000);

    const after = await tripRow(trip.id);

    assert.equal(after.payment_status, 'SUCCEEDED');
    assert.equal(after.version, before.version);
    assert.equal(after.payment_version, 3);
    assert.equal((await outbox(trip.id, 'payment.requested')).length, 0);
  });

  await t.test('a retry is scheduled in the outbox, not sent immediately', async () => {
    const trip = await seedPaying();
    const failure = await publishResult('payment.failed', trip, { paymentVersion: 2, attemptNo: 1 });

    await eventually(async () => assert.equal(await processed(failure.event_id), 1));

    const row = await tripRow(trip.id);

    assert.equal(row.payment_status, 'PENDING_RETRY');
    assert.equal(row.payment_attempt_no, 2);
    assert.equal(row.payment_version, 2);

    const [retry] = await outbox(trip.id, 'payment.requested');

    assert.equal(retry.status, 'PENDING');
    assert.equal(retry.envelope_json.payload.attemptNo, 2);
    assert.equal(retry.envelope_json.causation_id, failure.event_id);
    assert.ok(new Date(retry.next_retry_at) > new Date(Date.now() + 2000));

    await eventually(async () => {
      assert.equal((await outbox(trip.id, 'payment.requested'))[0].status, 'PUBLISHED');
    });
  });

  await t.test('mismatched results go to the DLQ with a clear code', async () => {
    const code = eventId => {
      const item = deadLetters.find(entry => entry.event.event_id === eventId);

      assert.ok(item, 'event not in DLQ yet');

      return item.code;
    };
    const trip = await seedPaying();

    for (const [type, fields, expected] of [
      ['payment.succeeded', { paymentId: randomUUID(), paymentVersion: 2 }, 'PAYMENT_MISMATCH'],
      ['payment.succeeded', { amount: '1', paymentVersion: 2 }, 'PAYMENT_MISMATCH'],
      ['payment.failed', { paymentId: randomUUID(), paymentVersion: 2 }, 'PAYMENT_MISMATCH'],
      ['payment.succeeded', { tripId: randomUUID(), paymentVersion: 2 }, 'TRIP_NOT_FOUND'],
    ]) {
      const event = await publishResult(type, trip, fields);

      await eventually(() => assert.equal(code(event.event_id), expected));
      assert.equal(await processed(event.event_id), 0);
    }

    const running = await seedTrip('IN_PROGRESS');
    const early = await publishResult('payment.succeeded', { ...running, paymentId: randomUUID() }, {
      paymentVersion: 2,
    });

    await eventually(() => assert.equal(code(early.event_id), 'PAYMENT_MISMATCH'));

    const row = await tripRow(trip.id);

    assert.equal(row.payment_status, 'PENDING');
    assert.equal(row.version, 1);
  });

  // Đặt phản hồi trước khi lùi updated_at: worker có thể đọc ngay khi chuyến đủ điều kiện.
  const seedOverdue = async (fields = {}, reply) => {
    const trip = await seedPaying();

    if (reply !== null) {
      paymentReplies.set(
        trip.paymentId,
        reply ?? {
          status: 200,
          body: {
            id: trip.paymentId,
            tripId: trip.id,
            passengerId: trip.passengerId,
            amount: '41000',
            currency: 'VND',
            status: 'SUCCEEDED',
            attemptNo: 1,
            retryable: false,
            updatedAt: new Date().toISOString(),
            ...fields,
          },
        },
      );
    }

    await db.appQuery(
      "UPDATE trip_schema.trips SET updated_at = now() - interval '2 minutes' WHERE id = $1",
      [trip.id],
    );

    return trip;
  };
  const callsOf = paymentId => paymentCalls.filter(id => id === paymentId).length;

  await t.test('a trip waiting too long takes the final result from Payment', async () => {
    const paid = await seedOverdue();
    const failed = await seedOverdue({ status: 'FAILED', retryable: false });
    const exhausted = await seedOverdue({ status: 'FAILED', attemptNo: 3, retryable: true });

    await eventually(async () => {
      assert.equal((await tripRow(paid.id)).payment_status, 'SUCCEEDED');
      assert.equal((await tripRow(failed.id)).payment_status, 'FAILED');
      assert.equal((await tripRow(exhausted.id)).payment_status, 'FAILED');
    });

    const row = await tripRow(exhausted.id);

    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.version, 2);
    assert.equal(row.payment_version, 0);
    assert.equal(row.payment_attempt_no, 3);
    assert.equal((await outbox(exhausted.id, 'payment.requested')).length, 0);
  });

  // payment.failed bị mất: Payment báo lỗi tạm thời ở lần 1 thì Trip lên lịch lần 2, cùng paymentId.
  await t.test('a retryable failure found by reconciliation schedules the next attempt', async () => {
    const trip = await seedOverdue({ status: 'FAILED', attemptNo: 1, retryable: true });

    await eventually(async () =>
      assert.equal((await tripRow(trip.id)).payment_status, 'PENDING_RETRY'),
    );

    const row = await tripRow(trip.id);

    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.version, 2);
    assert.equal(row.payment_attempt_no, 2);

    const retries = await outbox(trip.id, 'payment.requested');

    assert.equal(retries.length, 1);
    assert.equal(retries[0].envelope_json.payload.paymentId, trip.paymentId);
    assert.equal(retries[0].envelope_json.payload.attemptNo, 2);
  });

  await t.test('a result that is not final or does not match leaves the trip waiting', async () => {
    const pending = await seedOverdue({ status: 'PENDING', attemptNo: 0, retryable: true });
    const missing = await seedOverdue({}, null);
    const down = await seedOverdue({}, UNAVAILABLE);
    const otherTrip = await seedOverdue({ tripId: randomUUID() });
    const otherAmount = await seedOverdue({ amount: '1' });
    const broken = await seedOverdue({}, { status: 200, body: { id: randomUUID() } });
    const trips = [pending, missing, down, otherTrip, otherAmount, broken];

    await eventually(() => {
      for (const trip of trips) {
        assert.ok(callsOf(trip.paymentId) >= 1, 'Payment not read yet for ' + trip.id);
      }
    }, 30000);

    for (const trip of trips) {
      const row = await tripRow(trip.id);

      assert.equal(row.payment_status, 'PENDING');
      assert.equal(row.version, 1);
    }
  });

  await t.test('a trip still inside the waiting time is not read', async () => {
    const trip = await seedPaying();

    await sleep(1500);
    assert.equal(callsOf(trip.paymentId), 0);
    assert.equal((await tripRow(trip.id)).payment_status, 'PENDING');
  });

  await t.test('a result event arriving after reconciliation changes nothing', async () => {
    const paid = await seedOverdue();
    const failed = await seedOverdue({ status: 'FAILED', retryable: false });

    await eventually(async () => {
      assert.equal((await tripRow(paid.id)).payment_status, 'SUCCEEDED');
      assert.equal((await tripRow(failed.id)).payment_status, 'FAILED');
    });

    const late = [
      await publishResult('payment.succeeded', paid, { paymentVersion: 2 }),
      await publishResult('payment.failed', failed, { paymentVersion: 2, retryable: true }),
    ];

    await eventually(async () => {
      for (const event of late) {
        assert.equal(await processed(event.event_id), 1);
      }
    });

    assert.equal((await tripRow(paid.id)).payment_status, 'SUCCEEDED');
    assert.equal((await tripRow(paid.id)).version, 2);
    assert.equal((await tripRow(failed.id)).payment_status, 'FAILED');
    assert.equal((await tripRow(failed.id)).version, 2);
    assert.equal((await outbox(failed.id, 'payment.requested')).length, 0);
  });

  await t.test('two Trip instances reconcile a trip once', async () => {
    const secondApp = await launchTrip(await port());

    try {
      const trips = [];

      for (let index = 0; index < 8; index += 1) {
        trips.push(await seedOverdue());
      }

      await eventually(async () => {
        for (const trip of trips) {
          assert.equal((await tripRow(trip.id)).payment_status, 'SUCCEEDED');
        }
      });

      for (const trip of trips) {
        assert.equal((await tripRow(trip.id)).version, 2);
      }
    } finally {
      await stop(secondApp);
    }
  });
});
