import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialUsers1791849600000 implements MigrationInterface {
  name = 'InitialUsers1791849600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE identity_schema.users (
        id UUID PRIMARY KEY,
        email VARCHAR(254) NOT NULL,
        password_hash TEXT NOT NULL,
        display_name VARCHAR(80) NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_users_email UNIQUE(email),
        CONSTRAINT ck_users_email_normalized CHECK(email = lower(btrim(email)) AND length(email) > 0),
        CONSTRAINT ck_users_display_name CHECK(char_length(btrim(display_name)) BETWEEN 1 AND 80),
        CONSTRAINT ck_users_role CHECK(role IN ('PASSENGER', 'DRIVER'))
      )
    `);

    await queryRunner.query('REVOKE ALL ON identity_schema.users FROM PUBLIC');
    await queryRunner.query('GRANT SELECT, INSERT ON identity_schema.users TO identity_app');
    await queryRunner.query('REVOKE ALL ON identity_schema.schema_migrations FROM identity_app');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE identity_schema.users');
  }
}
