import type { MigrationInterface, QueryRunner } from 'typeorm';

// Bảng của Matching trong matching_db. Căn cứ: trien-khai-db-ds03.md mục 4.6, 5.
export class InitialMatching1792368000000 implements MigrationInterface {
  name = 'InitialMatching1792368000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Việc tìm tài xế; mỗi chuyến một việc tìm.
    // Tombstone CANCELLED có thể tạo trước trip.requested, khi đó trip_snapshot/search_deadline NULL.
    // search_deadline tính một lần (60 giây), không gia hạn.
    await queryRunner.query(`
      CREATE TABLE matching_schema.matching_jobs (
        id UUID PRIMARY KEY,
        trip_id UUID NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        latest_trip_version INTEGER NOT NULL,
        trip_snapshot JSONB NULL,
        search_deadline TIMESTAMPTZ NULL,
        current_offer_id UUID NULL,
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_token UUID NULL,
        lease_until TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_matching_jobs_trip UNIQUE (trip_id),
        CONSTRAINT uq_matching_jobs_id_trip UNIQUE (id, trip_id),
        CONSTRAINT ck_matching_jobs_status CHECK (status IN ('SEARCHING', 'OFFERING', 'CLAIMED', 'MATCHED', 'FAILED', 'CANCELLED')),
        CONSTRAINT ck_matching_jobs_version CHECK (version >= 1),
        CONSTRAINT ck_matching_jobs_trip_version CHECK (latest_trip_version >= 1),
        CONSTRAINT ck_matching_jobs_snapshot CHECK (
          status = 'CANCELLED' OR (trip_snapshot IS NOT NULL AND search_deadline IS NOT NULL)
        ),
        CONSTRAINT ck_matching_jobs_snapshot_object CHECK (trip_snapshot IS NULL OR jsonb_typeof(trip_snapshot) = 'object'),
        CONSTRAINT ck_matching_jobs_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX ix_matching_jobs_worker ON matching_schema.matching_jobs (next_retry_at)
        WHERE status IN ('SEARCHING', 'OFFERING', 'CLAIMED')
    `);

    // Tài xế đã mời; không mời lại cùng tài xế trong một việc tìm; tối đa 5 (kiểm tra khi đã khóa job).
    await queryRunner.query(`
      CREATE TABLE matching_schema.attempted_candidates (
        job_id UUID NOT NULL REFERENCES matching_schema.matching_jobs (id),
        driver_id UUID NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT pk_attempted_candidates PRIMARY KEY (job_id, driver_id)
      )
    `);

    // Lời mời; mở 15 giây. CLAIMED không tự hết hạn theo TTL của OPEN, phải đối soát với Trip.
    // assignment_id là mã quyết định ổn định cho ACCEPT/REJECT.
    await queryRunner.query(`
      CREATE TABLE matching_schema.offers (
        id UUID PRIMARY KEY,
        job_id UUID NOT NULL,
        trip_id UUID NOT NULL,
        driver_id UUID NOT NULL,
        status TEXT NOT NULL,
        assignment_id UUID NULL,
        decision_action TEXT NULL,
        resolution_result TEXT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT fk_offers_job_trip FOREIGN KEY (job_id, trip_id)
          REFERENCES matching_schema.matching_jobs (id, trip_id),
        CONSTRAINT fk_offers_attempted FOREIGN KEY (job_id, driver_id)
          REFERENCES matching_schema.attempted_candidates (job_id, driver_id),
        CONSTRAINT uq_offers_assignment UNIQUE (assignment_id),
        CONSTRAINT uq_offers_job_driver UNIQUE (job_id, driver_id),
        CONSTRAINT uq_offers_job_id UNIQUE (job_id, id),
        CONSTRAINT ck_offers_status CHECK (status IN ('OPEN', 'CLAIMED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
        CONSTRAINT ck_offers_decision_action CHECK (decision_action IN ('ACCEPT', 'REJECT')),
        CONSTRAINT ck_offers_resolution_result CHECK (resolution_result IN ('ASSIGNED', 'RETRY', 'CANCELLED')),
        CONSTRAINT ck_offers_decision_pair CHECK ((assignment_id IS NULL) = (decision_action IS NULL)),
        CONSTRAINT ck_offers_claimed_has_assignment CHECK (status NOT IN ('CLAIMED', 'ACCEPTED') OR assignment_id IS NOT NULL),
        CONSTRAINT ck_offers_version CHECK (version >= 1)
      )
    `);

