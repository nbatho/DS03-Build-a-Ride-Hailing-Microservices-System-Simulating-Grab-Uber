const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JwtService } = require('@nestjs/jwt');
const { generateKeys } = require('../../../../../scripts/identity/generate-keys.cjs');
const { createPricingDatabase } = require('../../../../../tests/helpers/pricing-environment.cjs');
const {
  start,
  stop,
  healthy,
  port,
  docker,
  eventually,
} = require('../../../../../tests/helpers/identity-environment.cjs');

test('Pricing API with real PostgreSQL and JWT/service tokens', { timeout: 240000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds03-pricing-test-'));
  let app;

  t.after(async () => {
    if (app) {
      await stop(app);
    }

    const resolved = path.resolve(directory);

    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('ds03-pricing-test-')
    ) {
      throw new Error('Unsafe temporary cleanup target');
    }

    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const db = await createPricingDatabase(t);

  generateKeys(directory);
  const passengerId = randomUUID();
  const privateKey = fs.readFileSync(path.join(directory, 'identity-private.pem'));
  const jwt = new JwtService({});
  const token = (role = 'PASSENGER', userId = passengerId) =>
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
  const passengerToken = token();
  const tripToken = randomBytes(32).toString('base64url');
  const matchingToken = randomBytes(32).toString('base64url');
  const appPort = await port();

  app = start('pricing-service', {
    ...db.env,
    PRICING_PORT: String(appPort),
    JWT_PUBLIC_KEY: '',
    JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
    JWT_ISSUER: 'ride-hailing',
    JWT_AUDIENCE: 'ride-api',
    SVC_TOKEN_TRIP_PRICING: tripToken,
    SVC_TOKEN_MATCHING_PRICING: matchingToken,
  });
  const origin = 'http://127.0.0.1:' + appPort;

  try {
    await healthy(app, origin);
  } catch (error) {
    throw new Error(error.message + '\n' + app.logs);
  }

  async function call(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });

    return { status: response.status, body: await response.json() };
  }

  const estimate = {
    pickup: { lat: 10.77123456, lng: 106.69, zoneId: 'ZONE_A' },
    dropoff: { lat: 10.78, lng: 106.7, zoneId: 'ZONE_B' },
    distanceMeters: 3000,
    durationSeconds: 600,
  };
  const create = (body = estimate, key = randomUUID()) =>
    call('/api/v1/quotes', {
      method: 'POST',
      body,
      headers: { Authorization: 'Bearer ' + passengerToken, 'Idempotency-Key': key },
    });
  const read = id =>
    call('/api/v1/quotes/' + id, { headers: { Authorization: 'Bearer ' + passengerToken } });
  const internal = id =>
    call('/internal/v1/quotes/' + id, { headers: { 'X-Service-Token': tripToken } });
  let quote;

  await t.test(
    'migration can run twice; quote stores owner, exact fare and a 300-second DB expiry',
    async () => {
      db.migrate();
      const result = await create();

      assert.equal(result.status, 201, JSON.stringify(result.body));
      quote = result.body;
      assert.equal(quote.passengerId, passengerId);
      assert.equal(quote.amount, '41000');
      assert.equal(quote.currency, 'VND');
      assert.equal(quote.ruleVersion, 'CAR_V1');
      assert.deepEqual(quote.pickup, { ...estimate.pickup, lat: 10.771235 });
      assert.deepEqual(quote.dropoff, estimate.dropoff);
      const row = (
        await db.query(
          'SELECT extract(epoch FROM (expires_at - created_at))::int AS ttl FROM pricing_schema.quotes WHERE id = $1',
          [quote.id],
        )
      ).rows[0];

      assert.equal(row.ttl, 300);
      assert.deepEqual((await read(quote.id)).body, quote);
      assert.deepEqual((await internal(quote.id)).body, quote);
    },
  );

  await t.test('small estimate rounds each fee up', async () => {
    const result = await create({ ...estimate, distanceMeters: 1, durationSeconds: 1 });

    assert.equal(result.status, 201);
    assert.equal(result.body.amount, '12017');
  });

  await t.test(
    'ten concurrent requests with one key create one quote; changed body conflicts',
    async () => {
      const key = randomUUID();
      const before = (await db.query('SELECT count(*)::int AS n FROM pricing_schema.quotes'))
        .rows[0].n;
      const results = await Promise.all(Array.from({ length: 10 }, () => create(estimate, key)));

      for (const result of results) {
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.deepEqual(result.body, results[0].body);
      }

      const after = (await db.query('SELECT count(*)::int AS n FROM pricing_schema.quotes')).rows[0]
        .n;

      assert.equal(after - before, 1);
      assert.deepEqual((await create({ ...estimate }, key)).body, results[0].body);
      const conflict = await create({ ...estimate, distanceMeters: 4000 }, key);

      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
    },
  );

  await t.test('public routes require passenger JWT; owner is taken from JWT', async () => {
    assert.equal((await call('/api/v1/quotes/' + quote.id)).status, 401);
    assert.equal((await call('/api/v1/quotes', { method: 'POST', body: estimate })).status, 401);
    const headers = { Authorization: 'Bearer ' + token('DRIVER'), 'Idempotency-Key': randomUUID() };

    assert.equal((await call('/api/v1/quotes/' + quote.id, { headers })).status, 403);
    assert.equal(
      (await call('/api/v1/quotes', { method: 'POST', body: estimate, headers })).status,
      403,
    );

    const forbidden = await call('/api/v1/quotes/' + quote.id, {
      headers: { Authorization: 'Bearer ' + token('PASSENGER', randomUUID()) },
    });

    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'RESOURCE_FORBIDDEN');
    assert.equal((await create({ ...estimate, passengerId: randomUUID() })).status, 400);
    assert.equal((await create({ ...estimate, amount: '1' })).status, 400);
  });

  await t.test('only Trip service token can read the internal route', async () => {
    for (const headers of [
      {},
      { Authorization: 'Bearer ' + passengerToken },
      { 'X-Service-Token': 'wrong' },
    ]) {
      assert.equal((await call('/internal/v1/quotes/' + quote.id, { headers })).status, 401);
    }

    const denied = await call('/internal/v1/quotes/' + quote.id, {
      headers: { 'X-Service-Token': matchingToken },
    });

    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'INTERNAL_CALLER_FORBIDDEN');
    assert.equal((await internal(quote.id)).status, 200);
  });

  await t.test('rejects missing keys, invalid UUIDs, invalid points and estimates', async () => {
    for (const key of [undefined, 'invalid']) {
      const headers = { Authorization: 'Bearer ' + passengerToken };

      if (key) {
        headers['Idempotency-Key'] = key;
      }

      assert.equal(
        (await call('/api/v1/quotes', { method: 'POST', body: estimate, headers })).status,
        400,
      );
    }

    assert.equal((await read('invalid')).status, 400);
    assert.equal((await internal('invalid')).status, 400);
    for (const pickup of [
      null,
      [],
      { lat: 91, lng: 0, zoneId: 'ZONE_A' },
      { lat: 0, lng: 0, zoneId: 'ZONE_C' },
      { ...estimate.pickup, extra: 1 },
    ]) {
      assert.equal((await create({ ...estimate, pickup })).status, 400);
    }

    for (const change of [
      { distanceMeters: 0 },
      { distanceMeters: 100001 },
      { durationSeconds: 0 },
      { durationSeconds: 14401 },
    ]) {
      const result = await create({ ...estimate, ...change });

      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'INVALID_ESTIMATE');
    }

    assert.equal((await create({ ...estimate, distanceMeters: '3000' })).status, 400);
    assert.equal((await create({ ...estimate, durationSeconds: 1.5 })).status, 400);
    const missing = await read(randomUUID());

    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'QUOTE_NOT_FOUND');
    assert.equal((await internal(randomUUID())).body.code, 'QUOTE_NOT_FOUND');
  });

  await t.test('expired quotes remain readable and retry does not renew expiry', async () => {
    const key = randomUUID();
    const result = await create(estimate, key);

    // Chỉ postgres test được sửa thời gian để mô phỏng báo giá cũ.
    await db.query(
      `UPDATE pricing_schema.quotes SET created_at = now() - interval '10 minutes',
      expires_at = now() - interval '5 minutes' WHERE id = $1`,
      [result.body.id],
    );
    const expired = await read(result.body.id);

    assert.equal(expired.status, 200);
    assert.ok(Date.parse(expired.body.expiresAt) < Date.now());
    assert.equal((await internal(result.body.id)).status, 200);
    assert.deepEqual((await create(estimate, key)).body, result.body);
  });

  await t.test('a new rule changes only new quotes, never the old snapshot or replay', async () => {
    const key = randomUUID();
    const old = await create(estimate, key);

    await db.query(`INSERT INTO pricing_schema.fare_rules (rule_version, vehicle_type, base_fee, per_km, per_min)
      VALUES ('CAR_V2', 'CAR', 15000, 10000, 600)`);
    const next = await create();

    assert.equal(next.body.ruleVersion, 'CAR_V2');
    assert.equal(next.body.amount, '51000');
    assert.deepEqual((await read(old.body.id)).body, old.body);
    assert.deepEqual((await internal(old.body.id)).body, old.body);
    assert.deepEqual((await create(estimate, key)).body, old.body);
  });

  await t.test('app role cannot change quotes or fare rules', async () => {
    for (const sql of [
      'UPDATE pricing_schema.quotes SET amount = 1',
      'DELETE FROM pricing_schema.quotes',
      'UPDATE pricing_schema.fare_rules SET base_fee = 1',
    ]) {
      await assert.rejects(
        () => db.appQuery(sql),
        error => error.code === '42501',
      );
    }
  });

  await t.test('missing fare rule returns 503 and rolls back the idempotency key', async () => {
    // Tạm ẩn mọi rule khỏi app bằng RLS trong DB test; giữ nguyên quote và khóa ngoại.
    await db.query('ALTER TABLE pricing_schema.fare_rules ENABLE ROW LEVEL SECURITY');
    const key = randomUUID();

    try {
      const result = await create(estimate, key);

      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'PRICING_RULE_UNAVAILABLE');
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM pricing_schema.idempotency_keys WHERE key = $1',
            [key],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await db.query('ALTER TABLE pricing_schema.fare_rules DISABLE ROW LEVEL SECURITY');
    }

    assert.equal((await create(estimate, key)).status, 201);
  });

  await t.test(
    'DB outage makes readiness and API return 503; liveness stays up; DB restart recovers',
    async () => {
      docker(['stop', db.name]);
      try {
        assert.equal((await call('/health/live')).status, 200);
        assert.equal((await call('/health/ready')).status, 503);
        assert.equal((await read(quote.id)).status, 503);
        assert.equal((await create()).status, 503);
      } finally {
        docker(['start', db.name]);
      }

      await eventually(async () => {
        assert.equal((await call('/health/ready')).status, 200);
      });
      assert.equal((await read(quote.id)).status, 200);
    },
  );
});
