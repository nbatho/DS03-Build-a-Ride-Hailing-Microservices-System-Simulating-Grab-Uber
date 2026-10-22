// Test phục hồi của C trên RabbitMQ + PostgreSQL thật (BA mục 12.1: R01, R03, F09, F10).
// Tự dựng hạ tầng dùng một lần (deploy/c-test.compose.yml), chạy Payment và Notification bản build thật,
// đóng vai Trip bằng cách gửi sự kiện đúng contract. Không có Docker thì skip.
// Chạy: npm run test:c:recovery     Bằng chứng: docs/test-evidence/c/recovery.json
require('reflect-metadata');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID, createPrivateKey } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { Client } = require('pg');
const { connect } = require('amqplib');
const { JwtService } = require('@nestjs/jwt');
const { RabbitConnection, EventPublisher, loadMessagingConfig } = require('@app/messaging');
const { generateKeys } = require('../../scripts/identity/generate-keys.cjs');

const root = path.resolve(__dirname, '../..');
const composeFile = path.join(root, 'deploy/c-test.compose.yml');
const project = 'ds03-c-test-' + randomUUID().slice(0, 8);
const outcomes = [];
const apps = {};
let env;
let skipReason;
let publisher;
let connection;
let admin;
let channel;
let keyDir;
let jwt;
let privateKey;

// ---------- hạ tầng ----------

function compose(args, extra = {}) {
  const result = spawnSync('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, ...extra },
    timeout: 300_000,
  });

  if (result.status !== 0) {
    throw new Error(
      'docker compose ' + args.join(' ') + ' failed:\n' + result.stderr + result.stdout,
    );
  }

  return result.stdout;
}

async function freePort() {
  const server = net.createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();

  await new Promise(resolve => server.close(resolve));

  return port;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    try {
      const value = await check();

      if (value) {
        return value;
      }
    } catch (error) {
      last = error;
    }

    await sleep(200);
  }

  throw new Error('Timed out waiting for ' + label + (last ? ': ' + last.message : ''));
}

async function sql(database, text, values = []) {
  const port =
    database === 'payment' ? env.C_TEST_PAYMENT_DB_PORT : env.C_TEST_NOTIFICATION_DB_PORT;
  // Đọc bằng user postgres của DB test (BA mục 12.2: user test có quyền phù hợp), không bằng user app.
  const client = new Client({
    connectionString:
      'postgresql://postgres:' +
      env.C_TEST_BOOTSTRAP_PASSWORD +
      '@127.0.0.1:' +
      port +
      '/' +
      database +
      '_db',
  });

  await client.connect();

  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

function migrate(service, prefix, database, port) {
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      'node_modules/typeorm/cli.js',
      'migration:run',
      '-d',
      'src/services/' + service + '/src/database/data-source.ts',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        [prefix + '_DB_SCHEMA']: database + '_schema',
        [prefix + '_MIGRATION_DATABASE_URL']:
          'postgresql://' +
          database +
          '_migrator:' +
          env.C_TEST_MIGRATOR_PASSWORD +
          '@127.0.0.1:' +
          port +
          '/' +
          database +
          '_db',
      },
      timeout: 120_000,
    },
  );

  if (result.status !== 0) {
    throw new Error('migration ' + service + ' failed:\n' + result.stderr + result.stdout);
  }
}

// ---------- app ----------

const APP_CONFIG = {
  payment: { dist: 'simulated-payment-service', portEnv: 'PAYMENT_PORT' },
  notification: { dist: 'notification-service', portEnv: 'NOTIFICATION_PORT' },
};

