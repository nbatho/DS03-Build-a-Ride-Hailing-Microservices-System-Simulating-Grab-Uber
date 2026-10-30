const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { docker, eventually, query, root, port } = require('./identity-environment.cjs');

async function createTripDatabase(t) {
  const name = 'ds03-trip-test-' + randomUUID().slice(0, 8);
  const secret = randomUUID().replaceAll('-', '');
  const dbPort = await port();
  let created = false;

  t.after(() => {
    if (created) {
      docker(['rm', '-f', '-v', name]);
    }
  });

  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'ds03.trip-test=true',
    '-p',
    '127.0.0.1:' + dbPort + ':5432',
    '-e',
    'POSTGRES_PASSWORD=' + secret,
    '-e',
    'POSTGRES_DB=trip_db',
    '-e',
    'TRIP_APP_PASSWORD=' + secret,
    '-e',
    'TRIP_MIGRATOR_PASSWORD=' + secret,
    '--mount',
    'type=bind,source=' +
      path.join(root, 'deploy/postgres/trip-init.sql') +
      ',target=/docker-entrypoint-initdb.d/001-trip.sql,readonly',
    'postgres:17-bookworm',
  ]);

  created = true;

  const url = role => 'postgresql://' + role + ':' + secret + '@127.0.0.1:' + dbPort + '/trip_db';
  const env = {
    TRIP_DATABASE_URL: url('trip_app'),
    TRIP_MIGRATION_DATABASE_URL: url('trip_migrator'),
    TRIP_DB_SCHEMA: 'trip_schema',
  };

  await eventually(() => query(env.TRIP_MIGRATION_DATABASE_URL, 'SELECT 1'));

  function typeorm(command) {
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        'node_modules/typeorm/cli.js',
        command,
        '-d',
        'src/services/trip-booking-service/src/database/data-source.ts',
      ],
      {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 60000,
      },
    );

    if (result.error || result.status !== 0) {
      throw new Error(
        'Trip test ' +
          command +
          ' failed: ' +
          (result.stderr || result.stdout || result.error?.message || '').slice(0, 1500),
      );
    }
  }

  const migrate = () => typeorm('migration:run');
  const revert = () => typeorm('migration:revert');

  migrate();

  return {
    env,
    name,
    migrate,
    revert,
    query: (sql, values) => query(url('postgres'), sql, values),
    appQuery: (sql, values) => query(env.TRIP_DATABASE_URL, sql, values),
  };
}

module.exports = { createTripDatabase };
