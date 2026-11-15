const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID, randomBytes } = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { Client } = require('pg');
const amqp = require('amqplib');
const {
  createMatchingDatabase,
  createMatchingBroker,
} = require('../../../../../tests/helpers/matching-environment.cjs');
const {
  start,
  stop,
  healthy,
  eventually,
  port,
  docker,
} = require('../../../../../tests/helpers/identity-environment.cjs');

test('Matching APIs, workers and real PostgreSQL/RabbitMQ', { timeout: 300000 }, async t => {
  let app, connection, publisher, monitor, server;

  t.after(async () => {
    if (app) await stop(app);
    await connection?.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve));
  });

  const db = await createMatchingDatabase(t);
  const broker = await createMatchingBroker(t);
  const tripToken = randomBytes(32).toString('base64url');
  const driverToken = randomBytes(32).toString('base64url');
  const lookupToken = randomBytes(32).toString('base64url');
  const otherToken = randomBytes(32).toString('base64url');
  const tripStates = new Map();
  const driverIds = Array.from({ length: 6 }, () => randomUUID()).sort();
  let roster = [...driverIds];
  let driverStatus = 200;
  let candidateGate;
  let driverCalls = 0;
  const events = [];

  server = http.createServer((req, res) => {
    const send = (status, body) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    if (req.url.startsWith('/internal/v1/drivers/candidates')) {
      assert.equal(req.headers['x-service-token'], driverToken);
      assert.ok(req.headers['x-correlation-id']);
      driverCalls++;
      const respond = () =>
        send(
          driverStatus,
          driverStatus === 200
            ? {
                items: roster.map(driverId => ({
                  driverId,
                  vehicleId: driverId,
                  zoneId: 'ZONE_A',
                  locationSequence: 1,
                  locationReceivedAt: new Date().toISOString(),
                })),
              }
            : { code: 'DEPENDENCY_UNAVAILABLE' },
        );

      if (candidateGate) candidateGate.then(respond);
      else respond();
    } else if (req.url.startsWith('/internal/v1/trips/')) {
      assert.equal(req.headers['x-service-token'], lookupToken);
      const trip = tripStates.get(req.url.split('/').at(-1));

      send(trip ? 200 : 404, trip || { code: 'TRIP_NOT_FOUND' });
    } else {
      send(404, {});
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const upstream = 'http://127.0.0.1:' + server.address().port;
  const outputQueue = 'matching.test.output.' + randomUUID();

  async function connectMq() {
    connection = await amqp.connect(broker.url);
    connection.on('error', () => {});
    publisher = await connection.createConfirmChannel();
    publisher.on('error', () => {});
    monitor = await connection.createChannel();
    monitor.on('error', () => {});
    await monitor.assertExchange('ride.events', 'topic', { durable: true });
    await monitor.assertQueue(outputQueue, { durable: true });
    await monitor.bindQueue(outputQueue, 'ride.events', 'matching.offer.created');
    await monitor.bindQueue(outputQueue, 'ride.events', 'matching.failed');
    await monitor.consume(outputQueue, message => {
      if (message) {
        events.push(JSON.parse(message.content.toString()));
        monitor.ack(message);
      }
    });
  }

  await connectMq();
  const assignedPort = await port();
  const env = {
    ...db.env,
    ...broker.env,
    MATCHING_PORT: String(assignedPort),
    DRIVER_BASE_URL: upstream,
    TRIP_BASE_URL: upstream,
    SVC_TOKEN_TRIP_MATCHING: tripToken,
    SVC_TOKEN_DRIVER_MATCHING: otherToken,
    SVC_TOKEN_MATCHING_DRIVER: driverToken,
    SVC_TOKEN_MATCHING_TRIP: lookupToken,
  };
  const origin = 'http://127.0.0.1:' + assignedPort;

  async function launch() {
    app = start('matching-service', env);
    try {
      await healthy(app, origin);
    } catch (error) {
      throw new Error(error.message + '\n' + app.logs);
    }
  }

  await launch();

  async function call(path, method = 'GET', body, token = tripToken) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Service-Token': token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });

    return { status: response.status, body: await response.json() };
  }

  function requested(tripId = randomUUID(), version = 1) {
    const event = {
      event_id: randomUUID(),
      type: 'trip.requested',
      schema_version: 1,
      aggregate_id: tripId,
      aggregate_version: version,
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      causation_id: randomUUID(),
      producer: 'trip-booking-service',
      payload: {
        tripId,
        passengerId: randomUUID(),
        pickup: { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' },
        dropoff: { lat: 10.78, lng: 106.7, zoneId: 'ZONE_B' },
        amount: '41000',
        currency: 'VND',
        tripVersion: version,
      },
    };

    tripStates.set(tripId, {
      id: tripId,
      passengerId: event.payload.passengerId,
      quoteId: randomUUID(),
      pickup: event.payload.pickup,
      dropoff: event.payload.dropoff,
      amount: '41000',
      currency: 'VND',
      status: 'MATCHING',
      paymentStatus: 'NOT_REQUESTED',
      version,
      createdAt: event.occurred_at,
      updatedAt: event.occurred_at,
    });

    return event;
  }

  async function publish(event) {
    await new Promise((resolve, reject) =>
      publisher.publish(
        'ride.events',
        event.type,
        Buffer.from(JSON.stringify(event)),
        { persistent: true, contentType: 'application/json', messageId: event.event_id },
        error => (error ? reject(error) : resolve()),
      ),
    );
  }

  const job = tripId => call('/internal/v1/matching/jobs/' + tripId);
  const getOffer = offerId => call('/internal/v1/offers/' + offerId);
  const cancel = (tripId, tripVersion = 10, commandId = randomUUID()) =>
    call('/internal/v1/matching/jobs/' + tripId + '/cancel', 'POST', { commandId, tripVersion });
  const decide = (offer, action = 'ACCEPT', assignmentId = randomUUID(), changes = {}) =>
    call('/internal/v1/offers/' + offer.id + '/decisions', 'POST', {
      assignmentId,
      tripId: offer.tripId,
      driverId: offer.driverId,
      action,
      ...changes,
    });
  const resolveOffer = (offer, result, commandId = randomUUID(), changes = {}) =>
    call('/internal/v1/offers/' + offer.id + '/resolution', 'POST', {
      commandId,
      assignmentId: offer.assignmentId,
      tripId: offer.tripId,
      result,
      ...changes,
    });

  async function openOffer(event, previousId) {
    let offer;

    await eventually(async () => {
      const current = await job(event.payload.tripId);

      assert.equal(current.status, 200);
      assert.ok(current.body.currentOfferId && current.body.currentOfferId !== previousId);
      offer = (await getOffer(current.body.currentOfferId)).body;
      assert.equal(offer.status, 'OPEN');
    }, 15000);

    return offer;
  }

  async function newOffer() {
    const event = requested();

    await publish(event);

    return { event, offer: await openOffer(event) };
  }

  await t.test('five HTTP APIs require the Trip token and validate input', async () => {
    for (const [path, method, body] of [
      ['/internal/v1/matching/jobs/' + randomUUID(), 'GET'],
      [
        '/internal/v1/matching/jobs/' + randomUUID() + '/cancel',
        'POST',
        { commandId: randomUUID(), tripVersion: 1 },
      ],
      ['/internal/v1/offers/' + randomUUID(), 'GET'],
      ['/internal/v1/offers/' + randomUUID() + '/decisions', 'POST', {}],
      ['/internal/v1/offers/' + randomUUID() + '/resolution', 'POST', {}],
    ]) {
      assert.equal((await call(path, method, body, null)).status, 401);
      assert.equal((await call(path, method, body, otherToken)).status, 403);
    }

    assert.equal((await job(randomUUID())).body.code, 'JOB_NOT_FOUND');
    assert.equal((await getOffer(randomUUID())).body.code, 'OFFER_NOT_FOUND');
    assert.equal((await call('/internal/v1/matching/jobs/invalid')).status, 400);
    assert.equal(
      (
        await call('/internal/v1/matching/jobs/' + randomUUID() + '/cancel', 'POST', {
          commandId: randomUUID(),
          tripVersion: 0,
        })
      ).status,
      400,
    );
  });

  await t.test(
    'duplicate RabbitMQ events create one job without renewing the deadline',
    async () => {
      const event = requested();

      await Promise.all(Array.from({ length: 10 }, () => publish(event)));
      await openOffer(event);
      const before = (
        await db.query(
          'SELECT id,search_deadline FROM matching_schema.matching_jobs WHERE trip_id=$1',
          [event.payload.tripId],
        )
      ).rows[0];

      await publish({ ...event, event_id: randomUUID() });
      await eventually(async () =>
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM matching_schema.processed_events WHERE aggregate_id=$1',
              [event.payload.tripId],
            )
          ).rows[0].n,
          2,
        ),
      );
      const rows = (
        await db.query(
          'SELECT id,search_deadline FROM matching_schema.matching_jobs WHERE trip_id=$1',
          [event.payload.tripId],
        )
      ).rows;

      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], before);
      await cancel(event.payload.tripId);
    },
  );

  await t.test(
    'cancel before requested persists a tombstone; late events and stale commands cannot reopen it',
    async () => {
      const event = requested();
      const commandId = randomUUID();
      const first = await cancel(event.payload.tripId, 5, commandId);

      assert.equal(first.status, 200);
      assert.equal(first.body.status, 'CANCELLED');
      assert.deepEqual((await cancel(event.payload.tripId, 5, commandId)).body, first.body);
      assert.equal((await cancel(event.payload.tripId, 4)).body.code, 'STALE_TRIP_VERSION');
      assert.equal((await cancel(event.payload.tripId, 6, commandId)).status, 409);
      await publish(event);
      await publish({
        ...event,
        event_id: randomUUID(),
        aggregate_version: 9,
        payload: { ...event.payload, tripVersion: 9 },
      });
      await eventually(async () =>
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM matching_schema.processed_events WHERE aggregate_id=$1',
              [event.payload.tripId],
            )
          ).rows[0].n,
          2,
        ),
      );
      assert.equal((await job(event.payload.tripId)).body.status, 'CANCELLED');
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS n FROM matching_schema.offers WHERE trip_id=$1', [
            event.payload.tripId,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal((await cancel(event.payload.tripId, 8)).body.code, 'STALE_TRIP_VERSION');
    },
  );

  await t.test('invalid JSON/schema messages go to DLQ and never write a job', async () => {
    const event = requested();

    event.payload.amount = 41000;
    await publish(event);
    await new Promise((resolve, reject) =>
      publisher.publish('ride.events', 'trip.requested', Buffer.from('{bad'), {}, error =>
        error ? reject(error) : resolve(),
      ),
    );
    await eventually(async () =>
      assert.ok((await monitor.checkQueue('matching.events.dlq')).messageCount >= 2),
    );
    assert.equal((await job(event.payload.tripId)).status, 404);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM matching_schema.processed_events WHERE aggregate_id=$1',
          [event.payload.tripId],
        )
      ).rows[0].n,
      0,
    );
  });

  await t.test(
    'trip.cancelled events support reversed order and ignore stale versions',
    async () => {
      const event = requested(randomUUID(), 5);
      const cancellation = version => ({
        ...event,
        event_id: randomUUID(),
        type: 'trip.cancelled',
        aggregate_version: version,
        payload: {
          tripId: event.payload.tripId,
          passengerId: event.payload.passengerId,
          affectedDriverIds: [],
          tripVersion: version,
          reason: 'WAIT_TOO_LONG',
        },
      });

      await publish(event);
      const offer = await openOffer(event);
      const stale = cancellation(4);

      await publish(stale);
      await eventually(async () =>
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM matching_schema.processed_events WHERE event_id=$1',
              [stale.event_id],
            )
          ).rows[0].n,
          1,
        ),
      );
      assert.equal((await job(event.payload.tripId)).body.status, 'OFFERING');
      await publish(cancellation(6));
      await eventually(async () =>
        assert.equal((await job(event.payload.tripId)).body.status, 'CANCELLED'),
      );
      assert.equal((await getOffer(offer.id)).body.status, 'CANCELLED');

      const reversed = requested();
      const cancelled = {
        ...reversed,
        event_id: randomUUID(),
        type: 'trip.cancelled',
        aggregate_version: 2,
        payload: {
          tripId: reversed.payload.tripId,
          passengerId: reversed.payload.passengerId,
          affectedDriverIds: [],
          tripVersion: 2,
          reason: 'CHANGE_PLAN',
        },
      };

      await publish(cancelled);
      await eventually(async () =>
        assert.equal((await job(reversed.payload.tripId)).body.status, 'CANCELLED'),
      );
      await publish(reversed);
      await publish(cancelled);
      await eventually(async () =>
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM matching_schema.processed_events WHERE aggregate_id=$1',
              [reversed.payload.tripId],
            )
          ).rows[0].n,
          2,
        ),
      );
      assert.equal((await job(reversed.payload.tripId)).body.status, 'CANCELLED');
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS n FROM matching_schema.offers WHERE trip_id=$1', [
            reversed.payload.tripId,
          ])
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test(
    'outbox insert failure rolls back attempt, offer and job transition together',
    async () => {
      await db.query('REVOKE INSERT ON matching_schema.outbox_events FROM matching_app');
      const event = requested();

      try {
        await publish(event);
        await eventually(async () => {
          const row = (
            await db.query(
              `SELECT status,lease_token,next_retry_at > clock_timestamp() AS delayed
          FROM matching_schema.matching_jobs WHERE trip_id=$1`,
              [event.payload.tripId],
            )
          ).rows[0];
          assert.ok(row && row.status === 'SEARCHING' && row.lease_token === null && row.delayed);
        });
        const current = (await job(event.payload.tripId)).body;

        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM matching_schema.offers WHERE job_id=$1',
              [current.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM matching_schema.attempted_candidates WHERE job_id=$1',
              [current.id],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await db.query('GRANT INSERT ON matching_schema.outbox_events TO matching_app');
      }

      await openOffer(event);
      await cancel(event.payload.tripId);
    },
  );

  await t.test(
    'offer/attempt/outbox commit together, use the quote snapshot and publish a stable event ID',
    async () => {
      const { event, offer } = await newOffer();

      assert.equal(offer.driverId, driverIds[0]);
      await eventually(async () =>
        assert.ok(
          events.some(
            item => item.type === 'matching.offer.created' && item.payload.offer.id === offer.id,
          ),
        ),
      );
      const sent = events.find(
        item => item.type === 'matching.offer.created' && item.payload.offer.id === offer.id,
      );
      const row = (
        await db.query('SELECT * FROM matching_schema.outbox_events WHERE event_id=$1', [
          sent.event_id,
        ])
      ).rows[0];

      assert.equal(sent.payload.amount, '41000');
      assert.deepEqual(sent.payload.pickup, event.payload.pickup);
      assert.equal(sent.correlation_id, event.correlation_id);
      assert.equal(sent.aggregate_id, offer.jobId);
      assert.equal(row.event_id, sent.event_id);
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM matching_schema.attempted_candidates WHERE job_id=$1',
            [offer.jobId],
          )
        ).rows[0].n,
        1,
      );
      await cancel(event.payload.tripId);
    },
  );

  await t.test(
    'two accepts race: one wins; identical assignment retries replay, wrong owner/action conflict',
    async () => {
      const { event, offer } = await newOffer();

      assert.equal(
        (await decide(offer, 'ACCEPT', randomUUID(), { driverId: driverIds[1] })).body.code,
        'DRIVER_MISMATCH',
      );
      assert.equal(
        (await decide(offer, 'ACCEPT', randomUUID(), { tripId: randomUUID() })).body.code,
        'OFFER_CONFLICT',
      );
      const replies = await Promise.all([decide(offer), decide(offer)]);

      assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
      const claimed = replies.find(reply => reply.status === 200).body;
      const replays = await Promise.all(
        Array.from({ length: 10 }, () => decide(offer, 'ACCEPT', claimed.assignmentId)),
      );

      for (const replay of replays) assert.deepEqual(replay.body, claimed);
      assert.equal(
        (await decide(offer, 'REJECT', claimed.assignmentId)).body.code,
        'OFFER_CONFLICT',
      );
      await cancel(event.payload.tripId);
      assert.equal((await resolveOffer(claimed, 'ASSIGNED')).body.code, 'JOB_CANCELLED');
      assert.equal((await resolveOffer(claimed, 'CANCELLED')).status, 200);
      assert.equal((await job(event.payload.tripId)).body.status, 'CANCELLED');
    },
  );

  await t.test(
    'reject/expire proceeds to the next distinct driver; five attempts emit failure once',
    async () => {
      const { event, offer: first } = await newOffer();
      let offer = first;
      const attempted = [];

      for (let i = 0; i < 5; i++) {
        attempted.push(offer.driverId);
        assert.equal((await decide(offer, 'REJECT')).status, 200);
        if (i < 4) offer = await openOffer(event, offer.id);
      }

      await eventually(async () =>
        assert.equal((await job(event.payload.tripId)).body.status, 'FAILED'),
      );
      assert.equal(new Set(attempted).size, 5);
      await publish({ ...event, event_id: randomUUID() });
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM matching_schema.outbox_events WHERE aggregate_id=$1 AND type='matching.failed'",
            [first.jobId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM matching_schema.attempted_candidates WHERE job_id=$1',
            [first.jobId],
          )
        ).rows[0].n,
        5,
      );
    },
  );

  await t.test(
    'OPEN expiry is enforced after locks; search deadline is fixed and produces SEARCH_TIMEOUT',
    async () => {
      const { event, offer } = await newOffer();
      const blocker = new Client({ connectionString: db.env.MATCHING_MIGRATION_DATABASE_URL });

      await blocker.connect();
      let response;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM matching_schema.matching_jobs WHERE id=$1 FOR UPDATE', [
          offer.jobId,
        ]);
        await blocker.query(
          "UPDATE matching_schema.offers SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",
          [offer.id],
        );
        response = decide(offer);
        await sleep(300);
        await blocker.query('COMMIT');
        assert.equal((await response).body.code, 'OFFER_EXPIRED');
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        await response;
      }

      const next = await openOffer(event, offer.id);

      assert.notEqual(next.driverId, offer.driverId);
      await db.query(
        "UPDATE matching_schema.matching_jobs SET search_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
        [offer.jobId],
      );
      await eventually(async () =>
        assert.equal((await job(event.payload.tripId)).body.status, 'FAILED'),
      );
      const failure = (
        await db.query(
          "SELECT envelope_json FROM matching_schema.outbox_events WHERE aggregate_id=$1 AND type='matching.failed'",
          [offer.jobId],
        )
      ).rows[0].envelope_json;

      assert.equal(failure.payload.reason, 'SEARCH_TIMEOUT');
    },
  );

  await t.test(
    'CLAIMED does not expire while Trip is ASSIGNING; reconciliation uses authoritative assignment/version',
    async () => {
      const { event, offer } = await newOffer();
      const claimed = (await decide(offer)).body;
      const authoritative = tripStates.get(event.payload.tripId);

      Object.assign(authoritative, {
        status: 'ASSIGNING',
        assignmentId: claimed.assignmentId,
        version: 2,
      });
      await db.query(
        "UPDATE matching_schema.offers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [offer.id],
      );
      await db.query(
        "UPDATE matching_schema.matching_jobs SET search_deadline=clock_timestamp()-interval '1 second', next_retry_at=clock_timestamp() WHERE id=$1",
        [offer.jobId],
      );
      await sleep(1000);
      assert.equal((await getOffer(offer.id)).body.status, 'CLAIMED');
      assert.equal((await job(event.payload.tripId)).body.status, 'CLAIMED');
      Object.assign(authoritative, { status: 'ASSIGNED', driverId: offer.driverId, version: 3 });
      await db.query(
        'UPDATE matching_schema.matching_jobs SET next_retry_at=clock_timestamp() WHERE id=$1',
        [offer.jobId],
      );
      await eventually(async () =>
        assert.equal((await job(event.payload.tripId)).body.status, 'MATCHED'),
      );
      assert.equal((await getOffer(offer.id)).body.status, 'ACCEPTED');
      const command = randomUUID();
      const resolved = await resolveOffer(claimed, 'ASSIGNED', command);

      assert.equal(resolved.status, 200);
      assert.deepEqual((await resolveOffer(claimed, 'ASSIGNED', command)).body, resolved.body);
      assert.equal((await resolveOffer(claimed, 'RETRY')).body.code, 'RESOLUTION_CONFLICT');
    },
  );

  await t.test(
    'RETRY closes the claimed offer and searches again without renewing the deadline',
    async () => {
      const { event, offer } = await newOffer();
      const claimed = (await decide(offer)).body;
      const before = (
        await db.query('SELECT search_deadline FROM matching_schema.matching_jobs WHERE id=$1', [
          offer.jobId,
        ])
      ).rows[0].search_deadline;

      assert.equal(
        (await resolveOffer(claimed, 'RETRY', randomUUID(), { assignmentId: randomUUID() })).body
          .code,
        'ASSIGNMENT_MISMATCH',
      );
      assert.equal((await resolveOffer(claimed, 'RETRY')).status, 200);
      const next = await openOffer(event, offer.id);

      assert.notEqual(next.driverId, offer.driverId);
      assert.deepEqual(
        (
          await db.query('SELECT search_deadline FROM matching_schema.matching_jobs WHERE id=$1', [
            offer.jobId,
          ])
        ).rows[0].search_deadline,
        before,
      );
      await cancel(event.payload.tripId);
    },
  );

  await t.test(
    'cancellation during an outbound Driver request invalidates the worker lease',
    async () => {
      const before = driverCalls;
      let releaseGate;

      candidateGate = new Promise(resolve => {
        releaseGate = resolve;
      });
      const event = requested();
      await publish(event);
      try {
        await eventually(async () => assert.ok(driverCalls > before));
        assert.equal((await cancel(event.payload.tripId)).status, 200);
      } finally {
        candidateGate = undefined;
        releaseGate();
      }
      await sleep(700);
      assert.equal((await job(event.payload.tripId)).body.status, 'CANCELLED');
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS n FROM matching_schema.offers WHERE trip_id=$1', [
            event.payload.tripId,
          ])
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test('Driver failure is retried, never reported as NO_CANDIDATE', async () => {
    driverStatus = 503;
    const before = driverCalls;
    const event = requested();

    await publish(event);
    try {
      await eventually(async () => assert.ok(driverCalls >= before + 3), 10000);
      assert.equal((await job(event.payload.tripId)).body.status, 'SEARCHING');
      const current = (await job(event.payload.tripId)).body;
      await db.query(
        "UPDATE matching_schema.matching_jobs SET search_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
        [current.id],
      );
      await eventually(
        async () => assert.equal((await job(event.payload.tripId)).body.status, 'FAILED'),
        15000,
      );
      const failure = (
        await db.query(
          "SELECT envelope_json FROM matching_schema.outbox_events WHERE aggregate_id=$1 AND type='matching.failed'",
          [current.id],
        )
      ).rows[0].envelope_json;

      assert.equal(failure.payload.reason, 'SEARCH_TIMEOUT');
    } finally {
      driverStatus = 200;
    }
  });

  await t.test(
    'unroutable outbox events stay pending, then publish the same event ID after routing is restored',
    async () => {
      roster = [];
      // Topology chung còn bind matching.failed vào trip.events; bỏ cả hai để tin thật sự không có chỗ nhận.
      await monitor.unbindQueue(outputQueue, 'ride.events', 'matching.failed');
      await monitor.unbindQueue('trip.events', 'ride.events', 'matching.failed');
      const event = requested();

      await publish(event);
      let outbox;
      try {
        await eventually(async () => {
          outbox = (
            await db.query(
              "SELECT * FROM matching_schema.outbox_events WHERE type='matching.failed' AND envelope_json->'payload'->>'tripId'=$1",
              [event.payload.tripId],
            )
          ).rows[0];
          assert.ok(outbox && outbox.attempts >= 1 && outbox.status === 'PENDING');
        });
      } finally {
        roster = [...driverIds];
        await monitor.bindQueue(outputQueue, 'ride.events', 'matching.failed');
        await monitor.bindQueue('trip.events', 'ride.events', 'matching.failed');
      }

      await db.query(
        'UPDATE matching_schema.outbox_events SET next_retry_at=clock_timestamp() WHERE event_id=$1',
        [outbox.event_id],
      );
      await eventually(async () =>
        assert.equal(
          (
            await db.query('SELECT status FROM matching_schema.outbox_events WHERE event_id=$1', [
              outbox.event_id,
            ])
          ).rows[0].status,
          'PUBLISHED',
        ),
      );
      await eventually(async () =>
        assert.ok(events.some(item => item.event_id === outbox.event_id)),
      );
    },
  );

  await t.test(
    'stale PUBLISHING leases are reclaimed after restart without changing event identity',
    async () => {
      const { event, offer } = await newOffer();

      await cancel(event.payload.tripId);
      await eventually(async () =>
        assert.equal(
          (
            await db.query(
              "SELECT status FROM matching_schema.outbox_events WHERE aggregate_id=$1 AND type='matching.offer.created'",
              [offer.jobId],
            )
          ).rows[0].status,
          'PUBLISHED',
        ),
      );
      await stop(app);
      const row = (
        await db.query(
          "UPDATE matching_schema.outbox_events SET status='PUBLISHING', published_at=NULL, lease_token=$2, lease_until=clock_timestamp()-interval '1 second' WHERE aggregate_id=$1 AND type='matching.offer.created' RETURNING event_id",
          [offer.jobId, randomUUID()],
        )
      ).rows[0];
      await launch();
      await eventually(async () =>
        assert.equal(
          (
            await db.query('SELECT status FROM matching_schema.outbox_events WHERE event_id=$1', [
              row.event_id,
            ])
          ).rows[0].status,
          'PUBLISHED',
        ),
      );
      await eventually(async () =>
        assert.ok(events.filter(item => item.event_id === row.event_id).length >= 2),
      );
    },
  );

  await t.test(
    'DB outage: readiness returns 503, uncommitted inbound event retries and recovers exactly once',
    async () => {
      docker(['stop', db.name]);
      const event = requested();
      try {
        await eventually(async () => assert.equal((await call('/health/ready')).status, 503));
        assert.equal((await call('/health/live')).status, 200);
        await publish(event);
        await sleep(1500);
      } finally {
        docker(['start', db.name]);
      }
      await eventually(async () => assert.equal((await call('/health/ready')).status, 200));
      await openOffer(event);
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM matching_schema.processed_events WHERE event_id=$1',
            [event.event_id],
          )
        ).rows[0].n,
        1,
      );
      await cancel(event.payload.tripId);
    },
  );

  await t.test(
    'RabbitMQ outage preserves API/DB state and reconnect resumes delivery',
    async () => {
      await connection.close();
      connection = undefined;
      docker(['stop', broker.name]);
      try {
        await eventually(async () => assert.equal((await call('/health/ready')).status, 503));
        assert.equal((await call('/health/live')).status, 200);
        assert.equal((await cancel(randomUUID())).status, 200);
      } finally {
        docker(['start', broker.name]);
      }
      await eventually(async () => {
        try {
          await connectMq();
        } catch (error) {
          await connection?.close().catch(() => {});
          throw error;
        }
      }, 90000);
      await eventually(async () => assert.equal((await call('/health/ready')).status, 200));
      const { event } = await newOffer();
      await cancel(event.payload.tripId);
    },
  );

  await t.test('app role cannot delete event evidence or matching tombstones', async () => {
    await assert.rejects(
      () => db.appQuery('DELETE FROM matching_schema.processed_events'),
      error => error.code === '42501',
    );
    await assert.rejects(
      () => db.appQuery('DELETE FROM matching_schema.matching_jobs'),
      error => error.code === '42501',
    );
  });
});