function appEnv(name, port, overrides) {
  const common = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    JWT_ISSUER: 'ride-hailing',
    JWT_AUDIENCE: 'ride-api',
    JWT_PUBLIC_KEY_FILE: path.join(keyDir, 'identity-public.pem'),
    RABBITMQ_URL: env.RABBITMQ_URL,
    [APP_CONFIG[name].portEnv]: String(port),
  };

  if (name === 'payment') {
    return {
      ...common,
      PAYMENT_DB_SCHEMA: 'payment_schema',
      PAYMENT_DATABASE_URL:
        'postgresql://payment_app:' +
        env.C_TEST_APP_PASSWORD +
        '@127.0.0.1:' +
        env.C_TEST_PAYMENT_DB_PORT +
        '/payment_db',
      PAYMENT_SIMULATION_MODE: 'SUCCEED',
      ...overrides,
    };
  }

  return {
    ...common,
    NOTIFICATION_DB_SCHEMA: 'notification_schema',
    NOTIFICATION_DATABASE_URL:
      'postgresql://notification_app:' +
      env.C_TEST_APP_PASSWORD +
      '@127.0.0.1:' +
      env.C_TEST_NOTIFICATION_DB_PORT +
      '/notification_db',
    ...overrides,
  };
}

async function startApp(name, overrides = {}) {
  const port = apps[name]?.port ?? (await freePort());
  // cwd = thư mục tạm để ConfigModule không nạp .env của máy dev.
  const child = spawn(
    process.execPath,
    [path.join(root, 'dist', APP_CONFIG[name].dist, 'main.js')],
    {
      cwd: keyDir,
      env: appEnv(name, port, overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const app = { name, port, child, url: 'http://127.0.0.1:' + port, logs: apps[name]?.logs ?? '' };
  const collect = chunk => (app.logs = (app.logs + chunk).slice(-500_000));

  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  apps[name] = app;
  await waitReady(name, 60_000);

  return app;
}

async function waitReady(name, timeoutMs) {
  const app = apps[name];

  await waitFor(
    async () => {
      if (app.child.exitCode !== null) {
        throw new Error(name + ' exited:\n' + app.logs.slice(-3000));
      }

      return (
        (await fetch(app.url + '/health/ready', { signal: AbortSignal.timeout(2000) })).status ===
        200
      );
    },
    timeoutMs,
    name + ' ready',
  );
}

/** Tắt đột ngột (SIGKILL): không đóng kết nối gọn, tin chưa ACK được RabbitMQ trả lại. */
async function killApp(name) {
  const { child } = apps[name];

  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');

    child.kill('SIGKILL');
    await exited;
  }
}

/** Kết nối quản trị để đọc queue; RabbitMQ khởi động lại thì kết nối cũ báo lỗi, không được làm crash test. */
async function openAdmin() {
  admin = await connect(env.RABBITMQ_URL, { timeout: 10_000 });
  admin.on('error', () => undefined);
  channel = await admin.createChannel();
  channel.on('error', () => undefined);
}

// ---------- sự kiện ----------

const passengerId = randomUUID();
const driverId = randomUUID();

function envelope(type, aggregateId, payload, aggregateVersion = 1) {
  return {
    event_id: randomUUID(),
    type,
    schema_version: 1,
    aggregate_id: aggregateId,
    aggregate_version: aggregateVersion,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    producer: type.startsWith('matching.') ? 'matching-service' : 'trip-booking-service',
    payload,
  };
}

function paymentRequested({ paymentId = randomUUID(), tripId = randomUUID(), attemptNo = 1 } = {}) {
  return envelope(
    'payment.requested',
    tripId,
    {
      paymentId,
      tripId,
      passengerId,
      amount: '41000',
      currency: 'VND',
      attemptNo,
    },
    5,
  );
}

async function payment(paymentId) {
  const [row] = await sql(
    'payment',
    'SELECT status, attempt_no, version FROM payment_schema.payments WHERE id = $1',
    [paymentId],
  );

  return row;
}

async function counts(paymentId) {
  const [row] = await sql(
    'payment',
    `SELECT (SELECT count(*)::int FROM payment_schema.payment_attempts WHERE payment_id = $1) AS attempts,
            (SELECT count(*)::int FROM payment_schema.outbox_events WHERE aggregate_id = $1) AS outbox,
            (SELECT count(*)::int FROM payment_schema.outbox_events WHERE aggregate_id = $1 AND status = 'PUBLISHED') AS published`,
    [paymentId],
  );

  return row;
}

/** Lấy hết tin đang chờ trong một queue (không có consumer), trả về envelope đã parse. */
async function drain(queue) {
  const messages = [];

  for (;;) {
    const message = await channel.get(queue, { noAck: true });

    if (!message) {
      return messages;
    }

    messages.push({
      body: JSON.parse(message.content.toString()),
      headers: message.properties.headers ?? {},
    });
  }
}

async function tokenFor(userId, role) {
  return jwt.signAsync(
    { sub: userId, role },
    {
      privateKey,
      algorithm: 'RS256',
      issuer: 'ride-hailing',
      audience: 'ride-api',
      expiresIn: 600,
    },
  );
}

async function notificationsOf(userId, role) {
  const response = await fetch(apps.notification.url + '/api/v1/notifications?limit=100', {
    headers: { Authorization: 'Bearer ' + (await tokenFor(userId, role)) },
  });

  assert.equal(response.status, 200);

  return (await response.json()).items;
}

function scenario(name, fn) {
  test(name, async t => {
    if (skipReason) {
      return t.skip(skipReason);
    }

    const started = Date.now();

    try {
      const details = await fn();

      outcomes.push({
        name,
        status: 'PASS',
        durationMs: Date.now() - started,
        ...(details ? { details } : {}),
      });
    } catch (error) {
      outcomes.push({
        name,
        status: 'FAIL',
        durationMs: Date.now() - started,
        error: error.message,
      });
      throw error;
    }
  });
}

// ---------- chuẩn bị ----------

before(async () => {
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  });

  if (docker.status !== 0) {
    skipReason = 'Docker engine not available';
    console.log('# ' + skipReason + ', skipping C recovery tests');

    return;
  }

  for (const dist of ['simulated-payment-service', 'notification-service']) {
    if (!fs.existsSync(path.join(root, 'dist', dist, 'main.js'))) {
      throw new Error('dist/' + dist + ' missing; run via npm run test:c:recovery (builds first)');
    }
  }

  const secret = () => randomBytes(24).toString('hex');

  env = {
    C_TEST_BOOTSTRAP_PASSWORD: secret(),
    C_TEST_APP_PASSWORD: secret(),
    C_TEST_MIGRATOR_PASSWORD: secret(),
    C_TEST_RABBITMQ_PASSWORD: secret(),
    C_TEST_PAYMENT_DB_PORT: String(await freePort()),
    C_TEST_NOTIFICATION_DB_PORT: String(await freePort()),
    C_TEST_RABBITMQ_PORT: String(await freePort()),
  };
  env.RABBITMQ_URL =
    'amqp://ride:' +
    env.C_TEST_RABBITMQ_PASSWORD +
    '@127.0.0.1:' +
    env.C_TEST_RABBITMQ_PORT +
    '/ride';

  compose(['up', '-d', '--wait']);
  migrate('simulated-payment-service', 'PAYMENT', 'payment', env.C_TEST_PAYMENT_DB_PORT);
  migrate('notification-service', 'NOTIFICATION', 'notification', env.C_TEST_NOTIFICATION_DB_PORT);

  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds03-c-recovery-'));
  generateKeys(keyDir);
  privateKey = createPrivateKey(fs.readFileSync(path.join(keyDir, 'identity-private.pem'), 'utf8'))
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  jwt = new JwtService();

  // Bên gửi thay cho Trip/Matching: confirm channel + mandatory như service thật.
  connection = new RabbitConnection(loadMessagingConfig({ RABBITMQ_URL: env.RABBITMQ_URL }));
  await connection.connectOnce();
  publisher = new EventPublisher(connection);
  await openAdmin();

  await startApp('payment');
  await startApp('notification');
});

