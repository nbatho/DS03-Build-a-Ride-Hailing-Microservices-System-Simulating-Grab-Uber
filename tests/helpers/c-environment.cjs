// Hạ tầng dùng một lần cho test của C: payment_db, notification_db, RabbitMQ (deploy/c-test.compose.yml),
// Payment / Notification / Gateway chạy từ bản build thật. Mật khẩu, cổng, tên project ngẫu nhiên; `close()` xóa sạch.
require('reflect-metadata');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID, createPrivateKey } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { Client } = require('pg');
const { JwtService } = require('@nestjs/jwt');
const { generateKeys } = require('../../scripts/identity/generate-keys.cjs');

const root = path.resolve(__dirname, '../..');
const composeFile = path.join(root, 'deploy/c-test.compose.yml');

const APPS = {
  payment: { dist: 'simulated-payment-service', portEnv: 'PAYMENT_PORT' },
  notification: { dist: 'notification-service', portEnv: 'NOTIFICATION_PORT' },
  gateway: { dist: 'api-gateway', portEnv: 'GATEWAY_PORT' },
};

function dockerAvailable() {
  return (
    spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status ===
    0
  );
}

async function freePort() {
  const server = net.createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();

  await new Promise(resolve => server.close(resolve));

  return port;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    try {
      const value = await check();

      if (value) {
        return value;
      }
    } catch (error) {
      last = error;
    }

    await sleep(200);
  }

  throw new Error('Timed out waiting for ' + label + (last ? ': ' + last.message : ''));
}

