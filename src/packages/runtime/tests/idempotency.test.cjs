require('reflect-metadata');
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { DataSource } = require('typeorm');
const { docker, eventually, query, root } = require('../../../../tests/helpers/identity-environment.cjs');
const {
  ApiError, runInTransaction, isRetryableTransactionError, withIdempotencyKey, withCommandResult, requestFingerprint,
} = require('@app/runtime');

// Chạy trên PostgreSQL thật: container driver-db tạm + migration thật của Driver (có idempotency_keys, command_results).
const name = 'ds03-runtime-test-' + randomUUID().slice(0, 8);
const secret = randomUUID().replaceAll('-', '');
const schema = 'driver_schema';
let dataSource, created = false;

before(async () => {
  docker([
    'run', '-d', '--name', name, '--label', 'ds03.runtime-test=true', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_PASSWORD=' + secret, '-e', 'POSTGRES_DB=driver_db',
    '-e', 'DRIVER_APP_PASSWORD=' + secret, '-e', 'DRIVER_MIGRATOR_PASSWORD=' + secret,
    '--mount', 'type=bind,source=' + path.join(root, 'deploy/postgres/driver-init.sql')
      + ',target=/docker-entrypoint-initdb.d/001-driver.sql,readonly',
    'postgres:17-bookworm',
  ]);
  created = true;
  const port = docker(['port', name, '5432/tcp']).split(':').at(-1);
  const url = role => 'postgresql://' + role + ':' + secret + '@127.0.0.1:' + port + '/driver_db';

  Object.assign(process.env, {
    DRIVER_DB_SCHEMA: schema,
    DRIVER_DATABASE_URL: url('driver_app'),
    DRIVER_MIGRATION_DATABASE_URL: url('driver_migrator'),
  });
  await eventually(() => query(url('driver_migrator'), 'SELECT 1'));
  const migrations = require('../../../services/driver-vehicle-location-service/src/database/data-source').default;

  await migrations.initialize();
  await migrations.runMigrations();
  await migrations.destroy();
  const { databaseOptions } = require('../../../services/driver-vehicle-location-service/src/database/options');

  // Ứng dụng nối bằng driver_app (chỉ SELECT/INSERT/UPDATE), đúng quyền thật.
  dataSource = new DataSource({ ...databaseOptions(process.env), entities: [], extra: { max: 12 } });
  await dataSource.initialize();
}, { timeout: 180000 });

after(async () => {
  await dataSource?.destroy();
  if (created) docker(['rm', '-f', '-v', name]);
});

const scope = key => ({ schema, actorId: randomUUID(), method: 'post', path: '/api/v1/vehicles', key });

async function createDriver(manager, license) {
  const id = randomUUID();

  await manager.query(`INSERT INTO ${schema}.drivers (id, license_number) VALUES ($1, $2)`, [id, license]);

  return id;
}

async function countDrivers(license) {
  const [row] = await dataSource.query(`SELECT count(*)::int AS n FROM ${schema}.drivers WHERE license_number = $1`, [license]);

  return row.n;
}

test('fingerprint ignores field order and undefined fields', () => {
  assert.equal(requestFingerprint({ a: 1, b: { c: [1, 2], d: 'x' } }), requestFingerprint({ b: { d: 'x', c: [1, 2] }, a: 1, e: undefined }));
  assert.notEqual(requestFingerprint({ a: 1 }), requestFingerprint({ a: '1' }));
  assert.notEqual(requestFingerprint({ list: [1, 2] }), requestFingerprint({ list: [2, 1] }));
});

test('10 concurrent requests with the same key write once and all get the same response', async () => {
  const license = 'IDEM-' + randomUUID().slice(0, 8);
  const same = { ...scope(randomUUID()) };
  let runs = 0;
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    withIdempotencyKey(dataSource, same, { plate: '51A-12345', model: 'Vios' }, async manager => {
      runs++;
      const driverId = await createDriver(manager, license);

      await sleep(200);

      return { status: 201, body: { driverId, createdAt: new Date('2026-10-20T00:00:00Z') } };
    })));

  assert.equal(await countDrivers(license), 1);
  assert.equal(runs, 1);
  assert.equal(results.filter(r => !r.replayed).length, 1);
  for (const result of results) {
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, results[0].body);
  }
  assert.equal(results[0].body.createdAt, '2026-10-20T00:00:00.000Z', 'stored as JSON, identical on replay');
});

