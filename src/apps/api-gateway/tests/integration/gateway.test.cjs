// Gateway thật (dist/api-gateway/main.js) trước một service giả ghi lại request. Không cần Docker.
// Chạy: npm run test:gateway (tự build Gateway trước).
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createPrivateKey } = require('node:crypto');
const { JwtService } = require('@nestjs/jwt');
const { generateKeys } = require('../../../../../scripts/identity/generate-keys.cjs');

const root = path.resolve(__dirname, '../../../../..');
const received = [];
const gateways = [];
let upstream;
let upstreamUrl;
let deadUrl;
let keyDir;
let gatewayUrl;
let mainGateway;
let token;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();

      server.close(() => resolve(port));
    });
  });
}

async function call(pathname, { method = 'GET', headers = {}, body, raw, auth = true, base = gatewayUrl } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(auth ? { Authorization: 'Bearer ' + token } : {}),
      ...(body || raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();

  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined };
}

/** Chạy một Gateway bản build thật; extraEnv để đổi giới hạn request. */
async function startGateway(extraEnv = {}) {
  const port = await freePort();
  const instance = { logs: '', url: 'http://127.0.0.1:' + port };

  instance.child = spawn(process.execPath, [path.join(root, 'dist/api-gateway/main.js')], {
    cwd: keyDir, // không đọc .env của máy dev
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      JWT_ISSUER: 'ride-hailing',
      JWT_AUDIENCE: 'ride-api',
      JWT_PUBLIC_KEY_FILE: path.join(keyDir, 'identity-public.pem'),
      IDENTITY_BASE_URL: upstreamUrl,
      DRIVER_BASE_URL: upstreamUrl,
      TRIP_BASE_URL: upstreamUrl,
      PAYMENT_BASE_URL: upstreamUrl,
      NOTIFICATION_BASE_URL: upstreamUrl,
      // Báo giá trỏ vào cổng không có ai nghe để test 502.
      PRICING_BASE_URL: deadUrl,
      ...extraEnv,
    },
  });
  instance.child.stdout.on('data', chunk => (instance.logs += chunk));
  instance.child.stderr.on('data', chunk => (instance.logs += chunk));
  gateways.push(instance);

  // 30 giây: lần chạy đầu sau khi build, Windows Defender có thể giữ file main.js vài giây để quét.
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(instance.url + '/health/live')).ok) {
        return instance;
      }
    } catch {
      // chưa lên
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error('Gateway did not start: ' + instance.logs);
}

