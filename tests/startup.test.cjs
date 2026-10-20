const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { createEnvironment, start, stop } = require('./helpers/identity-environment.cjs');
const apps = [
  ['api-gateway', 'GATEWAY_PORT'],
  ['identity-user-service', 'IDENTITY_PORT'],
  ['driver-vehicle-location-service', 'DRIVER_PORT'],
  ['trip-booking-service', 'TRIP_PORT'],
  ['simulated-payment-service', 'PAYMENT_PORT'],
  ['notification-service', 'NOTIFICATION_PORT'],
  ['matching-service', 'MATCHING_PORT'],
  ['pricing-service', 'PRICING_PORT'],
];

test(
  'all eight apps expose independent health endpoints with real Identity dependencies',
  { timeout: 240000 },
  async t => {
    const fixture = await createEnvironment(t);
    const running = [];

    for (const [name, portEnv] of apps) {
      running.push(await fixture.launch(name, portEnv));
    }

    const ids = new Set();

    for (const app of running) {
      let instance;

      for (const endpoint of ['live', 'ready']) {
        const response = await fetch(app.url + '/health/' + endpoint);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(body).sort(), [
          'checkedAt',
          'instanceId',
          'service',
          'status',
        ]);

        assert.equal(body.status, 'UP');
        assert.equal(body.service, app.name);
        if (instance) {
          assert.equal(body.instanceId, instance);
        }

        instance = body.instanceId;
      }

      ids.add(instance);
      assert.equal((await fetch(app.url + '/api/v1/not-implemented')).status, 404);
    }

    assert.equal(ids.size, 8);
  },
);

test('invalid port fails startup clearly', { timeout: 60000 }, async t => {
  const { generateKeys } = require('../scripts/identity/generate-keys.cjs');
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-port-'));

  generateKeys(directory);
  const app = start('api-gateway', {
    GATEWAY_PORT: 'invalid',
    JWT_ISSUER: 'ride-hailing',
    JWT_AUDIENCE: 'ride-api',
    JWT_PUBLIC_KEY: '',
    JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
  });

  t.after(async () => {
    await stop(app);
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('identity-port-')
    ) {
      throw new Error('Unsafe temporary cleanup target');
    }

    fs.rmSync(directory, { recursive: true, force: true });
  });

  const [code] = await once(app.child, 'exit');

  assert.equal(code, 1);
  assert.match(app.logs, /GATEWAY_PORT must be an integer between 1 and 65535/);
});
