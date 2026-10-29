// S03 (dữ liệu xấu và giới hạn) + phần S02 của C, chạy qua Gateway thật tới Payment / Notification thật
// trên PostgreSQL + RabbitMQ dùng một lần. Không có Docker thì skip.
// Chạy: npm run test:c:security     Bằng chứng: docs/test-evidence/c/security.json
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { connect } = require('amqplib');
const { RabbitConnection, EventPublisher, loadMessagingConfig } = require('@app/messaging');
const {
  createCEnvironment,
  dockerAvailable,
  waitFor,
  scenarioRecorder,
  writeEvidence,
} = require('../helpers/c-environment.cjs');

const bodies = [];
const tokens = [];
let skipReason;
const { scenario, outcomes } = scenarioRecorder(test, () => skipReason);
let envC;
let connection;
let publisher;
let admin;
let channel;
let gateway;
const passengerId = randomUUID();
const otherPassengerId = randomUUID();
let passengerToken;
let otherToken;
let driverToken;
let paymentId;
let tripId;
let notificationId;

async function call(base, pathname, { method = 'GET', token, body, raw, headers = {} } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();

  bodies.push(text);

  return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
}

function expectError(response, status, code, label) {
  assert.equal(response.status, status, label + ': ' + response.text);

  if (code) {
    assert.equal(response.body.code, code, label);
  }

  // Lỗi luôn có dạng {code, message, correlationId, details?} (BA mục 4.1).
  assert.ok(
    response.body.code && response.body.message && response.body.correlationId,
    label + ' error shape',
  );
}

before(async () => {
  if (!dockerAvailable()) {
    skipReason = 'Docker engine not available';
    console.log('# ' + skipReason + ', skipping C security tests');

    return;
  }

  envC = await createCEnvironment({ prefix: 'ds03-c-security' });
  await envC.startApp('payment');
  await envC.startApp('notification');
  gateway = (await envC.startApp('gateway')).url;

  connection = new RabbitConnection(loadMessagingConfig({ RABBITMQ_URL: envC.rabbitUrl }));
  await connection.connectOnce();
  publisher = new EventPublisher(connection);
  admin = await connect(envC.rabbitUrl, { timeout: 10_000 });
  admin.on('error', () => undefined);
  channel = await admin.createChannel();

  passengerToken = await envC.tokenFor(passengerId, 'PASSENGER');
  otherToken = await envC.tokenFor(otherPassengerId, 'PASSENGER');
  driverToken = await envC.tokenFor(randomUUID(), 'DRIVER');
  tokens.push(passengerToken, otherToken, driverToken);

  // Dữ liệu thật: một khoản thanh toán + thông báo của khách, tạo qua sự kiện như Trip sẽ gửi.
  paymentId = randomUUID();
  tripId = randomUUID();
  await publisher.publish({
    event_id: randomUUID(),
    type: 'payment.requested',
    schema_version: 1,
    aggregate_id: tripId,
    aggregate_version: 5,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    producer: 'trip-booking-service',
    payload: { paymentId, tripId, passengerId, amount: '41000', currency: 'VND', attemptNo: 1 },
  });

  const items = await waitFor(
    async () => {
      const page = await call(gateway, '/api/v1/notifications', { token: passengerToken });

      return page.status === 200 && page.body.items.length > 0 ? page.body.items : undefined;
    },
    30_000,
    'passenger payment notification',
  );

  notificationId = items[0].id;
});

after(async () => {
  await connection?.close().catch(() => undefined);
  await admin?.close().catch(() => undefined);

  if (envC) {
    await envC.close().catch(error => console.log('# cleanup failed: ' + error.message));
  }

  if (!skipReason) {
    writeEvidence('security.json', outcomes, {
      infrastructure:
        'disposable PostgreSQL 17 + RabbitMQ 4.1 (deploy/c-test.compose.yml), project ' +
        envC?.project,
      path: 'client -> dist/api-gateway -> dist/simulated-payment-service | dist/notification-service',
      cases: ['S03 (C part)', 'S02 (Payment/Notification/Gateway subset)'],
    });
  }
});

