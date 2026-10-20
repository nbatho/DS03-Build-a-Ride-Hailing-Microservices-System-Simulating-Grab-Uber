require('reflect-metadata');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { JwtService } = require('@nestjs/jwt');
const { generateKeys } = require('../../../../scripts/identity/generate-keys.cjs');
const { InternalHttpClient, InternalCallError, loadInboundTokens } = require('@app/runtime');
const { INTERNAL_CALLERS } = require('@app/shared-types');
const { createInternalTestApp } = require('./fixtures/internal-test.app');

const token = () => randomBytes(32).toString('base64url');
const tokens = { TRIP_PRICING: token(), MATCHING_PRICING: token(), TRIP_DRIVER: token() };
let directory, app, url;

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-internal-'));
  generateKeys(directory);
  // Đặt rỗng mọi token trước khi ConfigModule nạp .env của máy dev (dotenv không ghi đè biến đã có).
  for (const caller of INTERNAL_CALLERS) {
    for (const receiver of INTERNAL_CALLERS) process.env['SVC_TOKEN_' + caller + '_' + receiver] = '';
  }
  Object.assign(process.env, {
    JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
    JWT_PUBLIC_KEY: '',
    JWT_ISSUER: 'ride-hailing',
    JWT_AUDIENCE: 'ride-api',
    SVC_TOKEN_TRIP_PRICING: tokens.TRIP_PRICING,
    SVC_TOKEN_MATCHING_PRICING: tokens.MATCHING_PRICING,
    // Token của cặp khác (Trip -> Driver) không được Báo giá chấp nhận.
    SVC_TOKEN_TRIP_DRIVER: tokens.TRIP_DRIVER,
  });
  ({ app, url } = await createInternalTestApp());
  process.env.PRICING_BASE_URL = url;
});

after(async () => {
  await app?.close();
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('runtime-internal-')
  ) {
    throw new Error('Unsafe temporary cleanup target');
  }

  fs.rmSync(directory, { recursive: true, force: true });
});

async function call(route, headers = {}) {
  const response = await fetch(url + route, { headers });

  return { status: response.status, body: await response.json() };
}

test('allowed caller passes and is identified from its token', async () => {
  const { status, body } = await call('/internal/v1/quotes/ping', { 'X-Service-Token': tokens.TRIP_PRICING });

  assert.equal(status, 200);
  assert.deepEqual(body, { caller: 'TRIP' });
});

test('missing, unknown, malformed or other-pair tokens get 401 INTERNAL_CALLER_FORBIDDEN', async () => {
  for (const value of [undefined, token(), 'short', tokens.TRIP_DRIVER, tokens.TRIP_PRICING + 'x']) {
    const { status, body } = await call('/internal/v1/quotes/ping', value ? { 'X-Service-Token': value } : {});

    assert.equal(status, 401, String(value));
    assert.equal(body.code, 'INTERNAL_CALLER_FORBIDDEN');
  }
});

test('known caller outside the allowlist gets 403; method allowlist overrides class', async () => {
  const denied = await call('/internal/v1/quotes/ping', { 'X-Service-Token': tokens.MATCHING_PRICING });

  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'INTERNAL_CALLER_FORBIDDEN');

  const shared = await call('/internal/v1/quotes/shared', { 'X-Service-Token': tokens.MATCHING_PRICING });

  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body, { caller: 'MATCHING' });
});