after(async () => {
  for (const name of Object.keys(apps)) {
    await killApp(name).catch(() => undefined);
  }

  await connection?.close().catch(() => undefined);
  await admin?.close().catch(() => undefined);

  if (env) {
    try {
      compose(['down', '-v', '--remove-orphans']);
    } catch (error) {
      console.log('# cleanup failed: ' + error.message);
    }
  }

  if (!skipReason) {
    const directory = path.join(root, 'docs/test-evidence/c');
    const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout.trim();

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'recovery.json'),
      JSON.stringify(
        {
          executedAt: new Date().toISOString(),
          status:
            outcomes.length > 0 && outcomes.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL',
          commit: commit || 'unknown',
          infrastructure:
            'disposable PostgreSQL 17 (payment_db, notification_db) + RabbitMQ 4.1, project ' +
            project,
          apps: 'dist/simulated-payment-service, dist/notification-service (real builds, SIGKILL for crashes)',
          producerStandIn:
            'Trip/Matching events published by the test with the real EventPublisher (confirm + mandatory)',
          cases: ['R01', 'R03', 'F09', 'F10 (out-of-order subset)'],
          outcomes,
          secrets: '[REDACTED]',
        },
        null,
        2,
      ) + '\n',
    );
  }
});

// ---------- kịch bản ----------

