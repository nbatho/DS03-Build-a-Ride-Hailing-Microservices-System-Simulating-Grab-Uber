const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { generateKeys } = require('../scripts/identity/generate-keys.cjs');
const { start, stop, healthy, port } = require('./helpers/identity-environment.cjs');

test('Swagger UI and JWT documentation work without a database', { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds03-swagger-test-'));
  const applications = [];

  t.after(async () => {
    for (const app of applications) {
      await stop(app);
    }

    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('ds03-swagger-test-')
    ) {
      throw new Error('Unsafe temporary cleanup target');
    }

    fs.rmSync(directory, { recursive: true, force: true });
  });

  generateKeys(directory);
  for (const [name, portEnv] of [
    ['api-gateway', 'GATEWAY_PORT'],
    ['driver-vehicle-location-service', 'DRIVER_PORT'],
    ['trip-booking-service', 'TRIP_PORT'],
  ]) {
    await t.test(name, async () => {
      const assigned = await port();
      const app = start(name, {
        [portEnv]: String(assigned),
        JWT_PUBLIC_KEY: '',
        JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
        JWT_ISSUER: 'ride-hailing',
        JWT_AUDIENCE: 'ride-api',
      });

      applications.push(app);
      const base = 'http://127.0.0.1:' + assigned;

      await healthy(app, base);
      const response = await fetch(base + '/docs-json');

      assert.equal(response.status, 200);
      const docs = await response.json();

      assert.equal(docs.servers[0].url, '/', 'Try it out uses the current port');
      assert.equal(docs.components.securitySchemes.bearerAuth.scheme, 'bearer');
      assert.ok(docs.paths['/health/live']);
      assert.equal(docs.paths['/api/v1/health/live'], undefined);
      // Every schema reference in the served document must resolve.
      const inspect = value => {
        if (!value || typeof value !== 'object') {
          return;
        }

        if (value.$ref) {
          assert.ok(value.$ref.startsWith('#/components/schemas/'));
          assert.ok(docs.components.schemas[value.$ref.split('/').at(-1)], value.$ref);
        }

        Object.values(value).forEach(inspect);
      };

      inspect(docs);
      const ui = await fetch(base + '/docs');

      assert.equal(ui.status, 200);
      assert.match(await ui.text(), /swagger-ui/);
      for (const asset of ['swagger-ui-init.js', 'swagger-ui-bundle.js', 'swagger-ui.css']) {
        const resource = await fetch(base + '/docs/' + asset);

        assert.equal(resource.status, 200, name + ' Swagger asset: ' + asset);
        assert.ok((await resource.text()).length > 100);
      }

      const yaml = await fetch(base + '/docs-yaml');

      assert.equal(yaml.status, 200);
      assert.match(await yaml.text(), /openapi:/);
      if (name === 'api-gateway') {
        assert.deepEqual(docs.paths['/api/v1/auth/register'].post.security, []);
        assert.equal(docs.components.schemas.RegisterRequest.example.role, 'PASSENGER');
        assert.ok(docs.paths['/api/v1/auth/login'].post.responses['429']);
        assert.deepEqual(docs.paths['/api/v1/users/me'].get.security, [{ bearerAuth: [] }]);
        assert.ok(docs.paths['/api/v1/users/me'].get.responses['502']);
        assert.equal((await fetch(base + '/api/v1/users/me')).status, 401);
        assert.equal(docs.paths['/api/v1/drivers/me'], undefined);
      } else {
        assert.equal(docs.paths['/api/v1/auth/register'], undefined);
      }

      if (name === 'driver-vehicle-location-service') {
        const me = docs.paths['/api/v1/drivers/me'].get;

        assert.deepEqual(me.security, [{ bearerAuth: [] }]);
        assert.match(me.responses['404'].description, /DRIVER_NOT_ONBOARDED/);
        assert.equal(me.responses['200'], undefined);
        assert.equal((await fetch(base + '/api/v1/drivers/me')).status, 401);
      }
    });
  }
});
