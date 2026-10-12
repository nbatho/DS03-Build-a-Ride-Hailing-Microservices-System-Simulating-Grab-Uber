const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const applications = [
  ['api-gateway', 'GATEWAY_PORT'],
  ['identity-user-service', 'IDENTITY_PORT'],
  ['driver-vehicle-location-service', 'DRIVER_PORT'],
  ['trip-booking-service', 'TRIP_PORT'],
  ['simulated-payment-service', 'PAYMENT_PORT'],
  ['notification-service', 'NOTIFICATION_PORT'],
  ['matching-service', 'MATCHING_PORT'],
  ['pricing-service', 'PRICING_PORT'],
];

async function allocatePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function start(name, environment) {
  const entry = path.join(root, 'dist', name, 'main.js');
  assert.ok(fs.existsSync(entry), 'Missing build: run npm run build:all first');
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = { child, logs: '', error: undefined };
  child.stdout.on('data', data => { app.logs += data.toString(); });
  child.stderr.on('data', data => { app.logs += data.toString(); });
  child.on('error', error => { app.error = error; });
  return app;
}

async function stop(app) {
  if (app.child.exitCode !== null || app.child.signalCode !== null) return;
  const exited = once(app.child, 'exit');
  app.child.kill('SIGTERM');
  const timer = setTimeout(() => app.child.kill('SIGKILL'), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(app, url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (app.error) throw app.error;
    assert.equal(app.child.exitCode, null, app.logs);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await delay(100);
  }
  assert.fail('Startup timed out: ' + app.logs);
}

test('all eight apps run concurrently and expose independent health endpoints', { timeout: 30000 }, async t => {
  const running = [];
  t.after(async () => { await Promise.all(running.map(stop)); });

  for (const [name, portEnv] of applications) {
    const port = await allocatePort();
    const app = start(name, { [portEnv]: String(port) });
    running.push(Object.assign(app, { name, url: 'http://127.0.0.1:' + port }));
  }

  await Promise.all(running.map(app => waitForHealth(app, app.url + '/health/live')));
  const instanceIds = new Set();
  for (const app of running) {
    await t.test(app.name, async () => {
      let instanceId;
      for (const endpoint of ['live', 'ready']) {
        const response = await fetch(app.url + '/health/' + endpoint);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(Object.keys(body).sort(), ['checkedAt', 'instanceId', 'service', 'status']);
        assert.equal(body.status, 'UP');
        assert.equal(body.service, app.name);
        assert.match(body.instanceId, /^[0-9a-f-]{36}$/);
        assert.ok(Number.isFinite(Date.parse(body.checkedAt)));
        if (instanceId) assert.equal(body.instanceId, instanceId);
        instanceId = body.instanceId;
      }
      instanceIds.add(instanceId);
      const missing = await fetch(app.url + '/api/v1/not-implemented');
      assert.equal(missing.status, 404);
    });
  }
  assert.equal(instanceIds.size, applications.length);
});

test('invalid port configuration fails startup with a clear error', { timeout: 10000 }, async t => {
  const app = start('api-gateway', { GATEWAY_PORT: 'invalid' });
  t.after(() => stop(app));
  const [code] = await once(app.child, 'exit');
  assert.equal(code, 1);
  assert.match(app.logs, /GATEWAY_PORT must be an integer between 1 and 65535/);
});
