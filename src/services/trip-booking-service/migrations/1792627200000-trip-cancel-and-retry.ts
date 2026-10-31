import type { MigrationInterface, QueryRunner } from 'typeorm';

export class TripCancelAndRetry1792627200000 implements MigrationInterface {
  name = 'TripCancelAndRetry1792627200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_schema.operations
        ADD COLUMN reason TEXT NULL,
        ADD CONSTRAINT ck_operations_reason CHECK (reason IS NULL OR reason IN ('CHANGE_PLAN', 'WAIT_TOO_LONG'))
    `);

    await queryRunner.query(`
      CREATE TABLE trip_schema.command_results (
        caller_service TEXT NOT NULL,
        command_type TEXT NOT NULL,
        command_id UUID NOT NULL,
        resource_id UUID NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        response_status SMALLINT NULL,
        response_body JSONB NULL,
        correlation_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT pk_command_results PRIMARY KEY (caller_service, command_type, command_id),
        CONSTRAINT ck_command_results_type CHECK (command_type IN ('RETRY')),
        CONSTRAINT ck_command_results_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT ck_command_results_completed CHECK (status = 'IN_PROGRESS' OR response_status IS NOT NULL)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE trip_schema.operation_retries (
        id UUID PRIMARY KEY,
        operation_id UUID NOT NULL REFERENCES trip_schema.operations (id),
        command_id UUID NOT NULL,
        caller TEXT NOT NULL,
        reason TEXT NOT NULL,
        from_step TEXT NOT NULL,
        previous_error_code TEXT NULL,
        correlation_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      'CREATE INDEX ix_operation_retries_operation ON trip_schema.operation_retries (operation_id, created_at)',
    );

    await queryRunner.query(
      'REVOKE ALL ON trip_schema.command_results, trip_schema.operation_retries FROM PUBLIC',
    );

    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE ON trip_schema.command_results TO trip_app',
    );

    await queryRunner.query('GRANT SELECT, INSERT ON trip_schema.operation_retries TO trip_app');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE trip_schema.operation_retries');
    await queryRunner.query('DROP TABLE trip_schema.command_results');
    await queryRunner.query(`
      ALTER TABLE trip_schema.operations
        DROP CONSTRAINT ck_operations_reason,
        DROP COLUMN reason
    `);
  }
}
