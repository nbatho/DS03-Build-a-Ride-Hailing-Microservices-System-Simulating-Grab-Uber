const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const amqp = require('amqplib');
const { docker, eventually, query, root, port } = require('./identity-environment.cjs');

async function createMatchingDatabase(t) {
  const name = 'ds03-matching-test-' + randomUUID().slice(0, 8);
  const secret = randomUUID().replaceAll('-', '');
  const dbPort = await port();
  let created = false;

  t.after(() => {
    if (created) {docker(['rm', '-f', '-v', name]);}
  });

  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'ds03.matching-test=true',
    '-p',
    '127.0.0.1:' + dbPort + ':5432',
    '-e',
    'POSTGRES_PASSWORD=' + secret,
    '-e',
    'POSTGRES_DB=matching_db',
    '-e',
    'MATCHING_APP_PASSWORD=' + secret,
    '-e',
    'MATCHING_MIGRATOR_PASSWORD=' + secret,
    '--mount',
    'type=bind,source=' +
      path.join(root, 'deploy/postgres/matching-init.sql') +
      ',target=/docker-entrypoint-initdb.d/001-matching.sql,readonly',
    'postgres:17-bookworm',
  ]);

  created = true;
  const url = role =>
    'postgresql://' + role + ':' + secret + '@127.0.0.1:' + dbPort + '/matching_db';
  const env = {
    MATCHING_DATABASE_URL: url('matching_app'),
    MATCHING_MIGRATION_DATABASE_URL: url('matching_migrator'),
    MATCHING_DB_SCHEMA: 'matching_schema',
  };

  await eventually(() => query(env.MATCHING_MIGRATION_DATABASE_URL, 'SELECT 1'));
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      'node_modules/typeorm/cli.js',
      'migration:run',
      '-d',
      'src/services/matching-service/src/database/data-source.ts',
    ],
    {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 60000,
    },
  );

  if (result.error || result.status !== 0)
    {throw new Error('Matching migration failed: ' + result.stderr);}

  return {
    env,
    name,
    query: (sql, values) => query(url('postgres'), sql, values),
    appQuery: (sql, values) => query(env.MATCHING_DATABASE_URL, sql, values),
  };
}

async function createMatchingBroker(t) {
  const name = 'ds03-matching-mq-' + randomUUID().slice(0, 8);
  const secret = randomUUID().replaceAll('-', '');
  const mqPort = await port();
  const url = 'amqp://test_user:' + secret + '@127.0.0.1:' + mqPort + '/%2F?heartbeat=5';
  let created = false;

  t.after(() => {
    if (created) {docker(['rm', '-f', '-v', name]);}
  });

  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'ds03.matching-test=true',
    '-p',
    '127.0.0.1:' + mqPort + ':5672',
    '-e',
    'RABBITMQ_DEFAULT_USER=test_user',
    '-e',
    'RABBITMQ_DEFAULT_PASS=' + secret,
    'rabbitmq:4-management',
  ]);

  created = true;
  await eventually(async () => {
    const connection = await amqp.connect(url, { timeout: 2000 });

    await connection.close();
  }, 90000);

  return { name, url, env: { RABBITMQ_URL: url } };
}

module.exports = { createMatchingDatabase, createMatchingBroker };
