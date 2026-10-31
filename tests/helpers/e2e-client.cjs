const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '../..');
const GATEWAY = process.env.E2E_GATEWAY_URL ?? 'http://127.0.0.1:8080';
const API = GATEWAY + '/api/v1';

async function call(route, { method = 'GET', body, token, key, correlationId } = {}) {
  const response = await fetch(API + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function expectStatus(promise, status) {
  const result = await promise;

  assert.equal(result.status, status, JSON.stringify(result.body));

  return result.body;
}

async function poll(read, done, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    last = await read();

    if (done(last)) {
      return last;
    }

    await sleep(1000);
  }

  throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(last));
}

async function account(role) {
  const email = role.toLowerCase() + '-' + randomUUID() + '@e2e.test';
  const password = 'E2e-' + randomUUID();
  const user = await expectStatus(
    call('/auth/register', {
      method: 'POST',
      body: { email, password, displayName: 'E2E', role },
    }),
    201,
  );
  const login = await expectStatus(
    call('/auth/login', { method: 'POST', body: { email, password } }),
    200,
  );

  return { id: user.id, role: user.role, token: login.accessToken, sequence: 0 };
}

function sendLocation(driver, position) {
  driver.sequence += 1;

  return expectStatus(
    call('/drivers/me/location', {
      method: 'PUT',
      token: driver.token,
      body: { position, sequence: driver.sequence, recordedAt: new Date().toISOString() },
    }),
    200,
  );
}

const driverProfile = driver => expectStatus(call('/drivers/me', { token: driver.token }), 200);

async function setOnline(driver, online) {
  const profile = await driverProfile(driver);

  return expectStatus(
    call('/drivers/me/status', {
      method: 'PATCH',
      token: driver.token,
      key: randomUUID(),
      body: { online, expectedVersion: profile.version },
    }),
    200,
  );
}

async function bringOnline(driver, position) {
  await expectStatus(
    call('/drivers/me', {
      method: 'PUT',
      token: driver.token,
      body: { licenseNumber: 'E2E-' + driver.id.slice(0, 8) },
    }),
    200,
  );
  await expectStatus(
    call('/vehicles', {
      method: 'POST',
      token: driver.token,
      key: randomUUID(),
      body: { plateNumber: 'E2E' + driver.id.slice(0, 8), model: 'Vios', color: 'White' },
    }),
    201,
  );
  await sendLocation(driver, position);
  await setOnline(driver, true);
}

const createQuote = (passenger, point) =>
  expectStatus(
    call('/quotes', {
      method: 'POST',
      token: passenger.token,
      key: randomUUID(),
      body: { pickup: point, dropoff: point, distanceMeters: 3000, durationSeconds: 600 },
    }),
    201,
  );

async function findNotification(user, match) {
  const page = await expectStatus(call('/notifications?limit=100', { token: user.token }), 200);

  return page.items.find(match);
}

const findOffer = (driver, tripId) =>
  findNotification(
    driver,
    item => item.type === 'OFFER' && item.tripId === tripId && item.actionable,
  );

const finishedOperation = (user, operationId) =>
  poll(
    () => expectStatus(call('/operations/' + operationId, { token: user.token }), 200),
    item => !['PENDING', 'RUNNING'].includes(item.status),
    60000,
    'operation ' + operationId,
  );

function queryDb(service, database, sql) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env',
      '-f',
      'deploy/docker-compose.yml',
      'exec',
      '-T',
      service,
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-tAc',
      sql,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
  );

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

module.exports = {
  ROOT,
  GATEWAY,
  account,
  bringOnline,
  call,
  createQuote,
  driverProfile,
  expectStatus,
  findNotification,
  findOffer,
  finishedOperation,
  poll,
  queryDb,
  sendLocation,
  setOnline,
};
