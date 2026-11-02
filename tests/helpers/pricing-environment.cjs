const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { docker, eventually, query, root, port } = require('./identity-environment.cjs');

// DB test riêng, cổng ngẫu nhiên; không dùng hoặc xóa dữ liệu DB dev.
async function createPricingDatabase(t) {
  const name = 'ds03-pricing-test-' + randomUUID().slice(0, 8);
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
    'ds03.pricing-test=true',
    '-p',
    '127.0.0.1:' + dbPort + ':5432',
    '-e',
    'POSTGRES_PASSWORD=' + secret,
    '-e',
    'POSTGRES_DB=pricing_db',
    '-e',
    'PRICING_APP_PASSWORD=' + secret,
    '-e',
    'PRICING_MIGRATOR_PASSWORD=' + secret,
    '--mount',
    'type=bind,source=' +
      path.join(root, 'deploy/postgres/pricing-init.sql') +
      ',target=/docker-entrypoint-initdb.d/001-pricing.sql,readonly',
    'postgres:17-bookworm',
  ]);

  created = true;

  const url = role =>
    'postgresql://' + role + ':' + secret + '@127.0.0.1:' + dbPort + '/pricing_db';
  const env = {
    PRICING_DATABASE_URL: url('pricing_app'),
    PRICING_MIGRATION_DATABASE_URL: url('pricing_migrator'),
    PRICING_DB_SCHEMA: 'pricing_schema',
  };

  await eventually(() => query(env.PRICING_MIGRATION_DATABASE_URL, 'SELECT 1'));

  function migrate() {
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        'node_modules/typeorm/cli.js',
        'migration:run',
        '-d',
        'src/services/pricing-service/src/database/data-source.ts',
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
        'Pricing test migration failed: ' +
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
    appQuery: (sql, values) => query(env.PRICING_DATABASE_URL, sql, values),
  };
}

module.exports = { createPricingDatabase };
