const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createTripDatabase } = require('../../../../../tests/helpers/trip-environment.cjs');

const POINT = JSON.stringify({ lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' });

test('Trip migration, constraints and role permissions on real PostgreSQL', { timeout: 180000 }, async t => {
  const trip = await createTripDatabase(t);

  async function insertTrip(fields = {}) {
    const row = {
      id: randomUUID(),
      passengerId: randomUUID(),
      driverId: null,
      quoteId: randomUUID(),
      assignmentId: null,
      status: 'MATCHING',
      paymentId: null,
      paymentStatus: 'NOT_REQUESTED',
      ...fields,
    };

    await trip.appQuery(
      `INSERT INTO trip_schema.trips
         (id, passenger_id, driver_id, quote_id, assignment_id, pickup, dropoff, status, payment_id, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $6::jsonb, $7, $8, $9)`,
      [
        row.id,
        row.passengerId,
        row.driverId,
        row.quoteId,
        row.assignmentId,
        POINT,
        row.status,
        row.paymentId,
        row.paymentStatus,
      ],
    );

    return row;
  }

  function assigned(fields = {}) {
    return insertTrip({
      status: 'ASSIGNED',
      driverId: randomUUID(),
      assignmentId: randomUUID(),
      ...fields,
    });
  }

  async function insertOperation(tripId, type = 'ACCEPT') {
    const id = randomUUID();

    await trip.appQuery(
      `INSERT INTO trip_schema.operations (id, trip_id, actor_id, type, current_step, correlation_id)
       VALUES ($1, $2, $3, $4, 'START', $5)`,
      [id, tripId, randomUUID(), type, randomUUID()],
    );

    return id;
  }

  async function tableNames() {
    const { rows } = await trip.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'trip_schema' ORDER BY 1",
    );

    return rows.map(row => row.table_name);
  }

  const violates = (promise, code, constraint) =>
    assert.rejects(promise, error => {
      assert.equal(error.code, code);

      if (constraint) {
        assert.equal(error.constraint, constraint);
      }

      return true;
    });

  await t.test('migration can run twice, revert and run again', async () => {
    const expected = [
      'fare_snapshots',
      'idempotency_keys',
      'operations',
      'outbox_events',
      'processed_events',
      'saga_steps',
      'schema_migrations',
      'state_history',
      'trips',
    ];

    assert.deepEqual(await tableNames(), expected);
    trip.migrate();
    assert.equal(
      (await trip.query('SELECT count(*)::int AS n FROM trip_schema.schema_migrations')).rows[0].n,
      1,
    );

    trip.revert();
    assert.deepEqual(await tableNames(), ['schema_migrations']);

    trip.migrate();
    assert.deepEqual(await tableNames(), expected);
  });

  await t.test('trip_app can write the normal flow of a trip', async () => {
    const { id } = await insertTrip();

    await trip.appQuery(
      `INSERT INTO trip_schema.fare_snapshots (trip_id, amount, rule_version, distance_meters, duration_seconds)
       VALUES ($1, 41000, 'CAR_V1', 3000, 600)`,
      [id],
    );
    await trip.appQuery(
      `INSERT INTO trip_schema.state_history (id, trip_id, to_status, command_id, correlation_id)
       VALUES ($1, $2, 'MATCHING', $3, $4)`,
      [randomUUID(), id, randomUUID(), randomUUID()],
    );

    const operationId = await insertOperation(id);

    await trip.appQuery(
      'INSERT INTO trip_schema.saga_steps (operation_id, step, command_id) VALUES ($1, $2, $3)',
      [operationId, 'CLAIM_OFFER', randomUUID()],
    );

    const updated = await trip.appQuery(
      `UPDATE trip_schema.trips SET status = 'ASSIGNING', assignment_id = $2, version = version + 1
       WHERE id = $1 AND status = 'MATCHING' AND version = 1`,
      [id, randomUUID()],
    );

    assert.equal(updated.rowCount, 1);
  });

  await t.test('assigned states require a driver and an assignment', async () => {
    await violates(
      insertTrip({ status: 'ASSIGNED', assignmentId: randomUUID() }),
      '23514',
      'ck_trips_assigned_fields',
    );
    await violates(
      insertTrip({ status: 'IN_PROGRESS', driverId: randomUUID() }),
      '23514',
      'ck_trips_assigned_fields',
    );
  });

  await t.test('payment states require a completed trip and a payment id', async () => {
    await violates(
      assigned({ paymentStatus: 'PENDING', paymentId: randomUUID() }),
      '23514',
      'ck_trips_payment',
    );
    await violates(
      assigned({ status: 'COMPLETED', paymentStatus: 'PENDING' }),
      '23514',
      'ck_trips_payment',
    );
    await assigned({ status: 'COMPLETED', paymentStatus: 'PENDING', paymentId: randomUUID() });
  });

  await t.test('a driver has at most one active trip, finished trips do not count', async () => {
    const driverId = randomUUID();

    await assigned({ driverId, status: 'COMPLETED' });
    await assigned({ driverId });
    await violates(assigned({ driverId }), '23505', 'uq_trips_active_driver');
    await violates(assigned({ driverId, status: 'IN_PROGRESS' }), '23505', 'uq_trips_active_driver');
  });

  await t.test('uniqueness of quote, COMPLETE operation and saga command', async () => {
    const quoteId = randomUUID();

    await insertTrip({ quoteId });
    await violates(insertTrip({ quoteId }), '23505', 'uq_trips_quote');

    const { id } = await assigned({ status: 'COMPLETED' });

    await insertOperation(id, 'COMPLETE');
    await violates(insertOperation(id, 'COMPLETE'), '23505', 'uq_operations_complete');

    const operationId = await insertOperation(id);
    const commandId = randomUUID();
    const step = (name, command) =>
      trip.appQuery(
        'INSERT INTO trip_schema.saga_steps (operation_id, step, command_id) VALUES ($1, $2, $3)',
        [operationId, name, command],
      );

    await step('RESERVE_DRIVER', commandId);
    await violates(step('CONFIRM_DRIVER', commandId), '23505', 'uq_saga_steps_command');
  });

  await t.test('trip_app cannot rewrite price or history, delete, or change the schema', async () => {
    const { id } = await insertTrip();

    await trip.appQuery(
      `INSERT INTO trip_schema.fare_snapshots (trip_id, amount, rule_version, distance_meters, duration_seconds)
       VALUES ($1, 41000, 'CAR_V1', 3000, 600)`,
      [id],
    );

    for (const sql of [
      'UPDATE trip_schema.fare_snapshots SET amount = 1',
      "UPDATE trip_schema.state_history SET to_status = 'CANCELLED'",
      'DELETE FROM trip_schema.trips',
      'DELETE FROM trip_schema.outbox_events',
      'DELETE FROM trip_schema.state_history',
      'TRUNCATE trip_schema.trips CASCADE',
      'SELECT * FROM trip_schema.schema_migrations',
      'CREATE TABLE trip_schema.x (id int)',
      'CREATE TABLE public.x (id int)',
    ]) {
      await violates(trip.appQuery(sql), '42501');
    }
  });
});