async function createCEnvironment({ prefix = 'ds03-c' } = {}) {
  const project = prefix + '-' + randomUUID().slice(0, 8);
  const secret = () => randomBytes(24).toString('hex');
  const env = {
    C_TEST_BOOTSTRAP_PASSWORD: secret(),
    C_TEST_APP_PASSWORD: secret(),
    C_TEST_MIGRATOR_PASSWORD: secret(),
    C_TEST_RABBITMQ_PASSWORD: secret(),
    C_TEST_PAYMENT_DB_PORT: String(await freePort()),
    C_TEST_NOTIFICATION_DB_PORT: String(await freePort()),
    C_TEST_RABBITMQ_PORT: String(await freePort()),
  };
  const rabbitUrl =
    'amqp://ride:' +
    env.C_TEST_RABBITMQ_PASSWORD +
    '@127.0.0.1:' +
    env.C_TEST_RABBITMQ_PORT +
    '/ride';
  const apps = {};
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));

  function compose(args) {
    const result = spawnSync('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 300_000,
    });

    if (result.status !== 0) {
      throw new Error(
        'docker compose ' + args.join(' ') + ' failed:\n' + result.stderr + result.stdout,
      );
    }

    return result.stdout;
  }

  function migrate(service, prefixName, database, port) {
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        'node_modules/typeorm/cli.js',
        'migration:run',
        '-d',
        'src/services/' + service + '/src/database/data-source.ts',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          [prefixName + '_DB_SCHEMA']: database + '_schema',
          [prefixName + '_MIGRATION_DATABASE_URL']:
            'postgresql://' +
            database +
            '_migrator:' +
            env.C_TEST_MIGRATOR_PASSWORD +
            '@127.0.0.1:' +
            port +
            '/' +
            database +
            '_db',
        },
        timeout: 120_000,
      },
    );

    if (result.status !== 0) {
      throw new Error('migration ' + service + ' failed:\n' + result.stderr + result.stdout);
    }
  }

  function appEnv(name, port, overrides) {
    const common = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      JWT_ISSUER: 'ride-hailing',
      JWT_AUDIENCE: 'ride-api',
      JWT_PUBLIC_KEY_FILE: path.join(keyDir, 'identity-public.pem'),
      [APPS[name].portEnv]: String(port),
    };

    if (name === 'payment') {
      return {
        ...common,
        RABBITMQ_URL: rabbitUrl,
        PAYMENT_DB_SCHEMA: 'payment_schema',
        PAYMENT_DATABASE_URL:
          'postgresql://payment_app:' +
          env.C_TEST_APP_PASSWORD +
          '@127.0.0.1:' +
          env.C_TEST_PAYMENT_DB_PORT +
          '/payment_db',
        PAYMENT_SIMULATION_MODE: 'SUCCEED',
        ...overrides,
      };
    }

    if (name === 'notification') {
      return {
        ...common,
        RABBITMQ_URL: rabbitUrl,
        NOTIFICATION_DB_SCHEMA: 'notification_schema',
        NOTIFICATION_DATABASE_URL:
          'postgresql://notification_app:' +
          env.C_TEST_APP_PASSWORD +
          '@127.0.0.1:' +
          env.C_TEST_NOTIFICATION_DB_PORT +
          '/notification_db',
        ...overrides,
      };
    }

    return {
      ...common,
      PAYMENT_BASE_URL: apps.payment?.url ?? 'http://127.0.0.1:1',
      NOTIFICATION_BASE_URL: apps.notification?.url ?? 'http://127.0.0.1:1',
      ...overrides,
    };
  }

  /** Biến DB + RabbitMQ để test khác tự chạy Payment/Notification (không gồm cổng, JWT). */
  function serviceEnv(name) {
    const shared = Object.keys(appEnv('gateway', 0, {}));

    return Object.fromEntries(
      Object.entries(appEnv(name, 0, {})).filter(([key]) => !shared.includes(key) && key !== APPS[name].portEnv),
    );
  }

  async function waitReady(name, timeoutMs = 60_000) {
    const app = apps[name];
    const probe = name === 'gateway' ? '/health/live' : '/health/ready';

    await waitFor(
      async () => {
        if (app.child.exitCode !== null) {
          throw new Error(name + ' exited:\n' + app.logs.slice(-3000));
        }

        return (await fetch(app.url + probe, { signal: AbortSignal.timeout(2000) })).status === 200;
      },
      timeoutMs,
      name + ' ready',
    );
  }

  async function startApp(name, overrides = {}) {
    const port = apps[name]?.port ?? (await freePort());
    // cwd = thư mục tạm để ConfigModule không nạp .env của máy dev.
    const child = spawn(process.execPath, [path.join(root, 'dist', APPS[name].dist, 'main.js')], {
      cwd: keyDir,
      env: appEnv(name, port, overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const app = {
      name,
      port,
      child,
      url: 'http://127.0.0.1:' + port,
      logs: apps[name]?.logs ?? '',
    };
    const collect = chunk => (app.logs = (app.logs + chunk).slice(-500_000));

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    apps[name] = app;
    await waitReady(name);

    return app;
  }

  /** Tắt đột ngột (SIGKILL): tin chưa ACK được RabbitMQ trả lại. */
  async function killApp(name) {
    const child = apps[name]?.child;

    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');

      child.kill('SIGKILL');
      await exited;
    }
  }

  /** Đọc DB bằng user postgres của container test, không bằng user app. */
  async function sql(database, text, values = []) {
    const port =
      database === 'payment' ? env.C_TEST_PAYMENT_DB_PORT : env.C_TEST_NOTIFICATION_DB_PORT;
    const client = new Client({
      connectionString:
        'postgresql://postgres:' +
        env.C_TEST_BOOTSTRAP_PASSWORD +
        '@127.0.0.1:' +
        port +
        '/' +
        database +
        '_db',
    });

    await client.connect();

    try {
      return (await client.query(text, values)).rows;
    } finally {
      await client.end();
    }
  }

  generateKeys(keyDir);

  const privateKey = createPrivateKey(
    fs.readFileSync(path.join(keyDir, 'identity-private.pem'), 'utf8'),
  )
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const jwt = new JwtService();

  function tokenFor(userId, role, options = {}) {
    return jwt.signAsync(
      { sub: userId, role },
      {
        privateKey,
        algorithm: 'RS256',
        issuer: 'ride-hailing',
        audience: 'ride-api',
        expiresIn: 600,
        ...options,
      },
    );
  }

  try {
    compose(['up', '-d', '--wait']);
    migrate('simulated-payment-service', 'PAYMENT', 'payment', env.C_TEST_PAYMENT_DB_PORT);
    migrate(
      'notification-service',
      'NOTIFICATION',
      'notification',
      env.C_TEST_NOTIFICATION_DB_PORT,
    );
  } catch (error) {
    // Giữ log container trước khi xóa để biết vì sao không lên được.
    const logs = spawnSync('docker', ['compose', '-p', project, '-f', composeFile, 'logs', '--tail', '40'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

    error.message += '\n--- container logs ---\n' + (logs.stdout ?? '') + (logs.stderr ?? '');
    compose(['down', '-v', '--remove-orphans']);
    throw error;
  }

  return {
    project,
    env,
    rabbitUrl,
    apps,
    secrets: Object.values(env).filter(value => /^[0-9a-f]{48}$/.test(value)),
    compose,
    serviceEnv,
    startApp,
    killApp,
    waitReady,
    sql,
    tokenFor,
    async close() {
      for (const name of Object.keys(apps)) {
        await killApp(name).catch(() => undefined);
      }

      compose(['down', '-v', '--remove-orphans']);
    },
  };
}

/**
 * Ghi kết quả từng kịch bản cho file bằng chứng. `skip()` trả lý do skip nếu hạ tầng không có.
 * Dùng: const { scenario, outcomes } = scenarioRecorder(test, () => skipReason);
 */
function scenarioRecorder(test, skip) {
  const outcomes = [];

  function scenario(name, fn) {
    test(name, async t => {
      const reason = skip();

      if (reason) {
        return t.skip(reason);
      }

      const started = Date.now();

      try {
        const details = await fn();

        outcomes.push({
          name,
          status: 'PASS',
          durationMs: Date.now() - started,
          ...(details ? { details } : {}),
        });
      } catch (error) {
        outcomes.push({
          name,
          status: 'FAIL',
          durationMs: Date.now() - started,
          error: error.message,
        });

        throw error;
      }
    });
  }

  return { scenario, outcomes };
}

/** Ghi docs/test-evidence/c/<file> với trạng thái tổng, commit và kết quả từng kịch bản; không ghi bí mật. */
function writeEvidence(file, outcomes, meta) {
  const directory = path.join(root, 'docs/test-evidence/c');

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, file),
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        status:
          outcomes.length > 0 && outcomes.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL',
        commit: commitId(),
        ...meta,
        outcomes,
        secrets: '[REDACTED]',
      },
      null,
      2,
    ) + '\n',
  );
}

function commitId() {
  return (
    spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout.trim() || 'unknown'
  );
}

module.exports = {
  root,
  createCEnvironment,
  dockerAvailable,
  waitFor,
  freePort,
  scenarioRecorder,
  writeEvidence,
};
