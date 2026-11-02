import type { MigrationInterface, QueryRunner } from 'typeorm';

// Bảng của Driver trong driver_db. Căn cứ: trien-khai-db-ds03.md mục 4.2, 4.3, 5.
export class InitialDriver1792368000000 implements MigrationInterface {
  name = 'InitialDriver1792368000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Hồ sơ tài xế; id = users.id của tài khoản DRIVER (không FK sang Identity).
    // version tăng khi đổi bật/tắt hoặc giữ xe; gửi GPS không tăng version.
    await queryRunner.query(`
      CREATE TABLE driver_schema.drivers (
        id UUID PRIMARY KEY,
        license_number VARCHAR(40) NOT NULL,
        online BOOLEAN NOT NULL DEFAULT false,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_drivers_license_number CHECK (char_length(btrim(license_number)) BETWEEN 3 AND 40),
        CONSTRAINT ck_drivers_version CHECK (version >= 1)
      )
    `);
    await queryRunner.query('CREATE INDEX ix_drivers_online ON driver_schema.drivers (id) WHERE online');

    // Mỗi tài xế một xe; biển số đã chuẩn hóa (uppercase, bỏ khoảng trắng hai đầu) không trùng.
    await queryRunner.query(`
      CREATE TABLE driver_schema.vehicles (
        id UUID PRIMARY KEY,
        driver_id UUID NOT NULL REFERENCES driver_schema.drivers (id),
        plate_number VARCHAR(20) NOT NULL,
        model VARCHAR(80) NOT NULL,
        color VARCHAR(30) NOT NULL,
        vehicle_type TEXT NOT NULL DEFAULT 'CAR',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_vehicles_driver UNIQUE (driver_id),
        CONSTRAINT uq_vehicles_plate UNIQUE (plate_number),
        CONSTRAINT ck_vehicles_plate CHECK (plate_number = upper(btrim(plate_number)) AND char_length(plate_number) BETWEEN 3 AND 20),
        CONSTRAINT ck_vehicles_model CHECK (char_length(btrim(model)) BETWEEN 1 AND 80),
        CONSTRAINT ck_vehicles_color CHECK (char_length(btrim(color)) BETWEEN 1 AND 30),
        CONSTRAINT ck_vehicles_type CHECK (vehicle_type = 'CAR')
      )
    `);

    // Vị trí mới nhất; chỉ ghi đè khi sequence mới hơn. Chưa có GPS thì không có dòng.
    // Độ mới tính theo received_at (giờ server), không theo recorded_at của client.
    await queryRunner.query(`
      CREATE TABLE driver_schema.latest_locations (
        driver_id UUID PRIMARY KEY REFERENCES driver_schema.drivers (id),
        lat NUMERIC(9, 6) NOT NULL,
        lng NUMERIC(9, 6) NOT NULL,
        zone_id TEXT NOT NULL,
        sequence BIGINT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_latest_locations_lat CHECK (lat BETWEEN -90 AND 90),
        CONSTRAINT ck_latest_locations_lng CHECK (lng BETWEEN -180 AND 180),
        CONSTRAINT ck_latest_locations_zone CHECK (zone_id IN ('ZONE_A', 'ZONE_B')),
        CONSTRAINT ck_latest_locations_sequence CHECK (sequence >= 1)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_latest_locations_candidates ON driver_schema.latest_locations (zone_id, received_at DESC, driver_id)',
    );

    // Lượt giữ xe; id = assignmentId do Trip sinh. Không xóa dòng (tombstone).
    // HELD -> CONFIRMED | RELEASED | EXPIRED; CONFIRMED -> RELEASED; RELEASED/EXPIRED là cuối.
    // offer_id NULL chỉ ở tombstone RELEASED tạo khi lệnh trả xe đến trước lệnh giữ xe.
    await queryRunner.query(`
      CREATE TABLE driver_schema.reservations (
        id UUID PRIMARY KEY,
        trip_id UUID NOT NULL,
        driver_id UUID NOT NULL REFERENCES driver_schema.drivers (id),
        offer_id UUID NULL,
        status TEXT NOT NULL,
        expires_at TIMESTAMPTZ NULL,
        version INTEGER NOT NULL DEFAULT 1,
        release_reason TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_reservations_status CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
        CONSTRAINT ck_reservations_release_reason CHECK (release_reason IN ('ASSIGNMENT_FAILED', 'TRIP_CANCELLED', 'TRIP_COMPLETED')),
        CONSTRAINT ck_reservations_released_has_reason CHECK ((status = 'RELEASED') = (release_reason IS NOT NULL)),
        CONSTRAINT ck_reservations_held_has_expiry CHECK (status <> 'HELD' OR expires_at IS NOT NULL),
        CONSTRAINT ck_reservations_offer CHECK (offer_id IS NOT NULL OR status = 'RELEASED'),
        CONSTRAINT ck_reservations_version CHECK (version >= 1)
      )
    `);

    // Chống giữ một tài xế cho hai chuyến: mỗi tài xế, mỗi chuyến tối đa một lượt còn hiệu lực.
    // Không đưa now() vào điều kiện index; worker chuyển HELD quá hạn sang EXPIRED.
    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_reservations_active_driver ON driver_schema.reservations (driver_id) WHERE status IN ('HELD', 'CONFIRMED')",
    );
    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_reservations_active_trip ON driver_schema.reservations (trip_id) WHERE status IN ('HELD', 'CONFIRMED')",
    );
    await queryRunner.query(
      "CREATE INDEX ix_reservations_held_expires ON driver_schema.reservations (expires_at) WHERE status = 'HELD'",
    );
    await queryRunner.query('CREATE INDEX ix_reservations_trip ON driver_schema.reservations (trip_id)');

    // Chống gửi trùng request: phạm vi (người gọi, method, path, key); giữ >= 24 giờ.
    await queryRunner.query(`
      CREATE TABLE driver_schema.idempotency_keys (
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
    await queryRunner.query('CREATE INDEX ix_idempotency_keys_expires ON driver_schema.idempotency_keys (expires_at)');

    // Kết quả lệnh nội bộ (Trip/Matching gọi): RESERVE dùng reservationId làm command_id.
    await queryRunner.query(`
      CREATE TABLE driver_schema.command_results (
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
        CONSTRAINT ck_command_results_type CHECK (command_type IN ('RESERVE', 'CONFIRM', 'RELEASE')),
        CONSTRAINT ck_command_results_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT ck_command_results_completed CHECK (status = 'IN_PROGRESS' OR response_status IS NOT NULL)
      )
    `);

    // Quyền của app: không DELETE (giữ tombstone/bằng chứng), không DDL, không TRUNCATE.
    await queryRunner.query('REVOKE ALL ON ALL TABLES IN SCHEMA driver_schema FROM PUBLIC');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON driver_schema.drivers TO driver_app');
    await queryRunner.query('GRANT SELECT, INSERT ON driver_schema.vehicles TO driver_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON driver_schema.latest_locations TO driver_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON driver_schema.reservations TO driver_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON driver_schema.idempotency_keys TO driver_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON driver_schema.command_results TO driver_app');
    await queryRunner.query('REVOKE ALL ON driver_schema.schema_migrations FROM driver_app');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE driver_schema.command_results');
    await queryRunner.query('DROP TABLE driver_schema.idempotency_keys');
    await queryRunner.query('DROP TABLE driver_schema.reservations');
    await queryRunner.query('DROP TABLE driver_schema.latest_locations');
    await queryRunner.query('DROP TABLE driver_schema.vehicles');
    await queryRunner.query('DROP TABLE driver_schema.drivers');
  }
}