scenario(
  'R01: payment down — request waits in payment.events, processed once after restart',
  async () => {
    await killApp('payment');
    await drain('trip.events');

    const event = paymentRequested();
    const { paymentId } = event.payload;

    await publisher.publish(event);
    await waitFor(
      async () => (await channel.checkQueue('payment.events')).messageCount === 1,
      10_000,
      'message queued',
    );
    assert.equal(await payment(paymentId), undefined, 'nothing charged while Payment is down');

    await startApp('payment');
    await waitFor(
      async () => (await payment(paymentId))?.status === 'SUCCEEDED',
      30_000,
      'payment succeeded',
    );
    await waitFor(
      async () => (await counts(paymentId)).published === 1,
      15_000,
      'outbox published',
    );

    assert.deepEqual(await counts(paymentId), { attempts: 1, outbox: 1, published: 1 });

    const toTrip = await waitFor(
      async () => {
        const messages = (await drain('trip.events')).filter(
          m => m.body.payload.paymentId === paymentId,
        );

        return messages.length > 0 ? messages : undefined;
      },
      15_000,
      'payment.succeeded on trip.events',
    );

    assert.equal(toTrip[0].body.type, 'payment.succeeded');
    assert.equal(toTrip[0].body.causation_id, event.event_id);

    const passengerItems = await waitFor(
      async () => {
        const items = (await notificationsOf(passengerId, 'PASSENGER')).filter(
          n => n.type === 'PAYMENT_STATUS' && n.sourceEventId === toTrip[0].body.event_id,
        );

        return items.length > 0 ? items : undefined;
      },
      15_000,
      'passenger payment notification',
    );

    assert.equal(passengerItems.length, 1);
    assert.equal(passengerItems[0].paymentStatus, 'SUCCEEDED');

    return { paymentId, requestEventId: event.event_id, resultEventId: toTrip[0].body.event_id };
  },
);

scenario('R03: duplicate delivery and re-sent attempt never charge twice', async () => {
  const event = paymentRequested();
  const { paymentId } = event.payload;

  await publisher.publish(event);
  await publisher.publish(event); // cùng event_id
  await publisher.publish({ ...event, event_id: randomUUID() }); // Trip gửi lại cùng lần thử

  await waitFor(
    async () => (await payment(paymentId))?.status === 'SUCCEEDED',
    30_000,
    'payment succeeded',
  );
  await waitFor(
    async () => (await channel.checkQueue('payment.events')).messageCount === 0,
    15_000,
    'queue drained',
  );
  await sleep(1_000);

  assert.deepEqual(await counts(paymentId), { attempts: 1, outbox: 1, published: 1 });

  const [processed] = await sql(
    'payment',
    "SELECT count(*)::int AS n FROM payment_schema.processed_events WHERE event_type = 'payment.requested' AND aggregate_id = $1",
    [event.payload.tripId],
  );

  assert.equal(processed.n, 2, 'two distinct event_ids recorded, the exact duplicate deduplicated');

  return { paymentId };
});