    // Mỗi việc tìm tối đa một lời mời đang mở hoặc đang được giành.
    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_offers_active_job ON matching_schema.offers (job_id) WHERE status IN ('OPEN', 'CLAIMED')",
    );
    await queryRunner.query(
      "CREATE INDEX ix_offers_open_expires ON matching_schema.offers (expires_at) WHERE status = 'OPEN'",
    );
    await queryRunner.query(
      "CREATE INDEX ix_offers_claimed ON matching_schema.offers (updated_at) WHERE status = 'CLAIMED'",
    );
    await queryRunner.query('CREATE INDEX ix_offers_driver ON matching_schema.offers (driver_id, created_at DESC)');
    await queryRunner.query('CREATE INDEX ix_offers_trip ON matching_schema.offers (trip_id)');

    // Offer hiện tại của job phải thuộc đúng job đó.
    await queryRunner.query(`
      ALTER TABLE matching_schema.matching_jobs
        ADD CONSTRAINT fk_matching_jobs_current_offer FOREIGN KEY (id, current_offer_id)
        REFERENCES matching_schema.offers (job_id, id)
    `);

    // Sự kiện đã xử lý (trip.requested, trip.cancelled...); ghi cùng transaction nghiệp vụ, ACK sau commit.
    await queryRunner.query(`
      CREATE TABLE matching_schema.processed_events (
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

    // Hàng chờ gửi; aggregate_id = jobId. Worker claim bằng FOR UPDATE SKIP LOCKED và lease_token.
    await queryRunner.query(`
      CREATE TABLE matching_schema.outbox_events (
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
        CONSTRAINT ck_outbox_events_type CHECK (type IN ('matching.offer.created', 'matching.failed')),
        CONSTRAINT ck_outbox_events_status CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
        CONSTRAINT ck_outbox_events_versions CHECK (aggregate_version >= 1 AND schema_version >= 1),
        CONSTRAINT ck_outbox_events_attempts CHECK (attempts >= 0),
        CONSTRAINT ck_outbox_events_envelope CHECK (jsonb_typeof(envelope_json) = 'object'),
        CONSTRAINT ck_outbox_events_published CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
        CONSTRAINT ck_outbox_events_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL))
      )
    `);

    // "Không tìm được tài xế" gửi đúng một lần cho mỗi việc tìm.
    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_outbox_events_failed_once ON matching_schema.outbox_events (aggregate_id) WHERE type = 'matching.failed'",
    );
    await queryRunner.query(
      "CREATE INDEX ix_outbox_events_dispatch ON matching_schema.outbox_events (next_retry_at) WHERE status IN ('PENDING', 'PUBLISHING')",
    );

    // Kết quả lệnh nội bộ: DECISION dùng assignmentId; CANCEL/RESOLUTION dùng commandId.
    await queryRunner.query(`
      CREATE TABLE matching_schema.command_results (
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
        CONSTRAINT ck_command_results_type CHECK (command_type IN ('DECISION', 'CANCEL', 'RESOLUTION')),
        CONSTRAINT ck_command_results_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT ck_command_results_completed CHECK (status = 'IN_PROGRESS' OR response_status IS NOT NULL)
      )
    `);

    // Quyền của app: không DELETE (giữ tombstone/bằng chứng), không DDL, không TRUNCATE.
    await queryRunner.query('REVOKE ALL ON ALL TABLES IN SCHEMA matching_schema FROM PUBLIC');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON matching_schema.matching_jobs TO matching_app');
    await queryRunner.query('GRANT SELECT, INSERT ON matching_schema.attempted_candidates TO matching_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON matching_schema.offers TO matching_app');
    await queryRunner.query('GRANT SELECT, INSERT ON matching_schema.processed_events TO matching_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON matching_schema.outbox_events TO matching_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON matching_schema.command_results TO matching_app');
    await queryRunner.query('REVOKE ALL ON matching_schema.schema_migrations FROM matching_app');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE matching_schema.command_results');
    await queryRunner.query('DROP TABLE matching_schema.outbox_events');
    await queryRunner.query('DROP TABLE matching_schema.processed_events');
    await queryRunner.query('ALTER TABLE matching_schema.matching_jobs DROP CONSTRAINT fk_matching_jobs_current_offer');
    await queryRunner.query('DROP TABLE matching_schema.offers');
    await queryRunner.query('DROP TABLE matching_schema.attempted_candidates');
    await queryRunner.query('DROP TABLE matching_schema.matching_jobs');
  }
}
