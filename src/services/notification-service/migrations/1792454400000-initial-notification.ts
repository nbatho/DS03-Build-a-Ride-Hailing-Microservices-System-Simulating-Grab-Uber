import type { MigrationInterface, QueryRunner } from 'typeorm';

// Bảng của Notification trong notification_db. Căn cứ: trien-khai-db-ds03.md mục 4.9, 5; BA mục 8.3.
// Notification chỉ nhận sự kiện, không phát nên không có outbox.
export class InitialNotification1792454400000 implements MigrationInterface {
  name = 'InitialNotification1792454400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Thông báo cho khách/tài xế. Field riêng từng loại (offer, pickup, tripStatus...) nằm trong payload;
    // actionable tính lúc đọc từ projection và hạn lời mời, không lưu cứng.
    await queryRunner.query(`
      CREATE TABLE notification_schema.notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_id UUID NOT NULL,
        source_event_id UUID NOT NULL,
        trip_id UUID NOT NULL,
        type TEXT NOT NULL,
        title VARCHAR(200) NOT NULL,
        payload JSONB NOT NULL,
        read_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_notifications_type CHECK (type IN ('OFFER', 'TRIP_STATUS', 'PAYMENT_STATUS')),
        CONSTRAINT ck_notifications_payload CHECK (jsonb_typeof(payload) = 'object')
      )
    `);
    // Không thông báo trùng: cùng người nhận + cùng sự kiện nguồn + cùng loại.
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_notifications_dedup ON notification_schema.notifications (recipient_id, source_event_id, type)',
    );
    // Polling theo con trỏ: mới nhất trước.
    await queryRunner.query(
      'CREATE INDEX ix_notifications_poll ON notification_schema.notifications (recipient_id, created_at DESC, id DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX ix_notifications_unread ON notification_schema.notifications (recipient_id, created_at DESC) WHERE read_at IS NULL',
    );

    // Bản sao trạng thái chuyến để xử lý sự kiện đến sai thứ tự; trip_version và payment_version là hai dãy riêng.
    await queryRunner.query(`
      CREATE TABLE notification_schema.trip_projection (
        trip_id UUID PRIMARY KEY,
        trip_version INTEGER NOT NULL DEFAULT 0,
        trip_status TEXT NULL,
        terminal_state TEXT NULL,
        terminal_event_id UUID NULL,
        known_driver_ids UUID[] NOT NULL DEFAULT '{}',
        passenger_id UUID NULL,
        payment_id UUID NULL,
        payment_version INTEGER NOT NULL DEFAULT 0,
        payment_status TEXT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_trip_projection_trip_status CHECK (trip_status IS NULL OR trip_status IN (
          'MATCHING', 'ASSIGNING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLING', 'CANCELLED', 'NO_DRIVER'
        )),
        CONSTRAINT ck_trip_projection_terminal CHECK (terminal_state IS NULL OR terminal_state IN (
          'COMPLETED', 'CANCELLED', 'NO_DRIVER'
        )),
        CONSTRAINT ck_trip_projection_payment_status CHECK (payment_status IS NULL OR payment_status IN (
          'NOT_REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED'
        ))
      )
    `);

    // Sự kiện đã xử lý (8 loại); ghi cùng transaction nghiệp vụ, ACK sau commit.
    await queryRunner.query(`
      CREATE TABLE notification_schema.processed_events (
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

    // Quyền của app: không DELETE, không DDL, không TRUNCATE.
    await queryRunner.query('REVOKE ALL ON ALL TABLES IN SCHEMA notification_schema FROM PUBLIC');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON notification_schema.notifications TO notification_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON notification_schema.trip_projection TO notification_app');
    await queryRunner.query('GRANT SELECT, INSERT ON notification_schema.processed_events TO notification_app');
    await queryRunner.query('REVOKE ALL ON notification_schema.schema_migrations FROM notification_app');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE notification_schema.processed_events');
    await queryRunner.query('DROP TABLE notification_schema.trip_projection');
    await queryRunner.query('DROP TABLE notification_schema.notifications');
  }
}
