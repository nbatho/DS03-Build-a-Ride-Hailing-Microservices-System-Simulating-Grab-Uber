const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { generateKeys } = require('../../scripts/identity/generate-keys.cjs');
const root = path.resolve(__dirname, '../..');

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 });

  if (result.error || result.status !== 0) {
    throw new Error(
      'Docker test command failed: ' +
        (result.stderr || result.error?.message || '').slice(0, 1000),
    );
  }

  return result.stdout.trim();
}

async function query(url, sql, values) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
  });

  try {
    await client.connect();

    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}

async function eventually(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;

  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      if (error.fatal) {
        throw error;
      }

      last = error;
      await delay(200);
    }
  }

  throw new Error('Timed out waiting for test dependency: ' + (last?.message ?? 'unknown'));
}

async function port() {
  const listener = net.createServer();

  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const value = listener.address().port;

  await new Promise(resolve => listener.close(resolve));

  return value;
}

function start(name, env) {
  const child = spawn(process.execPath, [path.join(root, 'dist', name, 'main.js')], {
    cwd: root,
    env: { ...process.env, ...env, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = { child, name, logs: '', error: undefined };
  const collect = data => {
    app.logs = (app.logs + data.toString()).slice(-1000000);
  };

  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', error => {
    app.error = error;
  });

  return app;
}

async function stop(app) {
  if (app.child.exitCode !== null || app.child.signalCode !== null) {
    return;
  }

  const exited = once(app.child, 'exit');

  app.child.kill('SIGTERM');
  const timer = setTimeout(() => app.child.kill('SIGKILL'), 5000);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function healthy(app, url) {
  await eventually(async () => {
    if (app.error || app.child.exitCode !== null) {
      const failure = new Error('App exited during startup: ' + app.name);

      failure.fatal = true;
      throw failure;
    }

    const response = await fetch(url + '/health/ready', { signal: AbortSignal.timeout(3000) });

    if (response.status !== 200) {
      throw new Error(app.name + ' not ready: ' + response.status);
    }
  });
}

async function createEnvironment(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds03-identity-test-'));
  const name = 'ds03-identity-test-' + randomUUID().slice(0, 8);
  const secret = randomUUID().replaceAll('-', '');
  const applications = [];
  let created = false;

  t.after(async () => {
    for (const app of applications) {
      await stop(app);
    }

    if (created) {
      docker(['rm', '-f', '-v', name]);
    }

    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('ds03-identity-test-')
    ) {
      throw new Error('Unsafe temporary cleanup target');
    }

    fs.rmSync(directory, { recursive: true, force: true });
  });

  generateKeys(directory);
  const fixedDbPort = await port();

  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'ds03.identity-test=true',
    '-p',
    '127.0.0.1:' + fixedDbPort + ':5432',
    '-e',
    'POSTGRES_PASSWORD=' + secret,
    '-e',
    'POSTGRES_DB=ride_hailing',
    '-e',
    'IDENTITY_APP_PASSWORD=' + secret,
    '-e',
    'IDENTITY_MIGRATOR_PASSWORD=' + secret,
    '--mount',
    'type=bind,source=' +
      path.join(root, 'deploy/postgres/identity-init.sql') +
      ',target=/docker-entrypoint-initdb.d/001-identity.sql,readonly',
    'postgres:17-bookworm',
  ]);

  created = true;
  const published = docker(['port', name, '5432/tcp']);
  const dbPort = published.split(':').at(-1);
  const url = role =>
    'postgresql://' + role + ':' + secret + '@127.0.0.1:' + dbPort + '/ride_hailing';
  const adminUrl = url('postgres');
  const env = {
    IDENTITY_DATABASE_URL: url('identity_app'),
    IDENTITY_MIGRATION_DATABASE_URL: url('identity_migrator'),
    IDENTITY_DB_SCHEMA: 'identity_schema',
    JWT_ISSUER: 'ride-hailing',
    JWT_AUDIENCE: 'ride-api',
    JWT_ACCESS_TTL_SECONDS: '3600',
    BCRYPT_ROUNDS: '10',
    IDENTITY_TRUSTED_PROXY_CIDRS: 'loopback',
    JWT_PRIVATE_KEY: '',
    JWT_PUBLIC_KEY: '',
    JWT_PRIVATE_KEY_FILE: path.join(directory, 'identity-private.pem'),
    JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
  };

  await eventually(() => query(env.IDENTITY_MIGRATION_DATABASE_URL, 'SELECT current_user'));
  const migration = () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/identity/migrate.cjs', 'run', '--compiled'],
      {
        cwd: root,
        env: { ...process.env, ...env, DOTENV_CONFIG_QUIET: 'true' },
        encoding: 'utf8',
        timeout: 60000,
      },
    );

    if (result.error || result.status !== 0) {
      throw new Error('Compiled migration failed: ' + (result.stderr || '').slice(0, 1500));
    }
  };

  migration();
  migration();
  const fixture = {
    env,
    adminUrl,
    directory,
    name,
    applications,
    migration,
    query: (sql, values) => query(adminUrl, sql, values),
    appQuery: (sql, values) => query(env.IDENTITY_DATABASE_URL, sql, values),
    async launch(name, portEnv, overrides = {}) {
      const assigned = await port();
      const app = start(name, { ...env, [portEnv]: String(assigned), ...overrides });

      app.url = 'http://127.0.0.1:' + assigned;
      applications.push(app);
      await healthy(app, app.url);

      return app;
    },
  };

  return fixture;
}

module.exports = { createEnvironment, start, stop, healthy, eventually, query, port, docker, root };
