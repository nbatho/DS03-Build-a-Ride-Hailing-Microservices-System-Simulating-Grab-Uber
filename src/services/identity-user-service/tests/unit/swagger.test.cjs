require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Test } = require('@nestjs/testing');
const { RequestMethod } = require('@nestjs/common');
const { ThrottlerModule } = require('@nestjs/throttler');
const { RuntimeModule } = require('@app/runtime');
const { configureSwagger } = require('@app/runtime/swagger');
const { AuthController } = require('../../src/auth/auth.controller');
const { AuthService } = require('../../src/auth/auth.service');
const { UsersController } = require('../../src/users/users.controller');
const { UsersService } = require('../../src/users/users.service');

test('Identity docs come from its controllers and DTOs with examples and JWT security', async t => {
  // Only document generation is tested here; business providers are mocked to avoid a DB dependency.
  const module = await Test.createTestingModule({
    imports: [
      RuntimeModule.forRoot('identity-user-service'),
      ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }]),
    ],
    controllers: [AuthController, UsersController],
    providers: [
      { provide: AuthService, useValue: {} },
      { provide: UsersService, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });

  t.after(() => app.close());
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });

  configureSwagger(app, 'identity-user-service');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const response = await fetch(base + '/docs-json');

  assert.equal(response.status, 200);
  const docs = await response.json();

  assert.equal(docs.info.title, 'Identity/User Service API');
  assert.deepEqual(
    Object.keys(docs.paths).sort(),
    [
      '/api/v1/auth/register',
      '/api/v1/auth/login',
      '/api/v1/users/me',
      '/health/live',
      '/health/ready',
    ].sort(),
  );

  const register = docs.paths['/api/v1/auth/register'].post;

  assert.deepEqual(register.security, []);
  assert.equal(
    register.requestBody.content['application/json'].examples.driver.value.role,
    'DRIVER',
  );

  assert.equal(
    register.responses['201'].content['application/json'].schema.$ref,
    '#/components/schemas/User',
  );

  assert.equal(register.responses['409'].content['application/json'].example.code, 'EMAIL_EXISTS');
  assert.equal(register.responses['502'], undefined);
  assert.deepEqual(docs.components.schemas.RegisterRequest.properties.role.enum, [
    'PASSENGER',
    'DRIVER',
  ]);

  assert.equal(docs.components.schemas.RegisterRequest.properties.password.minLength, 10);
  assert.equal(docs.components.schemas.RegisterRequest.additionalProperties, false);
  const login = docs.paths['/api/v1/auth/login'].post;

  assert.deepEqual(login.security, []);
  assert.equal(
    login.responses['401'].content['application/json'].example.code,
    'INVALID_CREDENTIALS',
  );

  assert.equal(login.responses['429'].content['application/json'].example.code, 'RATE_LIMITED');
  const me = docs.paths['/api/v1/users/me'].get;

  assert.deepEqual(me.security, [{ bearerAuth: [] }]);
  assert.equal(me.responses['401'].content['application/json'].example.code, 'INVALID_TOKEN');
  assert.ok(!me.parameters.some(parameter => parameter.in === 'query'));
  for (const resource of [
    '/docs',
    '/docs/swagger-ui-init.js',
    '/docs/swagger-ui-bundle.js',
    '/docs/swagger-ui.css',
    '/docs-yaml',
  ]) {
    assert.equal((await fetch(base + resource)).status, 200, resource);
  }
});