scenario(
  'R03: malformed message goes to payment.events.dlq at once; good messages keep flowing',
  async () => {
    await drain('payment.events.dlq');
    channel.sendToQueue('payment.events', Buffer.from('{"not":"an event"'), { persistent: true });
    channel.sendToQueue(
      'payment.events',
      Buffer.from(JSON.stringify({ ...paymentRequested(), producer: 'matching-service' })),
      {
        persistent: true,
      },
    );

    const good = paymentRequested();

    await publisher.publish(good);

    const dead = await waitFor(
      async () => {
        const { messageCount } = await channel.checkQueue('payment.events.dlq');

        return messageCount >= 2 ? drainRaw('payment.events.dlq') : undefined;
      },
      15_000,
      'two messages in DLQ',
    );

    assert.deepEqual(
      dead.map(m => m.headers['x-error-code']),
      ['INVALID_EVENT', 'INVALID_EVENT'],
    );
    await waitFor(
      async () => (await payment(good.payload.paymentId))?.status === 'SUCCEEDED',
      30_000,
      'good payment',
    );
    await waitReady('payment', 5_000);
    assert.equal(apps.payment.child.exitCode, null, 'consumer still alive');

    return { dlqErrors: dead.map(m => m.headers['x-error-message']) };
  },
);

async function drainRaw(queue) {
  const messages = [];

  for (;;) {
    const message = await channel.get(queue, { noAck: true });

    if (!message) {
      return messages;
    }

    messages.push({
      content: message.content.toString(),
      headers: message.properties.headers ?? {},
    });
  }
}

scenario(
  'R03: payment killed mid-burst — after restart every payment charged exactly once',
  async () => {
    const events = Array.from({ length: 30 }, () => paymentRequested());
    const ids = events.map(event => event.payload.paymentId);

    for (const event of events) {
      await publisher.publish(event);
    }

    // Chờ một phần đã ghi DB rồi giết process giữa chừng (có tin đã ghi nhưng chưa ACK, chưa gửi outbox).
    await waitFor(
      async () => {
        const [row] = await sql(
          'payment',
          'SELECT count(*)::int AS n FROM payment_schema.payments WHERE id = ANY($1::uuid[])',
          [ids],
        );

        return row.n >= 3;
      },
      30_000,
      'first payments written',
    );
    await killApp('payment');

    const [beforeRestart] = await sql(
      'payment',
      "SELECT count(*)::int AS n FROM payment_schema.payments WHERE id = ANY($1::uuid[]) AND status = 'SUCCEEDED'",
      [ids],
    );

    await startApp('payment');
    await waitFor(
      async () => {
        const [row] = await sql(
          'payment',
          `SELECT count(*)::int AS n FROM payment_schema.outbox_events
        WHERE aggregate_id = ANY($1::uuid[]) AND status = 'PUBLISHED'`,
          [ids],
        );

        return row.n === ids.length;
      },
      60_000,
      'all outbox events published',
    );

    const rows = await sql(
      'payment',
      `SELECT p.id, p.status,
            (SELECT count(*)::int FROM payment_schema.payment_attempts a WHERE a.payment_id = p.id) AS attempts,
            (SELECT count(*)::int FROM payment_schema.outbox_events o WHERE o.aggregate_id = p.id) AS outbox
       FROM payment_schema.payments p WHERE p.id = ANY($1::uuid[])`,
      [ids],
    );

    assert.equal(rows.length, ids.length);
    assert.ok(
      rows.every(row => row.status === 'SUCCEEDED' && row.attempts === 1 && row.outbox === 1),
      JSON.stringify(rows),
    );

    return { payments: ids.length, succeededBeforeKill: beforeRestart.n };
  },
);

scenario(
  'R03: RabbitMQ restart — Payment and Notification reconnect and keep processing',
  async () => {
    compose(['restart', 'rabbitmq']);
    // Bên gửi của test cũng phải kết nối lại.
    await connection.close();
    void admin.close().catch(() => undefined);
    connection = new RabbitConnection(loadMessagingConfig({ RABBITMQ_URL: env.RABBITMQ_URL }));
    await waitFor(
      async () => (await connection.connectOnce(), true),
      60_000,
      'test publisher reconnect',
    );
    publisher = new EventPublisher(connection);
    await waitFor(async () => (await openAdmin(), true), 60_000, 'admin reconnect');

    await waitReady('payment', 60_000);
    await waitReady('notification', 60_000);

    const event = paymentRequested();

    await publisher.publish(event);
    await waitFor(
      async () => (await payment(event.payload.paymentId))?.status === 'SUCCEEDED',
      30_000,
      'payment after restart',
    );
    await waitFor(
      async () =>
        (await notificationsOf(passengerId, 'PASSENGER')).some(
          n => n.type === 'PAYMENT_STATUS' && n.tripId === event.payload.tripId,
        ),
      30_000,
      'notification after restart',
    );

    return { paymentId: event.payload.paymentId };
  },
);