test('same key with a different body is 409 IDEMPOTENCY_CONFLICT; same body in another order replays', async () => {
  const same = scope(randomUUID());
  const handler = async () => ({ status: 201, body: { ok: true } });

  await withIdempotencyKey(dataSource, same, { plate: 'A', model: 'B' }, handler);
  const replay = await withIdempotencyKey(dataSource, same, { model: 'B', plate: 'A' }, handler);

  assert.equal(replay.replayed, true);
  await assert.rejects(
    () => withIdempotencyKey(dataSource, same, { plate: 'OTHER', model: 'B' }, handler),
    error => error instanceof ApiError && error.getStatus() === 409 && error.getResponse().code === 'IDEMPOTENCY_CONFLICT',
  );

  // Cùng key nhưng người gọi khác là phạm vi khác.
  const other = await withIdempotencyKey(dataSource, { ...same, actorId: randomUUID() }, { plate: 'OTHER' }, handler);

  assert.equal(other.replayed, false);
});

test('a failed handler rolls back both the business write and the key, so a retry runs again', async () => {
  const license = 'FAIL-' + randomUUID().slice(0, 8);
  const same = scope(randomUUID());

  await assert.rejects(() => withIdempotencyKey(dataSource, same, {}, async manager => {
    await createDriver(manager, license);
    throw new ApiError(409, 'VEHICLE_EXISTS', 'Plate already registered');
  }), /Plate already registered/);
  assert.equal(await countDrivers(license), 0);

  const retry = await withIdempotencyKey(dataSource, same, {}, async manager => {
    await createDriver(manager, license);

    return { status: 201, body: { ok: true } };
  });

  assert.equal(retry.replayed, false);
  assert.equal(await countDrivers(license), 1);
});

test('internal command: same commandId replays, different payload or resource is 409 PAYLOAD_MISMATCH', async () => {
  const command = {
    schema, callerService: 'TRIP', commandType: 'CONFIRM', commandId: randomUUID(),
    resourceId: randomUUID(), correlationId: randomUUID(),
  };
  let runs = 0;
  const handler = async () => ({ status: 200, body: { status: 'CONFIRMED', run: ++runs } });
  const results = await Promise.all([1, 2, 3].map(() => withCommandResult(dataSource, command, { tripVersion: 3 }, handler)));

  assert.equal(runs, 1);
  assert.ok(results.every(r => r.status === 200 && r.body.run === 1));
  for (const changed of [
    [command, { tripVersion: 4 }],
    [{ ...command, resourceId: randomUUID() }, { tripVersion: 3 }],
  ]) {
    await assert.rejects(
      () => withCommandResult(dataSource, changed[0], changed[1], handler),
      error => error.getStatus() === 409 && error.getResponse().code === 'PAYLOAD_MISMATCH',
    );
  }

  // Bên gọi khác dùng trùng commandId là lệnh khác.
  const fromMatching = await withCommandResult(dataSource, { ...command, callerService: 'MATCHING' }, { tripVersion: 3 }, handler);

  assert.equal(fromMatching.replayed, false);
});

test('deadlock between two transactions is retried and both finish', async () => {
  const [a, b] = await runInTransaction(dataSource, async manager =>
    Promise.all([createDriver(manager, 'LOCK-A'), createDriver(manager, 'LOCK-B')]));
  let attempts = 0;
  let bothLocked;
  const barrier = new Promise(resolve => { bothLocked = resolve; });
  let firstLocks = 0;
  const lockInOrder = (first, second) => runInTransaction(dataSource, async manager => {
    attempts++;
    await manager.query(`UPDATE ${schema}.drivers SET version = version + 1 WHERE id = $1`, [first]);
    if (++firstLocks === 2) bothLocked();
    await barrier;
    await manager.query(`UPDATE ${schema}.drivers SET version = version + 1 WHERE id = $1`, [second]);
  });

  await Promise.all([lockInOrder(a, b), lockInOrder(b, a)]);
  assert.ok(attempts >= 3, 'one transaction was aborted by PostgreSQL and run again: ' + attempts);
  const rows = await dataSource.query(`SELECT version FROM ${schema}.drivers WHERE id = ANY($1)`, [[a, b]]);

  assert.deepEqual(rows.map(r => r.version), [3, 3]);
});

test('retry is bounded: still failing after 3 attempts gives 503, other errors are not retried', async () => {
  let attempts = 0;

  await assert.rejects(() => runInTransaction(dataSource, async () => {
    attempts++;
    throw Object.assign(new Error('serialization'), { code: '40001' });
  }), error => error.getStatus() === 503 && error.getResponse().code === 'DEPENDENCY_UNAVAILABLE');
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(() => runInTransaction(dataSource, async () => {
    attempts++;
    throw Object.assign(new Error('unique'), { code: '23505' });
  }), /unique/);
  assert.equal(attempts, 1);
  assert.equal(isRetryableTransactionError({ driverError: { code: '40P01' } }), true);
});