before(async () => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
  generateKeys(keyDir);
  token = await new JwtService().signAsync(
    { sub: randomUUID(), role: 'PASSENGER' },
    {
      privateKey: createPrivateKey(fs.readFileSync(path.join(keyDir, 'identity-private.pem'), 'utf8'))
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      algorithm: 'RS256',
      issuer: 'ride-hailing',
      audience: 'ride-api',
      expiresIn: 600,
    },
  );

  // Service giả: trả lại request đã nhận; /operations trả 204.
  upstream = http.createServer((req, res) => {
    let data = '';

    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: data });

      if (req.url.startsWith('/api/v1/operations/')) {
        res.writeHead(204).end();

        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Retry-After': '1', 'X-Internal-Secret': 'x' });
      res.end(JSON.stringify({ upstreamPath: req.url }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
  deadUrl = 'http://127.0.0.1:' + (await freePort());

  mainGateway = await startGateway();
  gatewayUrl = mainGateway.url;
});

after(async () => {
  for (const instance of gateways) {
    instance.child.kill();
  }

  await new Promise(resolve => upstream?.close(resolve));
});

test('allowed routes are forwarded with path and query, to the right upstream', async () => {
  const paymentId = randomUUID();

  received.length = 0;
  assert.equal((await call('/api/v1/payments/' + paymentId)).body.upstreamPath, '/api/v1/payments/' + paymentId);
  assert.equal((await call('/api/v1/payments?tripId=' + paymentId)).body.upstreamPath, '/api/v1/payments?tripId=' + paymentId);
  assert.equal((await call('/api/v1/notifications?limit=5&unreadOnly=true')).status, 200);
  assert.equal(
    (await call('/api/v1/notifications/' + paymentId + '/read', { method: 'PATCH', body: { read: true } })).status,
    200,
  );
  assert.equal(JSON.parse(received.at(-1).body).read, true);
  assert.equal((await call('/api/v1/trips/' + paymentId + '/accept', { method: 'POST', body: {} })).status, 200);
});

test('register and login need no token; everything else needs a valid JWT', async () => {
  assert.equal((await call('/api/v1/auth/login', { method: 'POST', body: { email: 'a@b.c' }, auth: false })).status, 200);

  received.length = 0;

  const missing = await call('/api/v1/payments/' + randomUUID(), { auth: false });
  const forged = await call('/api/v1/payments/' + randomUUID(), { auth: false, headers: { Authorization: 'Bearer abc' } });

  assert.equal(missing.status, 401);
  assert.equal(forged.status, 401);
  assert.equal(received.length, 0, 'unauthenticated requests must not reach the upstream');
});

test('forged identity headers are stripped; JWT, Idempotency-Key and correlation id are forwarded', async () => {
  received.length = 0;
  await call('/api/v1/trips', {
    method: 'POST',
    body: { quoteId: randomUUID() },
    headers: {
      'Idempotency-Key': 'f0b5d3b2-0000-4000-8000-000000000001',
      'X-Service-Token': 'forged-forged-forged-forged-forged-1',
      'X-User-Id': randomUUID(),
      'X-Role': 'ADMIN',
      'X-Forwarded-For': '203.0.113.9',
    },
  });

  const headers = received[0].headers;

  assert.equal(headers.authorization, 'Bearer ' + token);
  assert.equal(headers['idempotency-key'], 'f0b5d3b2-0000-4000-8000-000000000001');
  assert.ok(headers['x-correlation-id']);
  assert.equal(headers['x-service-token'], undefined);
  assert.equal(headers['x-user-id'], undefined);
  assert.equal(headers['x-role'], undefined);
  assert.notEqual(headers['x-forwarded-for'], '203.0.113.9');
});

test('internal routes, unknown routes and path tricks are blocked without reaching the upstream', async () => {
  received.length = 0;

  for (const pathname of [
    '/internal/v1/payments/' + randomUUID(),
    '/api/v1/internal/v1/payments/' + randomUUID(),
    '/api/v1/drivers/candidates',
    '/api/v1/payments/..%2F..%2Finternal%2Fv1%2Fpayments',
    '/api/v1/payments/a/b',
    '/api/v1/admin',
  ]) {
    assert.equal((await call(pathname)).status, 404, pathname);
  }

  assert.equal((await call('/api/v1/payments/' + randomUUID(), { method: 'DELETE' })).status, 405);
  assert.equal(received.length, 0);
});

test('upstream down gives 502 with the standard error body; response headers are filtered', async () => {
  const down = await call('/api/v1/quotes/' + randomUUID());

  assert.equal(down.status, 502);
  assert.equal(down.body.code, 'BAD_GATEWAY');
  assert.ok(down.body.correlationId);

  const response = await fetch(gatewayUrl + '/api/v1/payments/' + randomUUID(), {
    headers: { Authorization: 'Bearer ' + token },
  });

  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(response.headers.get('x-internal-secret'), null);
  assert.equal((await call('/api/v1/operations/' + randomUUID())).status, 204);
});

// ---------- S03: dữ liệu xấu và giới hạn (BA mục 12.1 test 19) ----------

test('S03: body over 64 KiB is 413 and malformed JSON is 400, neither reaches the upstream', async () => {
  received.length = 0;

  const big = await call('/api/v1/trips', { method: 'POST', raw: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) });
  const broken = await call('/api/v1/trips', { method: 'POST', raw: '{"quoteId":' });

  assert.equal(big.status, 413);
  assert.equal(big.body.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(broken.status, 400);
  assert.equal(broken.body.code, 'VALIDATION_ERROR');
  assert.ok(big.body.correlationId && broken.body.correlationId);
  assert.equal(received.length, 0);
});

test('S03: too many requests per IP get 429 with Retry-After; login has its own stricter limit', async () => {
  const limited = await startGateway({ GATEWAY_RATE_LIMIT_PER_MINUTE: '5', GATEWAY_AUTH_RATE_LIMIT: '3' });
  const base = limited.url;

  received.length = 0;

  const statuses = [];

  for (let i = 0; i < 7; i++) {
    statuses.push((await call('/api/v1/notifications', { base })).status);
  }

  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal(received.length, 5, 'blocked requests are not forwarded');

  const blocked = await call('/api/v1/notifications', { base });

  assert.equal(blocked.body.code, 'RATE_LIMITED');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

  // Đăng nhập đếm riêng: 3 lần/phút, tính cả khi chưa có token.
  const logins = [];

  for (let i = 0; i < 4; i++) {
    logins.push((await call('/api/v1/auth/login', { method: 'POST', body: { email: 'a@b.c' }, auth: false, base })).status);
  }

  assert.deepEqual(logins, [200, 200, 200, 429]);

  // Request không có token cũng bị đếm (giới hạn chạy trước kiểm tra JWT) và health không bị giới hạn.
  assert.equal((await call('/api/v1/payments/' + randomUUID(), { auth: false, base })).status, 429);

  for (let i = 0; i < 10; i++) {
    assert.equal((await fetch(base + '/health/live')).status, 200);
  }
});

test('S03: rate limit can be disabled with 0 (load tests from one machine)', async () => {
  const unlimited = await startGateway({ GATEWAY_RATE_LIMIT_PER_MINUTE: '0', GATEWAY_AUTH_RATE_LIMIT: '0' });

  for (let i = 0; i < 20; i++) {
    assert.equal((await call('/api/v1/notifications', { base: unlimited.url })).status, 200);
  }
});

test('S03: token scan — tokens never appear in Gateway logs or error bodies', async () => {
  const forged = 'eyJhbGciOiJSUzI1NiJ9.' + 'A'.repeat(40) + '.leak-check-signature';
  const responses = [
    await call('/api/v1/payments/' + randomUUID(), { auth: false, headers: { Authorization: 'Bearer ' + forged } }),
    await call('/api/v1/quotes/' + randomUUID()), // 502 với token thật
    await call('/internal/v1/payments/' + randomUUID(), { headers: { 'X-Service-Token': 'svc-secret-' + 'z'.repeat(32) } }),
  ];

  for (const response of responses) {
    assert.ok(!response.text.includes(forged), 'forged token echoed');
    assert.ok(!response.text.includes(token), 'real token echoed');
    assert.ok(!response.text.includes('svc-secret-'), 'service token echoed');
  }

  await new Promise(resolve => setTimeout(resolve, 200));

  for (const instance of gateways) {
    assert.ok(!instance.logs.includes(token), 'real token in logs');
    assert.ok(!instance.logs.includes(forged), 'forged token in logs');
    assert.ok(!instance.logs.includes('svc-secret-'), 'service token in logs');
    assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(instance.logs), 'key material in logs');
  }

  assert.ok(mainGateway.logs.length > 0, 'logs were captured');
});
