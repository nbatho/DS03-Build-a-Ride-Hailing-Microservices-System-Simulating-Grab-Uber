import type { MigrationInterface, QueryRunner } from 'typeorm';

// Bảng của Payment trong payment_db. Căn cứ: trien-khai-db-ds03.md mục 4.8, 5; BA mục 5.6, 8.2.
export class InitialPayment1792454400000 implements MigrationInterface {
  name = 'InitialPayment1792454400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Một khoản thanh toán cho mỗi chuyến; paymentId do Trip cấp và cố định qua mọi lần thử.
    await queryRunner.query(`
      CREATE TABLE payment_schema.payments (
        id UUID PRIMARY KEY,
        trip_id UUID NOT NULL,
        passenger_id UUID NOT NULL,
        amount BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'VND',
        status TEXT NOT NULL DEFAULT 'PENDING',
        version INTEGER NOT NULL DEFAULT 1,
        attempt_no SMALLINT NOT NULL DEFAULT 0,
        retryable BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_payments_trip UNIQUE (trip_id),
        CONSTRAINT ck_payments_amount CHECK (amount >= 0 AND amount <= 99999999999999),
        CONSTRAINT ck_payments_currency CHECK (currency = 'VND'),
        CONSTRAINT ck_payments_status CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT ck_payments_version CHECK (version >= 1),
        CONSTRAINT ck_payments_attempt_no CHECK (attempt_no >= 0 AND attempt_no <= 3)
      )
    `);

    // Lịch sử từng lần thử, chỉ thêm; gửi lại cùng sự kiện không tạo lần thử mới.
    await queryRunner.query(`
      CREATE TABLE payment_schema.payment_attempts (
        payment_id UUID NOT NULL REFERENCES payment_schema.payments (id),
        attempt_no SMALLINT NOT NULL,
        result TEXT NOT NULL,
        retryable BOOLEAN NOT NULL,
        reason TEXT NULL,
        source_event_id UUID NOT NULL,
        correlation_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT pk_payment_attempts PRIMARY KEY (payment_id, attempt_no),
        CONSTRAINT ck_payment_attempts_no CHECK (attempt_no >= 1 AND attempt_no <= 3),
        CONSTRAINT ck_payment_attempts_result CHECK (result IN ('SUCCESS', 'TEMPORARY_FAILURE', 'FINAL_FAILURE'))
      )
    `);

    // Sự kiện đã xử lý (payment.requested); ghi cùng transaction nghiệp vụ, ACK sau commit.
    await queryRunner.query(`
      CREATE TABLE payment_schema.processed_events (
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

    // Hàng chờ gửi payment.succeeded/failed; aggregate_id = paymentId. OutboxRelay của @app/messaging đọc bảng này.
    await queryRunner.query(`
      CREATE TABLE payment_schema.outbox_events (
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
        CONSTRAINT ck_outbox_events_type CHECK (type IN ('payment.succeeded', 'payment.failed')),
        CONSTRAINT ck_outbox_events_status CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
        CONSTRAINT ck_outbox_events_versions CHECK (aggregate_version >= 1 AND schema_version >= 1),
        CONSTRAINT ck_outbox_events_attempts CHECK (attempts >= 0),
        CONSTRAINT ck_outbox_events_envelope CHECK (jsonb_typeof(envelope_json) = 'object'),
        CONSTRAINT ck_outbox_events_published CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
        CONSTRAINT ck_outbox_events_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL))
      )
    `);
    await queryRunner.query(
      "CREATE INDEX ix_outbox_events_dispatch ON payment_schema.outbox_events (next_retry_at) WHERE status IN ('PENDING', 'PUBLISHING')",
    );

    // Quyền của app: không DELETE (giữ lịch sử, bằng chứng), lần thử chỉ thêm, không DDL, không TRUNCATE.
    await queryRunner.query('REVOKE ALL ON ALL TABLES IN SCHEMA payment_schema FROM PUBLIC');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON payment_schema.payments TO payment_app');
    await queryRunner.query('GRANT SELECT, INSERT ON payment_schema.payment_attempts TO payment_app');
    await queryRunner.query('GRANT SELECT, INSERT ON payment_schema.processed_events TO payment_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON payment_schema.outbox_events TO payment_app');
    await queryRunner.query('REVOKE ALL ON payment_schema.schema_migrations FROM payment_app');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE payment_schema.outbox_events');
    await queryRunner.query('DROP TABLE payment_schema.processed_events');
    await queryRunner.query('DROP TABLE payment_schema.payment_attempts');
    await queryRunner.query('DROP TABLE payment_schema.payments');
  }
}
