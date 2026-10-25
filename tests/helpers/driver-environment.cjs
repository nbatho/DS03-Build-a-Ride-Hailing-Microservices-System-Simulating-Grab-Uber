const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { docker, eventually, query, root, port } = require('./identity-environment.cjs');

async function createDriverDatabase(t) {
  const name = 'ds03-driver-test-' + randomUUID().slice(0, 8);
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
    'ds03.driver-test=true',
    '-p',
    '127.0.0.1:' + dbPort + ':5432',
    '-e',
    'POSTGRES_PASSWORD=' + secret,
    '-e',
    'POSTGRES_DB=driver_db',
    '-e',
    'DRIVER_APP_PASSWORD=' + secret,
    '-e',
    'DRIVER_MIGRATOR_PASSWORD=' + secret,
    '--mount',
    'type=bind,source=' +
      path.join(root, 'deploy/postgres/driver-init.sql') +
      ',target=/docker-entrypoint-initdb.d/001-driver.sql,readonly',
    'postgres:17-bookworm',
  ]);

  created = true;

  const url = role => 'postgresql://' + role + ':' + secret + '@127.0.0.1:' + dbPort + '/driver_db';
  const env = {
    DRIVER_DATABASE_URL: url('driver_app'),
    DRIVER_MIGRATION_DATABASE_URL: url('driver_migrator'),
    DRIVER_DB_SCHEMA: 'driver_schema',
  };

  await eventually(() => query(env.DRIVER_MIGRATION_DATABASE_URL, 'SELECT 1'));

  function migrate() {
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        'node_modules/typeorm/cli.js',
        'migration:run',
        '-d',
        'src/services/driver-vehicle-location-service/src/database/data-source.ts',
      ],
      { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 },
    );

    if (result.error || result.status !== 0) {
      throw new Error(
        'Driver test migration failed: ' +
          (result.stderr || result.error?.message || '').slice(0, 1500),
      );
    }
  }

  migrate();

  return {
    env,
    name,
    migrate,
    query: (sql, values) => query(url('postgres'), sql, values),
    appQuery: (sql, values) => query(env.DRIVER_DATABASE_URL, sql, values),
  };
}

module.exports = { createDriverDatabase };
