const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JwtService } = require('@nestjs/jwt');
const bcrypt = require('bcrypt');
const {
  createEnvironment,
  start,
  stop,
  healthy,
  docker,
} = require('./helpers/identity-environment.cjs');

test(
  'Identity real PostgreSQL, Gateway and independent Driver JWT verification',
  { timeout: 300000 },
  async t => {
    const fixture = await createEnvironment(t);
    const identity = await fixture.launch('identity-user-service', 'IDENTITY_PORT');
    const gateway = await fixture.launch('api-gateway', 'GATEWAY_PORT', {
      IDENTITY_BASE_URL: identity.url,
    });
    const driver = await fixture.launch('driver-vehicle-location-service', 'DRIVER_PORT');
    const records = [];
    const outcomes = [];

    async function check(name, callback) {
      await t.test(name, async () => {
        try {
          await callback();
          outcomes.push({ name, status: 'PASS' });
        } catch (error) {
          outcomes.push({ name, status: 'FAIL' });
          throw error;
        }
      });
    }

    const correlationId = randomUUID();
    const headers = { 'Content-Type': 'application/json', 'X-Correlation-Id': correlationId };

    async function call(base, route, method = 'GET', body, token, additional = {}) {
      const response = await fetch(base + route, {
        method,
        headers: {
          ...headers,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...additional,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();

      assert.equal(
        response.headers.get('x-correlation-id'),
        additional['X-Correlation-Id'] === 'invalid' ? data.correlationId : correlationId,
      );

      return { response, data };
    }

    const userFields = ['createdAt', 'displayName', 'email', 'id', 'role'];
    let passenger, driverUser, passengerToken, driverToken;

    await check(
      'F01: register both roles, normalize email, hash-only DB and real login/me through Gateway',
      async () => {
        for (const role of ['PASSENGER', 'DRIVER']) {
          const email = role + '-' + randomUUID() + '@EXAMPLE.TEST';
          const password =
            role === 'PASSENGER'
              ? ' '.repeat(2) + 'a'.repeat(68) + ' '.repeat(2)
              : 'DemoPass!' + randomUUID();
          const registration = await call(gateway.url, '/api/v1/auth/register', 'POST', {
            email: ' ' + email + ' ',
            password,
            displayName: '  Demo  ',
            role,
          });

          assert.equal(registration.response.status, 201);
          assert.deepEqual(Object.keys(registration.data).sort(), userFields);
          assert.equal(registration.data.email, email.toLowerCase());
          assert.equal(registration.data.displayName, 'Demo');
          const row = (
            await fixture.query('SELECT * FROM identity_schema.users WHERE id=$1', [
              registration.data.id,
            ])
          ).rows[0];

          assert.match(row.password_hash, /^\$2[aby]\$10\$/);
          assert.equal(await bcrypt.compare(password, row.password_hash), true);
          const login = await call(gateway.url, '/api/v1/auth/login', 'POST', { email, password });

          assert.equal(login.response.status, 200);
          assert.equal(login.data.expiresIn, 3600);
          assert.equal(login.data.tokenType, 'Bearer');
          assert.deepEqual(Object.keys(login.data.user).sort(), userFields);
          const jwt = new JwtService();
          const claims = jwt.verify(login.data.accessToken, {
            publicKey: fs.readFileSync(fixture.env.JWT_PUBLIC_KEY_FILE),
            algorithms: ['RS256'],
            issuer: 'ride-hailing',
            audience: 'ride-api',
          });

          assert.equal(claims.sub, registration.data.id);
          assert.equal(claims.role, role);
          assert.equal(claims.exp - claims.iat, 3600);
          const me = await call(
            gateway.url,
            '/api/v1/users/me',
            'GET',
            undefined,
            login.data.accessToken,
            { 'X-User-Id': randomUUID(), 'X-Role': 'ADMIN', 'X-Service-Token': 'forged' },
          );

          assert.equal(me.response.status, 200);
          assert.equal(me.data.id, registration.data.id);
          if (role === 'PASSENGER') {
            passenger = registration.data;
            passengerToken = login.data.accessToken;
          } else {
            driverUser = registration.data;
            driverToken = login.data.accessToken;
          }

          records.push({ role, userId: registration.data.id, password });
        }
      },
    );

    await check(
      'DB-F01: concurrent normalized email registrations produce one account',
      async () => {
        const email = 'race-' + randomUUID() + '@example.test';
        const make = value =>
          call(gateway.url, '/api/v1/auth/register', 'POST', {
            email: value,
            password: 'ConcurrentPass!2026',
            displayName: 'Race',
            role: 'PASSENGER',
          });
        const results = await Promise.all([make(email.toUpperCase()), make(' ' + email + ' ')]);

        assert.deepEqual(results.map(result => result.response.status).sort(), [201, 409]);
        assert.equal(
          results.find(result => result.response.status === 409).data.code,
          'EMAIL_EXISTS',
        );

        assert.equal(
          (
            await fixture.query(
              'SELECT count(*)::int AS count FROM identity_schema.users WHERE email=$1',
              [email],
            )
          ).rows[0].count,
          1,
        );
      },
    );

    await check(
      'validation, byte boundaries, oversized/malformed JSON and correlation errors are safe',
      async () => {
        const valid = {
          email: 'validation-' + randomUUID() + '@example.test',
          password: 'GoodPassword!2026',
          displayName: 'Test',
          role: 'PASSENGER',
        };

        for (const body of [
          { ...valid, password: 'a'.repeat(9) },
          { ...valid, password: '😀'.repeat(19) },
          { ...valid, role: 'ADMIN' },
          { ...valid, driverId: randomUUID() },
          { ...valid, displayName: ' ' },
        ]) {
          const result = await call(identity.url, '/api/v1/auth/register', 'POST', body);

          assert.equal(result.response.status, 400);
          assert.equal(result.data.code, 'VALIDATION_ERROR');
        }

        const unknownQuery = await call(
          gateway.url,
          '/api/v1/users/me?userId=' + driverUser.id,
          'GET',
          undefined,
          passengerToken,
        );

        assert.equal(unknownQuery.response.status, 400);
        const invalidCorrelation = await call(
          identity.url,
          '/health/live',
          'GET',
          undefined,
          undefined,
          { 'X-Correlation-Id': 'invalid' },
        );

        assert.equal(invalidCorrelation.response.status, 400);
        for (const [body, expected] of [
          ['{broken', 400],
          [JSON.stringify({ padding: 'x'.repeat(65536) }), 413],
        ]) {
          const response = await fetch(identity.url + '/api/v1/auth/register', {
            method: 'POST',
            headers,
            body,
          });
          const data = await response.json();

          assert.equal(response.status, expected);
          assert.equal(data.correlationId, correlationId);
          assert.equal('stack' in data, false);
        }
      },
    );

    await check(
      'S01/S02: missing/invalid JWT, deleted user, role and forged actor boundaries',
      async () => {
        for (const base of [gateway.url, identity.url]) {
          for (const token of [undefined, 'invalid']) {
            const result = await call(base, '/api/v1/users/me', 'GET', undefined, token);

            assert.equal(result.response.status, 401);
            assert.equal(result.data.code, 'INVALID_TOKEN');
          }
        }

        const noDriverToken = await call(driver.url, '/api/v1/drivers/me');

        assert.equal(noDriverToken.response.status, 401);
        const wrongRole = await call(
          driver.url,
          '/api/v1/drivers/me',
          'GET',
          undefined,
          passengerToken,
        );

        assert.equal(wrongRole.response.status, 403);
        assert.equal(wrongRole.data.code, 'ROLE_FORBIDDEN');
        const verified = await call(
          driver.url,
          '/api/v1/drivers/me',
          'GET',
          undefined,
          driverToken,
        );

        assert.equal(verified.response.status, 404);
        assert.equal(verified.data.code, 'DRIVER_NOT_ONBOARDED');
        const noInternalProxy = await call(
          gateway.url,
          '/internal/v1/trips/' + randomUUID(),
          'GET',
          undefined,
          driverToken,
        );

        assert.equal(noInternalProxy.response.status, 404);
        const absent = new JwtService().sign(
          { role: 'PASSENGER' },
          {
            privateKey: fs.readFileSync(fixture.env.JWT_PRIVATE_KEY_FILE),
            algorithm: 'RS256',
            subject: randomUUID(),
            issuer: 'ride-hailing',
            audience: 'ride-api',
            expiresIn: 3600,
          },
        );

        assert.equal(
          (await call(identity.url, '/api/v1/users/me', 'GET', undefined, absent)).response.status,
          401,
        );
      },
    );

    await check(
      'DB-S01: app role is not owner and cannot DDL/TRUNCATE/write migration history/read another schema',
      async () => {
        await fixture.query(
          'CREATE SCHEMA driver_schema; CREATE TABLE driver_schema.test_boundary(id UUID)',
        );

        const owner = await fixture.query(
          "SELECT tableowner FROM pg_tables WHERE schemaname='identity_schema' AND tablename='users'",
        );

        assert.equal(owner.rows[0].tableowner, 'identity_migrator');
        for (const sql of [
          'CREATE TABLE identity_schema.forbidden(id INT)',
          'DROP TABLE identity_schema.users',
          'TRUNCATE identity_schema.users',
          'DELETE FROM identity_schema.users',
          "UPDATE identity_schema.users SET display_name='Changed'",
          'SELECT * FROM driver_schema.test_boundary',
          "INSERT INTO identity_schema.schema_migrations(timestamp,name) VALUES(1,'forbidden')",
        ]) {
          await assert.rejects(
            () => fixture.appQuery(sql),
            error => error.code === '42501',
          );
        }

        await assert.rejects(
          () =>
            fixture.query(
              "INSERT INTO identity_schema.users VALUES($1,'BAD@EXAMPLE.TEST','hash','Name','PASSENGER',now())",
              [randomUUID()],
            ),
          error => error.code === '23514',
        );
      },
    );

    await check(
      'recovery: database down yields 503 without losing process; restart restores data and same JWT',
      async () => {
        docker(['stop', fixture.name]);
        assert.equal((await call(identity.url, '/health/live')).response.status, 200);
        const ready = await call(identity.url, '/health/ready');

        assert.equal(ready.response.status, 503);
        assert.equal(ready.data.code, 'NOT_READY');
        const failed = await call(
          gateway.url,
          '/api/v1/users/me',
          'GET',
          undefined,
          passengerToken,
        );

        assert.equal(failed.response.status, 503);
        assert.equal(failed.data.code, 'DEPENDENCY_UNAVAILABLE');
        docker(['start', fixture.name]);
        await healthy(identity, identity.url);
        assert.equal(
          (await call(identity.url, '/api/v1/users/me', 'GET', undefined, passengerToken)).data.id,
          passenger.id,
        );

        await stop(identity);
        const replacement = start('identity-user-service', {
          ...fixture.env,
          IDENTITY_PORT: new URL(identity.url).port,
        });

        replacement.url = identity.url;
        fixture.applications.push(replacement);
        await healthy(replacement, replacement.url);
        assert.equal(
          (await call(gateway.url, '/api/v1/users/me', 'GET', undefined, passengerToken)).data.id,
          passenger.id,
        );

        fixture.replacement = replacement;
      },
    );

    await check(
      'login rate limit: both success/failure count, forwarding cannot bypass, health is exempt',
      async () => {
        for (let index = 0; index < 10; index++) {
          const result = await call(
            gateway.url,
            '/api/v1/auth/login',
            'POST',
            { email: passenger.email, password: index === 0 ? records[0].password : 'wrong' },
            undefined,
            { 'X-Forwarded-For': '203.0.113.' + index },
          );

          assert.equal(result.response.status, index === 0 ? 200 : 401);
        }

        const exceeded = await call(gateway.url, '/api/v1/auth/login', 'POST', {
          email: passenger.email,
          password: 'wrong',
        });

        assert.equal(exceeded.response.status, 429);
        assert.equal(exceeded.data.code, 'RATE_LIMITED');
        assert.equal((await call(identity.url, '/health/live')).response.status, 200);
      },
    );

    await check(
      'logs redact passwords, tokens, key material and private upstream credentials',
      async () => {
        for (const app of fixture.applications) {
          for (const value of [
            ...records.map(record => record.password),
            passengerToken,
            driverToken,
            'BEGIN PRIVATE KEY',
            fixture.env.IDENTITY_DATABASE_URL,
          ]) {
            assert.equal(
              app.logs.includes(value),
              false,
              'Sensitive value found in logs of ' + app.name,
            );
          }
        }
      },
    );

    const evidenceDirectory = path.join(__dirname, '../docs/test-evidence/identity');

    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDirectory, 'integration.json'),
      JSON.stringify(
        {
          executedAt: new Date().toISOString(),
          status: outcomes.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL',
          outcomes,
          database: 'isolated disposable PostgreSQL 17',
          cases: [
            'F01',
            'DB-F01',
            'S01',
            'S02 Identity/Driver subset',
            'DB-S01',
            'Identity DB/process recovery',
            'login rate limit',
          ],
          correlationId,
          passengerId: passenger.id,
          driverUserId: driverUser.id,
          tokens: '[REDACTED]',
          scope:
            'Identity API and JWT integration; full-system Saga/payment tests are not implemented here',
        },
        null,
        2,
      ) + '\n',
    );
  },
);
