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
let upstream;
let gateway;
let gatewayUrl;
let logs = '';
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

async function call(pathname, { method = 'GET', headers = {}, body, auth = true } = {}) {
  const response = await fetch(gatewayUrl + pathname, {
    method,
    headers: {
      ...(auth ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

before(async () => {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));

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

  // Service giả: trả lại request đã nhận; /slow không trả lời, /empty trả 204.
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

  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
  const port = await freePort();

  gateway = spawn(process.execPath, [path.join(root, 'dist/api-gateway/main.js')], {
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
      PRICING_BASE_URL: 'http://127.0.0.1:' + (await freePort()),
    },
  });
  gateway.stdout.on('data', chunk => (logs += chunk));
  gateway.stderr.on('data', chunk => (logs += chunk));
  gatewayUrl = 'http://127.0.0.1:' + port;

  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(gatewayUrl + '/health/live')).ok) {
        return;
      }
    } catch {
      // chưa lên
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error('Gateway did not start:\n' + logs);
});

after(async () => {
  gateway?.kill();
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