scenario(
  'F09: temporary failure then retry with the same paymentId succeeds; no double charge',
  async () => {
    await killApp('payment');
    await startApp('payment', { PAYMENT_SIMULATION_MODE: 'FAIL_ONCE' });

    const first = paymentRequested();
    const { paymentId, tripId } = first.payload;

    await publisher.publish(first);
    await waitFor(
      async () => (await payment(paymentId))?.status === 'FAILED',
      30_000,
      'first attempt failed',
    );

    // Trip lên lịch lần thử 2 với cùng paymentId.
    await publisher.publish(paymentRequested({ paymentId, tripId, attemptNo: 2 }));
    await waitFor(
      async () => (await payment(paymentId))?.status === 'SUCCEEDED',
      30_000,
      'second attempt succeeded',
    );
    // Lần thử 1 gửi lại muộn không làm lùi trạng thái.
    await publisher.publish(paymentRequested({ paymentId, tripId, attemptNo: 1 }));
    await sleep(1_500);

    assert.deepEqual(await payment(paymentId), { status: 'SUCCEEDED', attempt_no: 2, version: 3 });

    const statuses = await waitFor(
      async () => {
        const items = (await notificationsOf(passengerId, 'PASSENGER'))
          .filter(n => n.type === 'PAYMENT_STATUS' && n.tripId === tripId)
          .map(n => n.paymentStatus);

        return items.length === 2 ? items : undefined;
      },
      20_000,
      'two payment notifications',
    );

    assert.deepEqual(statuses.sort(), ['FAILED', 'SUCCEEDED']);

    await killApp('payment');
    await startApp('payment');

    return { paymentId, attempts: (await counts(paymentId)).attempts };
  },
);

scenario(
  'F10: offer arriving after cancellation is not actionable; driver gets one cancel notice',
  async () => {
    const tripId = randomUUID();
    const jobId = randomUUID();
    const point = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };

    await publisher.publish(
      envelope(
        'trip.cancelled',
        tripId,
        {
          tripId,
          passengerId,
          affectedDriverIds: [],
          tripVersion: 2,
          reason: 'CHANGE_PLAN',
        },
        2,
      ),
    );

    for (let i = 0; i < 2; i++) {
      await publisher.publish(
        envelope('matching.offer.created', jobId, {
          offer: {
            id: randomUUID(),
            jobId,
            tripId,
            driverId,
            status: 'OPEN',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            version: 1,
          },
          pickup: point,
          dropoff: point,
          amount: '41000',
          currency: 'VND',
        }),
      );
    }

    const items = await waitFor(
      async () => {
        const forTrip = (await notificationsOf(driverId, 'DRIVER')).filter(
          n => n.tripId === tripId,
        );

        return forTrip.filter(n => n.type === 'OFFER').length === 2 ? forTrip : undefined;
      },
      20_000,
      'driver notifications',
    );

    assert.ok(items.filter(n => n.type === 'OFFER').every(n => n.actionable === false));
    assert.equal(
      items.filter(n => n.type === 'TRIP_STATUS' && n.tripStatus === 'CANCELLED').length,
      1,
    );

    const forbidden = await fetch(
      apps.notification.url + '/api/v1/notifications/' + items[0].id + '/read',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + (await tokenFor(passengerId, 'PASSENGER')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ read: true }),
      },
    );

    assert.equal(forbidden.status, 403, 'another user cannot mark the driver notification');

    return { tripId, notifications: items.length };
  },
);
