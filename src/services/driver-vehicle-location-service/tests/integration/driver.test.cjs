const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID, randomBytes } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { Client } = require('pg');
const { spawnSync } = require('node:child_process');
const {
  createEnvironment,
  docker,
  eventually,
  stop,
  root,
} = require('../../../../../tests/helpers/identity-environment.cjs');
const { createDriverDatabase } = require('../../../../../tests/helpers/driver-environment.cjs');

test(
  'Driver APIs with real Identity, PostgreSQL and concurrent reservations',
  { timeout: 240000 },
  async t => {
    const identityDb = await createEnvironment(t);
    const db = await createDriverDatabase(t);
    const identity = await identityDb.launch('identity-user-service', 'IDENTITY_PORT');
    const tripToken = randomBytes(32).toString('base64url');
    const matchingToken = randomBytes(32).toString('base64url');
    const driverEnv = {
      ...db.env,
      SVC_TOKEN_TRIP_DRIVER: tripToken,
      SVC_TOKEN_MATCHING_DRIVER: matchingToken,
    };
    let driver = await identityDb.launch(
      'driver-vehicle-location-service',
      'DRIVER_PORT',
      driverEnv,
    );

    async function request(origin, path, method = 'GET', body, headers = {}) {
      const response = await fetch(origin + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });

      return { status: response.status, body: await response.json() };
    }

    async function account(role) {
      const credentials = {
        email: 'driver-test-' + randomUUID() + '@example.test',
        password: 'TestPass!2026',
      };
      const registered = await request(identity.url, '/api/v1/auth/register', 'POST', {
        ...credentials,
        displayName: 'Driver integration test',
        role,
      });

      assert.equal(registered.status, 201);
      const login = await request(identity.url, '/api/v1/auth/login', 'POST', credentials);

      assert.equal(login.status, 200);

      return { id: login.body.user.id, token: login.body.accessToken, ...credentials };
    }

    const drivers = [];

    for (let i = 0; i < 5; i++) {
      drivers.push(await account('DRIVER'));
    }

    const passenger = await account('PASSENGER');
    const call = (user, path, method = 'GET', body, key) =>
      request(driver.url, path, method, body, {
        Authorization: 'Bearer ' + user.token,
        ...(key ? { 'Idempotency-Key': key } : {}),
      });
    const profile = user => call(user, '/api/v1/drivers/me');
    const upsert = (user, licenseNumber = 'LICENSE-' + user.id.slice(0, 8)) =>
      call(user, '/api/v1/drivers/me', 'PUT', { licenseNumber });
    const vehicleBody = user => ({
      plateNumber: 'DEMO-' + user.id.slice(0, 8),
      model: 'Sedan',
      color: 'White',
    });
    const vehicle = (user, body = vehicleBody(user), key = randomUUID()) =>
      call(user, '/api/v1/vehicles', 'POST', body, key);
    const availability = (user, online, version, key = randomUUID()) =>
      call(
        user,
        '/api/v1/drivers/me/status',
        'PATCH',
        {
          online,
          expectedVersion: version,
        },
        key,
      );
    const locationBody = (sequence, zoneId = 'ZONE_A') => ({
      position: { lat: 10.77123456, lng: 106.69, zoneId },
      sequence,
      recordedAt: new Date().toISOString(),
    });
    const gps = (user, body) => call(user, '/api/v1/drivers/me/location', 'PUT', body);
    const candidates = (query = 'zoneId=ZONE_A&limit=10', token = matchingToken) =>
      request(driver.url, '/internal/v1/drivers/candidates?' + query, 'GET', undefined, {
        'X-Service-Token': token,
      });
    const internal = (path, method = 'GET', body, token = tripToken) =>
      request(driver.url, path, method, body, { 'X-Service-Token': token });
    const reserve = (user, tripId = randomUUID(), id = randomUUID(), offerId = randomUUID()) =>
      internal('/internal/v1/reservations/' + id, 'PUT', { tripId, driverId: user.id, offerId });
    const confirm = (reservation, commandId = randomUUID(), changes = {}) =>
      internal('/internal/v1/reservations/' + reservation.id + '/confirm', 'POST', {
        commandId,
        tripId: reservation.tripId,
        driverId: reservation.driverId,
        ...changes,
      });
    const release = (reservation, commandId = randomUUID(), changes = {}) =>
      internal('/internal/v1/reservations/' + reservation.id + '/release', 'POST', {
        commandId,
        tripId: reservation.tripId,
        driverId: reservation.driverId,
        reason: 'ASSIGNMENT_FAILED',
        ...changes,
      });
    const lookup = id => internal('/internal/v1/reservations/' + id);

    async function ready(user, zone = 'ZONE_A') {
      await upsert(user);
      const car = await call(user, '/api/v1/vehicles/me');

      if (car.status === 404) {
        assert.equal((await vehicle(user)).status, 201);
      }

      let current = (await profile(user)).body;

      assert.equal((await gps(user, locationBody(current.locationSequence + 1, zone))).status, 200);
      current = (await profile(user)).body;
      let result = await availability(user, true, current.version);

      if (result.body.code === 'VERSION_CONFLICT') {
        current = (await profile(user)).body;
        result = await availability(user, true, current.version);
      }

      assert.equal(result.status, 200, JSON.stringify(result.body));

      return result.body;
    }

    await t.test('JWT/roles/internal allowlists; missing profile and vehicle errors', async () => {
      assert.equal((await request(driver.url, '/api/v1/drivers/me')).status, 401);
      for (const [path, method, body] of [
        ['/api/v1/drivers/me', 'PUT', { licenseNumber: 'DEMO' }],
        ['/api/v1/vehicles', 'POST', vehicleBody(drivers[0])],
        ['/api/v1/drivers/me/location', 'PUT', locationBody(1)],
        ['/api/v1/drivers/me/status', 'PATCH', { online: true, expectedVersion: 1 }],
      ]) {
        assert.equal((await call(passenger, path, method, body, randomUUID())).status, 403);
      }

      assert.equal((await profile(drivers[4])).body.code, 'DRIVER_NOT_ONBOARDED');
      assert.equal((await call(drivers[4], '/api/v1/vehicles/me')).body.code, 'VEHICLE_NOT_FOUND');
      assert.equal((await vehicle(drivers[4])).body.code, 'DRIVER_NOT_ONBOARDED');
      assert.equal((await gps(drivers[4], locationBody(1))).status, 409);
      assert.equal(
        (await release({ id: randomUUID(), tripId: randomUUID(), driverId: drivers[4].id })).status,
        409,
      );
      assert.equal((await candidates('zoneId=ZONE_A', tripToken)).status, 403);
      assert.equal((await candidates('zoneId=ZONE_A', 'wrong')).status, 401);
      assert.equal(
        (
          await internal(
            '/internal/v1/reservations/' + randomUUID(),
            'GET',
            undefined,
            matchingToken,
          )
        ).status,
        403,
      );
    });

    await t.test(
      'profile upsert is concurrent-safe and repeated content does not reset or bump version',
      async () => {
        db.migrate();
        const results = await Promise.all(Array.from({ length: 10 }, () => upsert(drivers[0])));

        for (const result of results) {
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.version, 1);
          assert.equal(result.body.online, false);
          assert.equal(result.body.locationSequence, 0);
          assert.equal(result.body.status, 'OFFLINE');
        }

        assert.equal(
          (
            await db.query('SELECT count(*)::int AS n FROM driver_schema.drivers WHERE id=$1', [
              drivers[0].id,
            ])
          ).rows[0].n,
          1,
        );
        assert.equal((await upsert(drivers[0], 'UPDATED-LICENSE')).body.version, 2);
        assert.equal((await profile(drivers[0])).body.licenseNumber, 'UPDATED-LICENSE');
      },
    );

    await t.test(
      'vehicle canonicalization and concurrent key replay create one vehicle',
      async () => {
        const user = drivers[0];
        const key = randomUUID();
        const body = { plateNumber: ' demo-001 ', model: ' Sedan ', color: ' White ' };
        const results = await Promise.all(
          Array.from({ length: 10 }, () => vehicle(user, body, key)),
        );

        for (const result of results) {
          assert.equal(result.status, 201, JSON.stringify(result.body));
          assert.deepEqual(result.body, results[0].body);
          assert.equal(result.body.plateNumber, 'DEMO-001');
          assert.equal(result.body.model, 'Sedan');
          assert.equal(result.body.vehicleType, 'CAR');
        }

        assert.deepEqual(
          (await vehicle(user, { plateNumber: 'DEMO-001', model: 'Sedan', color: 'White' }, key))
            .body,
          results[0].body,
        );
        assert.equal(
          (await vehicle(user, { ...body, color: 'Black' }, key)).body.code,
          'IDEMPOTENCY_CONFLICT',
        );
        assert.equal((await vehicle(user)).body.code, 'VEHICLE_EXISTS');
        assert.equal((await call(drivers[1], '/api/v1/vehicles/me')).status, 404);
      },
    );

    await t.test(
      'two drivers registering the same canonical plate cannot bypass uniqueness',
      async () => {
        await upsert(drivers[1]);
        await upsert(drivers[2]);
        const results = await Promise.all([
          vehicle(drivers[1], { ...vehicleBody(drivers[1]), plateNumber: 'shared-001' }),
          vehicle(drivers[2], { ...vehicleBody(drivers[2]), plateNumber: ' SHARED-001 ' }),
        ]);

        assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
        assert.equal(results.find(result => result.status === 409).body.code, 'PLATE_EXISTS');
        const loser = results[0].status === 409 ? drivers[1] : drivers[2];

        assert.equal((await vehicle(loser)).status, 201);
      },
    );

    await t.test('going online requires a vehicle and fresh GPS', async () => {
      await upsert(drivers[3]);
      assert.equal((await availability(drivers[3], true, 1)).body.code, 'VEHICLE_NOT_FOUND');
      const current = (await profile(drivers[0])).body;

      assert.equal(
        (await availability(drivers[0], true, current.version)).body.code,
        'LOCATION_STALE',
      );
    });

    await t.test(
      'GPS sequence, replay, clock skew and validation; GPS never changes profile version',
      async () => {
        const user = drivers[0];
        const before = (await profile(user)).body;
        const body = locationBody(1);
        const first = await gps(user, body);

        assert.equal(first.status, 200);
        assert.equal(first.body.position.lat, 10.771235);
        assert.deepEqual((await gps(user, body)).body, first.body);
        assert.equal(
          (await gps(user, { ...body, position: { ...body.position, lat: 11 } })).body.code,
          'SEQUENCE_CONFLICT',
        );
        assert.equal(
          (
            await gps(user, {
              ...locationBody(2),
              recordedAt: new Date(Date.now() - 120000).toISOString(),
            })
          ).body.code,
          'CLOCK_SKEW',
        );
        assert.equal(
          (await gps(user, { ...locationBody(2), position: { ...body.position, lat: 91 } })).body
            .code,
          'INVALID_COORDINATE',
        );
        assert.equal(
          (await gps(user, { ...locationBody(2), recordedAt: '2026-10-25T10:00:00' })).status,
          400,
        );
        assert.equal(
          (await gps(user, { ...locationBody(Number.MAX_SAFE_INTEGER + 1) })).status,
          400,
        );
        assert.equal((await profile(user)).body.version, before.version);
        const second = locationBody(2);

        assert.equal((await gps(user, second)).status, 200);
        assert.equal((await gps(user, body)).body.code, 'STALE_LOCATION');
        const race = await Promise.all([gps(user, locationBody(3)), gps(user, locationBody(4))]);

        assert.ok(race.every(result => [200, 409].includes(result.status)));
        assert.equal((await profile(user)).body.locationSequence, 4);
        const oldTime = new Date(Date.now() - 120000).toISOString();

        await db.query(
          'UPDATE driver_schema.latest_locations SET recorded_at=$2, received_at=$2 WHERE driver_id=$1',
          [user.id, oldTime],
        );
        const oldReplay = await gps(user, { ...locationBody(4), recordedAt: oldTime });

        assert.equal(oldReplay.status, 200);
        assert.equal(oldReplay.body.receivedAt, oldTime);
        assert.equal((await profile(user)).body.locationFresh, false);
      },
    );

    await t.test(
      'online version checks, idempotency replay and profile updates preserve online state',
      async () => {
        const user = drivers[0];
        const initial = (await profile(user)).body;

        await gps(user, locationBody(initial.locationSequence + 1));
        const key = randomUUID();
        const first = await availability(user, true, initial.version, key);

        assert.equal(first.status, 200);
        assert.equal(first.body.status, 'AVAILABLE');
        assert.deepEqual((await availability(user, true, initial.version, key)).body, first.body);
        assert.equal(
          (await availability(user, false, initial.version, key)).body.code,
          'IDEMPOTENCY_CONFLICT',
        );
        assert.equal(
          (await availability(user, false, initial.version)).body.code,
          'VERSION_CONFLICT',
        );
        const updated = await upsert(user, 'ONLINE-LICENSE');

        assert.equal(updated.body.online, true);
        assert.equal(updated.body.status, 'AVAILABLE');
      },
    );

    await t.test(
      'candidates are sorted, zone-limited and exclude offline/stale/incomplete drivers',
      async () => {
        await ready(drivers[1]);
        await ready(drivers[2], 'ZONE_B');
        const result = await candidates();
        const expected = [drivers[0].id, drivers[1].id].sort();

        assert.equal(result.status, 200);
        assert.deepEqual(
          result.body.items.map(item => item.driverId),
          expected,
        );
        assert.deepEqual(
          (await candidates('zoneId=ZONE_A&limit=1')).body.items.map(item => item.driverId),
          expected.slice(0, 1),
        );
        assert.deepEqual(
          (await candidates('zoneId=ZONE_B')).body.items.map(item => item.driverId),
          [drivers[2].id],
        );
        await db.query(
          `UPDATE driver_schema.latest_locations SET received_at=clock_timestamp()-interval '61 seconds' WHERE driver_id=$1`,
          [drivers[1].id],
        );
        assert.equal((await profile(drivers[1])).body.status, 'OFFLINE');
        assert.deepEqual(
          (await candidates()).body.items.map(item => item.driverId),
          [drivers[0].id],
        );
        assert.equal((await candidates('zoneId=ZONE_C')).body.code, 'INVALID_ZONE');
        assert.equal((await candidates('zoneId=ZONE_A&limit=11')).status, 400);
        assert.equal((await candidates('zoneId=ZONE_A&extra=1')).status, 400);
      },
    );

    await t.test(
      'two trips race for one driver; reserve replay preserves its original 30-second lease',
      async () => {
        const user = drivers[0];

        await ready(user);
        const results = await Promise.all([reserve(user), reserve(user)]);

        assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
        const held = results.find(result => result.status === 200).body;
        const ttl = (
          await db.query(
            'SELECT extract(epoch FROM (expires_at-created_at))::int AS ttl FROM driver_schema.reservations WHERE id=$1',
            [held.id],
          )
        ).rows[0].ttl;

        assert.equal(ttl, 30);
        const retries = await Promise.all(
          Array.from({ length: 10 }, () => reserve(user, held.tripId, held.id, held.offerId)),
        );

        for (const retry of retries) {
          assert.deepEqual(retry.body, held);
        }

        assert.equal(
          (await reserve(user, randomUUID(), held.id, held.offerId)).body.code,
          'IDEMPOTENCY_CONFLICT',
        );
        const current = (await profile(user)).body;

        assert.equal(current.status, 'RESERVED');
        assert.equal(
          (await availability(user, false, current.version)).body.code,
          'ACTIVE_RESERVATION',
        );
        assert.ok(!(await candidates()).body.items.some(item => item.driverId === user.id));
        assert.equal((await release(held)).status, 200);
      },
    );

    await t.test('one trip cannot reserve two different drivers concurrently', async () => {
      await ready(drivers[0]);
      await ready(drivers[1]);
      const tripId = randomUUID();
      const results = await Promise.all([reserve(drivers[0], tripId), reserve(drivers[1], tripId)]);

      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM driver_schema.reservations WHERE trip_id=$1 AND status IN ('HELD','CONFIRMED')",
            [tripId],
          )
        ).rows[0].n,
        1,
      );
      await release(results.find(result => result.status === 200).body);
    });

    await t.test(
      'confirm/release ownership and command replay; confirmed leases never expire automatically',
      async () => {
        await ready(drivers[0]);
        const held = (await reserve(drivers[0])).body;
        const command = randomUUID();
        const confirmed = await confirm(held, command);

        assert.equal(confirmed.status, 200);
        assert.equal(confirmed.body.status, 'CONFIRMED');
        assert.equal(confirmed.body.expiresAt, undefined);
        assert.equal((await profile(drivers[0])).body.status, 'BUSY');
        assert.deepEqual((await confirm(held, command)).body, confirmed.body);
        assert.equal(
          (await confirm(held, command, { tripId: randomUUID() })).body.code,
          'PAYLOAD_MISMATCH',
        );
        assert.equal(
          (await confirm(held, randomUUID(), { driverId: drivers[1].id })).body.code,
          'PAYLOAD_MISMATCH',
        );
        await db.query(
          `UPDATE driver_schema.reservations SET created_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
          [held.id],
        );
        await sleep(1100);
        assert.equal((await lookup(held.id)).body.status, 'CONFIRMED');
        const releaseCommand = randomUUID();
        const released = await release(held, releaseCommand);

        assert.equal(released.body.status, 'RELEASED');
        assert.deepEqual((await release(held, releaseCommand)).body, released.body);
        assert.equal(
          (await release(held, releaseCommand, { reason: 'TRIP_CANCELLED' })).body.code,
          'PAYLOAD_MISMATCH',
        );
        assert.equal((await confirm(held)).body.code, 'RESERVATION_CLOSED');
        assert.deepEqual((await confirm(held, command)).body, confirmed.body);
        assert.equal((await lookup(held.id)).body.status, 'RELEASED');
      },
    );

    await t.test(
      'release before reserve creates a permanent tombstone; unknown reservations return 404',
      async () => {
        const reservation = { id: randomUUID(), tripId: randomUUID(), driverId: drivers[0].id };
        const result = await release(reservation);

        assert.equal(result.status, 200);
        assert.equal(result.body.status, 'RELEASED');
        assert.equal(result.body.offerId, undefined);
        assert.equal(
          (await reserve(drivers[0], reservation.tripId, reservation.id)).body.code,
          'RESERVATION_CLOSED',
        );
        assert.equal(
          (await release(reservation, randomUUID(), { tripId: randomUUID() })).body.code,
          'PAYLOAD_MISMATCH',
        );
        assert.equal((await lookup(randomUUID())).body.code, 'RESERVATION_NOT_FOUND');
      },
    );

    await t.test(
      'worker expires HELD; a new reserve also clears expired holds without waiting for the worker',
      async () => {
        await ready(drivers[0]);
        const first = (await reserve(drivers[0])).body;

        await db.query(
          `UPDATE driver_schema.reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [first.id],
        );
        const next = await reserve(drivers[0]);

        assert.equal(next.status, 200, JSON.stringify(next.body));
        assert.equal((await lookup(first.id)).body.status, 'EXPIRED');
        assert.equal((await confirm(first)).body.code, 'RESERVATION_EXPIRED');
        await db.query(
          `UPDATE driver_schema.reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [next.body.id],
        );
        await eventually(
          async () => assert.equal((await lookup(next.body.id)).body.status, 'EXPIRED'),
          10000,
        );
        assert.equal((await lookup(next.body.id)).body.expiresAt, undefined);
      },
    );

    await t.test(
      'confirm uses DB clock after waiting for the driver lock, not transaction start time',
      async () => {
        await ready(drivers[0]);
        const held = (await reserve(drivers[0])).body;
        const blocker = new Client({ connectionString: db.env.DRIVER_MIGRATION_DATABASE_URL });

        await blocker.connect();
        let confirmation;

        try {
          await blocker.query('BEGIN');
          await blocker.query('SELECT id FROM driver_schema.drivers WHERE id=$1 FOR UPDATE', [
            held.driverId,
          ]);
          await blocker.query(
            `UPDATE driver_schema.reservations SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1`,
            [held.id],
          );
          confirmation = confirm(held);
          await sleep(300);
          await blocker.query('COMMIT');
          const result = await confirmation;

          assert.equal(result.status, 409);
          assert.equal(result.body.code, 'RESERVATION_EXPIRED');
        } finally {
          await blocker.query('ROLLBACK');
          await blocker.end();
          await confirmation;
        }
      },
    );

    await t.test('offline and reserve race cannot both succeed', async () => {
      for (let i = 0; i < 3; i++) {
        const current = await ready(drivers[0]);
        const [offline, held] = await Promise.all([
          availability(drivers[0], false, current.version),
          reserve(drivers[0]),
        ]);

        assert.ok([200, 409].includes(offline.status));
        assert.ok([200, 409].includes(held.status));
        assert.equal([offline.status, held.status].filter(status => status === 200).length, 1);
        if (held.status === 200) {
          await release(held.body);
        }
      }
    });

    await t.test('concurrent reserve/release never resurrects an assignment', async () => {
      await ready(drivers[0]);
      const reservation = { id: randomUUID(), tripId: randomUUID(), driverId: drivers[0].id };
      const [held, released] = await Promise.all([
        reserve(drivers[0], reservation.tripId, reservation.id),
        release(reservation),
      ]);

      assert.ok([200, 409].includes(held.status));
      assert.equal(released.status, 200);
      assert.equal((await lookup(reservation.id)).body.status, 'RELEASED');
    });

    await t.test(
      'validation prevents forged actor fields and bad UUIDs, keys and GPS bodies',
      async () => {
        assert.equal(
          (
            await call(drivers[0], '/api/v1/drivers/me', 'PUT', {
              licenseNumber: 'VALID',
              driverId: drivers[1].id,
            })
          ).status,
          400,
        );
        assert.equal((await upsert(drivers[0], '  ')).status, 400);
        assert.equal(
          (await call(drivers[0], '/api/v1/vehicles', 'POST', vehicleBody(drivers[0]))).status,
          400,
        );
        assert.equal(
          (await call(drivers[0], '/api/v1/vehicles', 'POST', vehicleBody(drivers[0]), 'bad'))
            .status,
          400,
        );
        assert.equal((await gps(drivers[0], { ...locationBody(100), position: [] })).status, 400);
        assert.equal((await internal('/internal/v1/reservations/invalid')).status, 400);
        assert.equal(
          (
            await internal('/internal/v1/reservations/' + randomUUID(), 'PUT', {
              driverId: drivers[0].id,
              tripId: 'invalid',
              offerId: randomUUID(),
            })
          ).status,
          400,
        );
      },
    );

    await t.test(
      'app DB role cannot delete reservation tombstones or change migration history',
      async () => {
        await assert.rejects(
          () => db.appQuery('DELETE FROM driver_schema.reservations'),
          error => error.code === '42501',
        );
        await assert.rejects(
          () => db.appQuery('TRUNCATE driver_schema.drivers CASCADE'),
          error => error.code === '42501',
        );
      },
    );

    await t.test('worker resumes cleanup after a service restart', async () => {
      await ready(drivers[0]);
      const held = (await reserve(drivers[0])).body;

      await stop(driver);
      await db.query(
        `UPDATE driver_schema.reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [held.id],
      );
      driver = await identityDb.launch('driver-vehicle-location-service', 'DRIVER_PORT', driverEnv);
      await eventually(
        async () => assert.equal((await lookup(held.id)).body.status, 'EXPIRED'),
        10000,
      );
      assert.equal((await profile(drivers[0])).status, 200);
    });

    await t.test(
      'demo uses real Identity onboarding; simulator restart resumes the saved sequence',
      async () => {
        const user = drivers[4];

        for (let sequence = 1; sequence <= 2; sequence++) {
          const result = spawnSync(
            process.execPath,
            ['scripts/simulation/driver-gps.cjs', '--once'],
            {
              cwd: root,
              env: {
                ...process.env,
                IDENTITY_BASE_URL: identity.url,
                DRIVER_BASE_URL: driver.url,
                DRIVER_DEMO_EMAIL: user.email,
                DRIVER_DEMO_PASSWORD: user.password,
              },
              encoding: 'utf8',
              timeout: 20000,
            },
          );

          assert.equal(result.status, 0, result.stderr);
          const current = (await profile(user)).body;

          assert.equal(current.locationSequence, sequence);
          assert.equal(current.status, 'AVAILABLE');
          assert.ok(!result.stdout.includes(user.password));
          assert.ok(!result.stdout.includes(user.token));
        }
      },
    );

    await t.test(
      'DB outage affects Driver readiness/API; DB restart restores service and same JWT',
      async () => {
        docker(['stop', db.name]);
        try {
          assert.equal((await request(driver.url, '/health/live')).status, 200);
          assert.equal((await request(driver.url, '/health/ready')).status, 503);
          assert.equal((await profile(drivers[0])).status, 503);
          assert.equal((await call(drivers[0], '/api/v1/vehicles/me')).status, 503);
          assert.equal((await request(identity.url, '/health/ready')).status, 200);
        } finally {
          docker(['start', db.name]);
        }

        await eventually(async () =>
          assert.equal((await request(driver.url, '/health/ready')).status, 200),
        );
        assert.equal((await profile(drivers[0])).status, 200);
      },
    );
  },
);