test('user JWT cannot replace the service token, and self-declared caller headers are ignored', async () => {
  const keyDirectory = path.join(directory, 'signer');

  generateKeys(keyDirectory);
  const jwt = new JwtService({}).sign({ role: 'PASSENGER' }, {
    privateKey: fs.readFileSync(path.join(keyDirectory, 'identity-private.pem')),
    algorithm: 'RS256', subject: randomUUID(), issuer: 'ride-hailing', audience: 'ride-api', expiresIn: 3600,
  });
  const result = await call('/internal/v1/quotes/ping', {
    Authorization: 'Bearer ' + jwt, 'X-Caller': 'TRIP', 'X-Service-Name': 'trip-booking-service',
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'INTERNAL_CALLER_FORBIDDEN');
});

test('internal route without @InternalRoute is closed even for a valid token', async () => {
  const { status, body } = await call('/internal/v1/forgotten', { 'X-Service-Token': tokens.TRIP_PRICING });

  assert.ok([401, 403].includes(status), 'got ' + status);
  assert.equal(body.leaked, undefined);
});

test('token config: empty is skipped, malformed and shared tokens stop startup', () => {
  assert.deepEqual(loadInboundTokens({ SVC_TOKEN_TRIP_PRICING: '' }, 'PRICING'), []);
  assert.deepEqual(loadInboundTokens({}, undefined), []);
  assert.throws(() => loadInboundTokens({ SVC_TOKEN_TRIP_PRICING: '<local-only>' }, 'PRICING'), /SVC_TOKEN_TRIP_PRICING/);
  const same = token();

  assert.throws(
    () => loadInboundTokens({ SVC_TOKEN_TRIP_PRICING: same, SVC_TOKEN_OPS_PRICING: same }, 'PRICING'),
    /must differ/,
  );
  assert.deepEqual(
    loadInboundTokens({ SVC_TOKEN_TRIP_PRICING: token(), SVC_TOKEN_PRICING_PRICING: token() }, 'PRICING').map(t => t.caller),
    ['TRIP'],
  );
});

test('InternalHttpClient sends the caller token and correlation id', async () => {
  const client = new InternalHttpClient('trip-booking-service');
  const response = await client.request('PRICING', {
    method: 'GET', path: '/internal/v1/quotes/ping', correlationId: randomUUID(), retry: true,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { caller: 'TRIP' });

  // Matching chưa có token tới Driver trong env này: báo lỗi cấu hình, không gửi request thiếu token.
  process.env.DRIVER_BASE_URL = url;
  await assert.rejects(
    () => new InternalHttpClient('matching-service').request('DRIVER', {
      method: 'GET', path: '/internal/v1/drivers/candidates', correlationId: randomUUID(), retry: true,
    }),
    /SVC_TOKEN_MATCHING_DRIVER is not configured/,
  );
});

async function flakyServer(statuses) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];

    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status }));
  });

  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  return { seen, server, origin: 'http://127.0.0.1:' + server.address().port };
}

test('InternalHttpClient retries 502/503/504 up to 3 attempts only when retry is allowed', async t => {
  const flaky = await flakyServer([503, 502, 200]);

  t.after(() => flaky.server.close());
  process.env.DRIVER_BASE_URL = flaky.origin;
  const client = new InternalHttpClient('trip-booking-service');
  const correlationId = randomUUID();
  const started = Date.now();
  const ok = await client.request('DRIVER', {
    method: 'PUT', path: '/internal/v1/reservations/x', correlationId, body: { a: 1 }, retry: true,
  });

  assert.equal(ok.status, 200);
  assert.equal(flaky.seen.length, 3);
  assert.ok(Date.now() - started >= 2000, 'waits 0.5s then 1.5s between attempts');
  assert.ok(flaky.seen.every(h => h['x-service-token'] === tokens.TRIP_DRIVER && h['x-correlation-id'] === correlationId));

  flaky.seen.length = 0;
  const once = await new InternalHttpClient('trip-booking-service').request('DRIVER', {
    method: 'POST', path: '/internal/v1/reservations/x/confirm', correlationId, body: {}, retry: false,
  });

  assert.equal(once.status, 503);
  assert.equal(flaky.seen.length, 1);
});

test('InternalHttpClient never retries 4xx and reports unreachable services as 503', async t => {
  const conflict = await flakyServer([409]);

  t.after(() => conflict.server.close());
  process.env.DRIVER_BASE_URL = conflict.origin;
  const response = await new InternalHttpClient('trip-booking-service').request('DRIVER', {
    method: 'GET', path: '/internal/v1/reservations/x', correlationId: randomUUID(), retry: true,
  });

  assert.equal(response.status, 409);
  assert.equal(conflict.seen.length, 1);

  const closed = await flakyServer([200]);

  await new Promise(resolve => closed.server.close(resolve));
  process.env.DRIVER_BASE_URL = closed.origin;
  await assert.rejects(
    () => new InternalHttpClient('trip-booking-service').request('DRIVER', {
      method: 'GET', path: '/internal/v1/reservations/x', correlationId: randomUUID(), retry: false,
    }),
    error => error instanceof InternalCallError && error.getStatus() === 503 && error.outcomeUnknown === false,
  );
});
