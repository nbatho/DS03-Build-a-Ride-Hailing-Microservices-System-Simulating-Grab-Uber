import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialTrip1792540800000 implements MigrationInterface {
  name = 'InitialTrip1792540800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE trip_schema.trips (
        id UUID PRIMARY KEY,
        passenger_id UUID NOT NULL,
        driver_id UUID NULL,
        quote_id UUID NOT NULL,
        assignment_id UUID NULL,
        pickup JSONB NOT NULL,
        dropoff JSONB NOT NULL,
        status TEXT NOT NULL,
        payment_id UUID NULL,
        payment_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
        payment_attempt_no SMALLINT NOT NULL DEFAULT 0,
        payment_version INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_trips_quote UNIQUE (quote_id),
        CONSTRAINT ck_trips_status CHECK (status IN ('MATCHING', 'ASSIGNING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLING', 'CANCELLED', 'NO_DRIVER')),
        CONSTRAINT ck_trips_payment_status CHECK (payment_status IN ('NOT_REQUESTED', 'PENDING', 'PENDING_RETRY', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT ck_trips_points CHECK (jsonb_typeof(pickup) = 'object' AND jsonb_typeof(dropoff) = 'object'),
        CONSTRAINT ck_trips_versions CHECK (version >= 1 AND payment_version >= 0 AND payment_attempt_no BETWEEN 0 AND 3),
        CONSTRAINT ck_trips_assigned_fields CHECK (status NOT IN ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED') OR (driver_id IS NOT NULL AND assignment_id IS NOT NULL)),
        CONSTRAINT ck_trips_payment CHECK (payment_status = 'NOT_REQUESTED' OR (payment_id IS NOT NULL AND status = 'COMPLETED'))
      )
    `);

    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_trips_active_driver ON trip_schema.trips (driver_id) WHERE status IN ('ASSIGNED', 'IN_PROGRESS')",
    );
    await queryRunner.query(
      'CREATE INDEX ix_trips_passenger ON trip_schema.trips (passenger_id, created_at, id)',
    );
    await queryRunner.query('CREATE INDEX ix_trips_driver ON trip_schema.trips (driver_id, status)');

    await queryRunner.query(`
      CREATE TABLE trip_schema.fare_snapshots (
        trip_id UUID PRIMARY KEY REFERENCES trip_schema.trips (id),
        amount BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'VND',
        rule_version TEXT NOT NULL,
        distance_meters INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        CONSTRAINT ck_fare_amount CHECK (amount >= 0 AND amount <= 99999999999999),
        CONSTRAINT ck_fare_currency CHECK (currency = 'VND'),
        CONSTRAINT ck_fare_inputs CHECK (distance_meters >= 1 AND duration_seconds >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE trip_schema.state_history (
        id UUID PRIMARY KEY,
        trip_id UUID NOT NULL REFERENCES trip_schema.trips (id),
        from_status TEXT NULL,
        to_status TEXT NOT NULL,
        actor_id UUID NULL,
        command_id UUID NOT NULL,
        correlation_id UUID NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_state_history_trip ON trip_schema.state_history (trip_id, occurred_at)',
    );

    await queryRunner.query(`
      CREATE TABLE trip_schema.operations (
        id UUID PRIMARY KEY,
        trip_id UUID NOT NULL REFERENCES trip_schema.trips (id),
        actor_id UUID NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        assignment_id UUID NULL,
        offer_id UUID NULL,
        driver_id UUID NULL,
        current_step TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_token UUID NULL,
        lease_until TIMESTAMPTZ NULL,
        error_code TEXT NULL,
        correlation_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_operations_type CHECK (type IN ('ACCEPT', 'REJECT', 'CANCEL', 'COMPLETE')),
        CONSTRAINT ck_operations_status CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED_COMPENSATED', 'FAILED_NEEDS_REVIEW')),
        CONSTRAINT ck_operations_attempts CHECK (attempt_count >= 0),
        CONSTRAINT ck_operations_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL))
      )
    `);
    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_operations_complete ON trip_schema.operations (trip_id) WHERE type = 'COMPLETE'",
    );
    await queryRunner.query(
      "CREATE INDEX ix_operations_dispatch ON trip_schema.operations (next_retry_at) WHERE status IN ('PENDING', 'RUNNING')",
    );
    await queryRunner.query(
      'CREATE INDEX ix_operations_trip_actor ON trip_schema.operations (trip_id, actor_id)',
    );

    await queryRunner.query(`
      CREATE TABLE trip_schema.saga_steps (
        operation_id UUID NOT NULL REFERENCES trip_schema.operations (id),
        step TEXT NOT NULL,
        command_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT pk_saga_steps PRIMARY KEY (operation_id, step),
        CONSTRAINT uq_saga_steps_command UNIQUE (command_id),
        CONSTRAINT ck_saga_steps_status CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE trip_schema.idempotency_keys (
        actor_id UUID NOT NULL,
        method VARCHAR(10) NOT NULL,
        path VARCHAR(255) NOT NULL,
        key UUID NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
        response_status SMALLINT NULL,
        response_body JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT pk_idempotency_keys PRIMARY KEY (actor_id, method, path, key),
        CONSTRAINT ck_idempotency_keys_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT ck_idempotency_keys_completed CHECK (status = 'IN_PROGRESS' OR response_status IS NOT NULL),
        CONSTRAINT ck_idempotency_keys_expiry CHECK (expires_at > created_at)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_idempotency_keys_expires ON trip_schema.idempotency_keys (expires_at)',
    );

    await queryRunner.query(`
      CREATE TABLE trip_schema.processed_events (
        consumer_name TEXT NOT NULL,
        event_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        aggregate_version INTEGER NOT NULL,
        correlation_id UUID NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT pk_processed_events PRIMARY KEY (consumer_name, event_id),
        CONSTRAINT ck_processed_events_version CHECK (aggregate_version >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE trip_schema.outbox_events (
        event_id UUID PRIMARY KEY,
        type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        aggregate_version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        correlation_id UUID NOT NULL,
        causation_id UUID NOT NULL,
        envelope_json JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_token UUID NULL,
        lease_until TIMESTAMPTZ NULL,
        last_error TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ NULL,
        CONSTRAINT ck_outbox_events_type CHECK (type IN ('trip.requested', 'trip.no_driver', 'trip.accepted', 'trip.started', 'trip.completed', 'trip.cancelled', 'payment.requested')),
        CONSTRAINT ck_outbox_events_status CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
        CONSTRAINT ck_outbox_events_versions CHECK (aggregate_version >= 1 AND schema_version >= 1),
        CONSTRAINT ck_outbox_events_attempts CHECK (attempts >= 0),
        CONSTRAINT ck_outbox_events_envelope CHECK (jsonb_typeof(envelope_json) = 'object'),
        CONSTRAINT ck_outbox_events_published CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
        CONSTRAINT ck_outbox_events_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL))
      )
    `);
    await queryRunner.query(
      "CREATE INDEX ix_outbox_events_dispatch ON trip_schema.outbox_events (next_retry_at) WHERE status IN ('PENDING', 'PUBLISHING')",
    );

    await queryRunner.query('REVOKE ALL ON ALL TABLES IN SCHEMA trip_schema FROM PUBLIC');
    await queryRunner.query(
      'GRANT SELECT, INSERT ON trip_schema.fare_snapshots, trip_schema.state_history, trip_schema.processed_events TO trip_app',
    );
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE ON trip_schema.trips, trip_schema.operations, trip_schema.saga_steps, trip_schema.outbox_events, trip_schema.idempotency_keys TO trip_app',
    );
    await queryRunner.query('REVOKE ALL ON trip_schema.schema_migrations FROM trip_app');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE trip_schema.saga_steps');
    await queryRunner.query('DROP TABLE trip_schema.operations');
    await queryRunner.query('DROP TABLE trip_schema.state_history');
    await queryRunner.query('DROP TABLE trip_schema.fare_snapshots');
    await queryRunner.query('DROP TABLE trip_schema.trips');
    await queryRunner.query('DROP TABLE trip_schema.outbox_events');
    await queryRunner.query('DROP TABLE trip_schema.processed_events');
    await queryRunner.query('DROP TABLE trip_schema.idempotency_keys');
  }
}