scenario(
  'S03: unknown fields and out-of-range values are rejected with 400 by the service behind the Gateway',
  async () => {
    const cases = [
      [
        'PATCH read with extra field',
        '/api/v1/notifications/' + notificationId + '/read',
        { method: 'PATCH', body: { read: true, recipientId: otherPassengerId } },
      ],
      [
        'PATCH read=false',
        '/api/v1/notifications/' + notificationId + '/read',
        { method: 'PATCH', body: { read: false } },
      ],
      [
        'PATCH empty body',
        '/api/v1/notifications/' + notificationId + '/read',
        { method: 'PATCH', body: {} },
      ],
      ['limit too large', '/api/v1/notifications?limit=1000', {}],
      ['limit zero', '/api/v1/notifications?limit=0', {}],
      ['unknown query field', '/api/v1/notifications?recipientId=' + otherPassengerId, {}],
      [
        'notification id not a UUID',
        '/api/v1/notifications/abc/read',
        { method: 'PATCH', body: { read: true } },
      ],
      ['payments without tripId', '/api/v1/payments', {}],
      ['payments tripId not a UUID', '/api/v1/payments?tripId=abc', {}],
      [
        'payments extra query',
        '/api/v1/payments?tripId=' + tripId + '&passengerId=' + otherPassengerId,
        {},
      ],
      ['payment id not a UUID', '/api/v1/payments/not-a-uuid', {}],
    ];

    for (const [label, pathname, options] of cases) {
      expectError(
        await call(gateway, pathname, { token: passengerToken, ...options }),
        400,
        undefined,
        label,
      );
    }

    expectError(
      await call(gateway, '/api/v1/notifications?cursor=garbage', { token: passengerToken }),
      400,
      'INVALID_CURSOR',
      'bad cursor',
    );

    // Không có gì bị đổi: thông báo vẫn chưa đọc.
    const page = await call(gateway, '/api/v1/notifications', { token: passengerToken });

    assert.equal(page.body.items.find(n => n.id === notificationId).read, false);

    return { rejected: cases.length + 1 };
  },
);

scenario('S03: body over 64 KiB is 413 at the Gateway and at the service itself', async () => {
  const raw = JSON.stringify({ read: true, pad: 'x'.repeat(70 * 1024) });
  const pathname = '/api/v1/notifications/' + notificationId + '/read';

  expectError(
    await call(gateway, pathname, { method: 'PATCH', token: passengerToken, raw }),
    413,
    'PAYLOAD_TOO_LARGE',
    'gateway',
  );

  // Service tự giới hạn, không chỉ trông vào Gateway (BA mục 10.1).
  expectError(
    await call(envC.apps.notification.url, pathname, {
      method: 'PATCH',
      token: passengerToken,
      raw,
    }),
    413,
    'PAYLOAD_TOO_LARGE',
    'service',
  );

  expectError(
    await call(gateway, pathname, { method: 'PATCH', token: passengerToken, raw: '{"read":' }),
    400,
    'VALIDATION_ERROR',
    'malformed JSON',
  );
});

scenario('S02: cross-user access, wrong role and internal routes are refused', async () => {
  expectError(
    await call(gateway, '/api/v1/payments/' + paymentId, { token: otherToken }),
    403,
    'RESOURCE_FORBIDDEN',
    'other passenger payment',
  );

  expectError(
    await call(gateway, '/api/v1/payments?tripId=' + tripId, { token: otherToken }),
    403,
    'RESOURCE_FORBIDDEN',
    'other passenger by trip',
  );

  expectError(
    await call(gateway, '/api/v1/payments/' + paymentId, { token: driverToken }),
    403,
    'ROLE_FORBIDDEN',
    'driver role',
  );

  expectError(
    await call(gateway, '/api/v1/notifications/' + notificationId + '/read', {
      method: 'PATCH',
      token: otherToken,
      body: { read: true },
    }),
    403,
    'RESOURCE_FORBIDDEN',
    'mark other user notification',
  );

  assert.equal(
    (await call(gateway, '/api/v1/notifications', { token: otherToken })).body.items.length,
    0,
    'other user sees nothing',
  );

  // API nội bộ: không đi qua Gateway; gọi thẳng service thì phải có X-Service-Token đúng.
  expectError(
    await call(gateway, '/internal/v1/payments/' + paymentId, { token: passengerToken }),
    404,
    undefined,
    'internal via gateway',
  );

  expectError(
    await call(envC.apps.payment.url, '/internal/v1/payments/' + paymentId, {
      token: passengerToken,
    }),
    401,
    'INTERNAL_CALLER_FORBIDDEN',
    'internal without service token',
  );

  expectError(
    await call(envC.apps.payment.url, '/internal/v1/payments/' + paymentId, {
      headers: { 'X-Service-Token': 'f'.repeat(48) },
    }),
    401,
    'INTERNAL_CALLER_FORBIDDEN',
    'internal with unknown service token',
  );

  // Owner vẫn đọc được: các lần từ chối ở trên không phải do service hỏng.
  assert.equal(
    (await call(gateway, '/api/v1/payments/' + paymentId, { token: passengerToken })).body.status,
    'SUCCEEDED',
  );
});

