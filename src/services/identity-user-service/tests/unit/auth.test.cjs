require('reflect-metadata');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { JwtModule, JwtService } = require('@nestjs/jwt');
const { Reflector } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { generateKeys } = require('../../../../../scripts/identity/generate-keys.cjs');
const { JwtAuthGuard, RolesGuard, JWT_VERIFIER_OPTIONS } = require('@app/auth');
const { verifierOptions, signingOptions } = require('@app/auth');
const { RegisterRequest, LoginRequest } = require('../../src/auth/dto/auth.dto');
const { PUBLIC_ROUTE_METADATA } = require('@app/shared-types');
const { ROLES_METADATA } = require('../../../../packages/auth/src/decorators');
let directory, env, testingModule, guard, roles, jwt;

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-unit-'));
  generateKeys(directory);
  env = {
    JWT_PUBLIC_KEY_FILE: path.join(directory, 'identity-public.pem'),
    JWT_PRIVATE_KEY_FILE: path.join(directory, 'identity-private.pem'),
    JWT_PUBLIC_KEY: '',
    JWT_PRIVATE_KEY: '',
    JWT_ISSUER: 'ride-hailing',
    JWT_AUDIENCE: 'ride-api',
  };

  testingModule = await Test.createTestingModule({
    imports: [JwtModule.register({})],
    providers: [
      Reflector,
      JwtAuthGuard,
      RolesGuard,
      { provide: JWT_VERIFIER_OPTIONS, useValue: verifierOptions(env) },
    ],
  }).compile();

  guard = testingModule.get(JwtAuthGuard);
  roles = testingModule.get(RolesGuard);
  jwt = testingModule.get(JwtService);
});

after(async () => {
  await testingModule?.close();
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('identity-unit-')
  ) {
    throw new Error('Unsafe temporary cleanup target');
  }

  fs.rmSync(directory, { recursive: true, force: true });
});

function context(token, role) {
  const handler = () => {};

  if (role) {
    Reflect.defineMetadata(ROLES_METADATA, [role], handler);
  }

  const request = { headers: token ? { authorization: 'Bearer ' + token } : {} };

  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  };
}

function token(payload = {}, options = {}) {
  const signing = signingOptions(env);

  return jwt.sign(
    { role: 'DRIVER', ...payload },
    {
      privateKey: signing.privateKey,
      algorithm: 'RS256',
      subject: randomUUID(),
      issuer: 'ride-hailing',
      audience: 'ride-api',
      expiresIn: 3600,
      ...options,
    },
  );
}

test('JWT guard verifies actor and role without a database or private verifier key', async () => {
  const ctx = context(token(), 'DRIVER');

  ctx.request.headers['x-user-id'] = randomUUID();
  ctx.request.headers['x-role'] = 'PASSENGER';
  assert.equal(await guard.canActivate(ctx), true);
  assert.equal(roles.canActivate(ctx), true);
  assert.equal(ctx.request.actor.role, 'DRIVER');
  assert.notEqual(ctx.request.actor.userId, ctx.request.headers['x-user-id']);
});

test('missing, expired, wrong issuer/audience/signature, missing exp, bad sub/role and HMAC tokens are rejected', async () => {
  const privateKey = fs.readFileSync(env.JWT_PRIVATE_KEY_FILE);
  const otherDir = path.join(directory, 'other');

  generateKeys(otherDir);
  const badTokens = [
    undefined,
    token({}, { expiresIn: -1 }),
    token({}, { issuer: 'wrong' }),
    token({}, { audience: 'wrong' }),
    token({ role: 'ADMIN' }),
    token({}, { subject: 'not-uuid' }),
    jwt.sign(
      { role: 'DRIVER', sub: randomUUID(), iss: 'ride-hailing', aud: 'ride-api' },
      { privateKey, algorithm: 'RS256' },
    ),
    token({}, { privateKey: fs.readFileSync(path.join(otherDir, 'identity-private.pem')) }),
    jwt.sign(
      { role: 'DRIVER' },
      { secret: 'invalid-shared-secret', algorithm: 'HS256', expiresIn: 3600 },
    ),
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') +
      '.' +
      Buffer.from('{}').toString('base64url') +
      '.',
  ];

  for (const value of badTokens) {
    await assert.rejects(
      () => guard.canActivate(context(value)),
      error => error.getStatus() === 401,
    );
  }
});

test('valid token with wrong role returns 403; public routes need no token', async () => {
  const ctx = context(token({ role: 'PASSENGER' }), 'DRIVER');

  await guard.canActivate(ctx);
  assert.throws(
    () => roles.canActivate(ctx),
    error => error.getStatus() === 403,
  );

  const open = context();

  Reflect.defineMetadata(PUBLIC_ROUTE_METADATA, true, open.getHandler());
  assert.equal(await guard.canActivate(open), true);
});

test('configuration rejects duplicate key sources, mismatched key pair and wrong issuer', () => {
  assert.throws(
    () =>
      verifierOptions({ ...env, JWT_PUBLIC_KEY: fs.readFileSync(env.JWT_PUBLIC_KEY_FILE, 'utf8') }),
    /exactly one/,
  );

  assert.throws(
    () =>
      signingOptions({
        ...env,
        JWT_PRIVATE_KEY_FILE: path.join(directory, 'other/identity-private.pem'),
      }),
    /does not match/,
  );

  assert.throws(() => verifierOptions({ ...env, JWT_ISSUER: 'other' }), /contract/);
});

test('DTO normalizes names/email, rejects unknown fields and checks UTF-8 byte boundaries', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const valid = {
    email: '  USER@EXAMPLE.TEST  ',
    displayName: '  Name  ',
    role: 'PASSENGER',
    password: 'a'.repeat(72),
  };
  const result = await pipe.transform(valid, { type: 'body', metatype: RegisterRequest });

  assert.equal(result.email, 'user@example.test');
  assert.equal(result.displayName, 'Name');
  assert.equal(result.password.length, 72);
  for (const body of [
    { ...valid, password: 'a'.repeat(9) },
    { ...valid, password: 'ðŸ˜€'.repeat(19) },
    { ...valid, password: 'a'.repeat(73) },
    { ...valid, role: 'ADMIN' },
    { ...valid, displayName: ' ' },
    { ...valid, amount: '1000' },
  ]) {
    await assert.rejects(() => pipe.transform(body, { type: 'body', metatype: RegisterRequest }));
  }

  const preserved = await pipe.transform(
    { email: 'a@b.test', password: '  password  ' },
    { type: 'body', metatype: LoginRequest },
  );

  assert.equal(preserved.password, '  password  ');
});