scenario('S02: bad JWTs are refused at the Gateway and at the service', async () => {
  const expired = await envC.tokenFor(passengerId, 'PASSENGER', { expiresIn: -10 });
  const wrongAudience = await envC.tokenFor(passengerId, 'PASSENGER', { audience: 'other-api' });
  const tampered =
    passengerToken.slice(0, -4) + (passengerToken.endsWith('AAAA') ? 'BBBB' : 'AAAA');

  tokens.push(expired, wrongAudience, tampered);

  for (const [label, token] of [
    ['expired', expired],
    ['wrong audience', wrongAudience],
    ['tampered signature', tampered],
  ]) {
    expectError(
      await call(gateway, '/api/v1/payments/' + paymentId, { token }),
      401,
      'INVALID_TOKEN',
      'gateway ' + label,
    );

    expectError(
      await call(envC.apps.payment.url, '/api/v1/payments/' + paymentId, { token }),
      401,
      'INVALID_TOKEN',
      'service ' + label,
    );
  }

  // Header giả không đổi được người gọi.
  expectError(
    await call(gateway, '/api/v1/payments/' + paymentId, {
      token: otherToken,
      headers: { 'X-User-Id': passengerId, 'X-Role': 'PASSENGER' },
    }),
    403,
    'RESOURCE_FORBIDDEN',
    'forged X-User-Id',
  );
});

scenario(
  'S03: event over 128 KiB goes to notification.events.dlq truncated; sender refuses it; consumer keeps running',
  async () => {
    const big = {
      event_id: randomUUID(),
      type: 'trip.no_driver',
      schema_version: 1,
      aggregate_id: tripId,
      aggregate_version: 2,
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      causation_id: randomUUID(),
      producer: 'trip-booking-service',
      payload: { tripId, passengerId, tripVersion: 2, reason: 'NO_CANDIDATE' },
      padding: 'x'.repeat(130 * 1024),
    };

    await assert.rejects(publisher.publish(big), /limit 131072/);

    channel.sendToQueue('notification.events', Buffer.from(JSON.stringify(big)), {
      persistent: true,
    });

    const dead = await waitFor(
      async () => {
        const message = await channel.get('notification.events.dlq', { noAck: true });

        return message || undefined;
      },
      15_000,
      'oversized event in DLQ',
    );

    assert.equal(dead.properties.headers['x-error-code'], 'EVENT_TOO_LARGE');
    assert.ok(dead.content.length <= 1024, 'DLQ keeps only the truncated head');
    await envC.waitReady('notification', 5_000);

    return {
      originalSize: dead.properties.headers['x-original-size'],
      storedBytes: dead.content.length,
    };
  },
);

scenario(
  'S03: secret scan — no JWT, DB/RabbitMQ password or key material in logs or response bodies',
  async () => {
    await sleep(500);

    const secrets = [...tokens, ...envC.secrets];
    const logs = Object.values(envC.apps).map(app => [app.name, app.logs]);

    for (const [name, text] of logs) {
      assert.ok(text.length > 0, name + ' logs captured');

      for (const secret of secrets) {
        assert.ok(!text.includes(secret), name + ' log leaks a secret');
      }

      assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(text), name + ' log leaks key material');
    }

    for (const text of bodies) {
      for (const secret of secrets) {
        assert.ok(!text.includes(secret), 'response body leaks a secret');
      }
    }

    return {
      scannedLogs: logs.length,
      scannedResponses: bodies.length,
      secretsChecked: secrets.length,
    };
  },
);
