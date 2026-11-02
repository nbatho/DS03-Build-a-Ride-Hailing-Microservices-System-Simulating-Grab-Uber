import type { MigrationInterface, QueryRunner } from 'typeorm';

// Bảng của Pricing trong pricing_db và bảng giá CAR_V1. Căn cứ: trien-khai-db-ds03.md mục 4.7, 5.
export class InitialPricing1792368000000 implements MigrationInterface {
  name = 'InitialPricing1792368000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Bảng giá có phiên bản; đã phát hành thì không sửa, đổi giá thì thêm version mới.
    // App chỉ được SELECT; thêm version mới bằng migration.
    await queryRunner.query(`
      CREATE TABLE pricing_schema.fare_rules (
        rule_version VARCHAR(40) PRIMARY KEY,
        vehicle_type TEXT NOT NULL,
        base_fee BIGINT NOT NULL,
        per_km BIGINT NOT NULL,
        per_min BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'VND',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_fare_rules_version CHECK (char_length(btrim(rule_version)) BETWEEN 1 AND 40),
        CONSTRAINT ck_fare_rules_vehicle_type CHECK (vehicle_type = 'CAR'),
        CONSTRAINT ck_fare_rules_amounts CHECK (base_fee >= 0 AND per_km >= 0 AND per_min >= 0),
        CONSTRAINT ck_fare_rules_currency CHECK (currency = 'VND')
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_fare_rules_vehicle_latest ON pricing_schema.fare_rules (vehicle_type, created_at DESC)',
    );

    // Báo giá: bản chụp bất biến đầu vào + kết quả; hạn 300 giây tính bằng giờ DB.
    // passenger_id lấy từ JWT, không FK sang Identity. Không DELETE khi hết hạn.
    await queryRunner.query(`
      CREATE TABLE pricing_schema.quotes (
        id UUID PRIMARY KEY,
        passenger_id UUID NOT NULL,
        pickup_lat NUMERIC(9, 6) NOT NULL,
        pickup_lng NUMERIC(9, 6) NOT NULL,
        pickup_zone_id TEXT NOT NULL,
        dropoff_lat NUMERIC(9, 6) NOT NULL,
        dropoff_lng NUMERIC(9, 6) NOT NULL,
        dropoff_zone_id TEXT NOT NULL,
        distance_meters INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        amount BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'VND',
        rule_version VARCHAR(40) NOT NULL REFERENCES pricing_schema.fare_rules (rule_version),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ck_quotes_pickup CHECK (pickup_lat BETWEEN -90 AND 90 AND pickup_lng BETWEEN -180 AND 180),
        CONSTRAINT ck_quotes_dropoff CHECK (dropoff_lat BETWEEN -90 AND 90 AND dropoff_lng BETWEEN -180 AND 180),
        CONSTRAINT ck_quotes_zones CHECK (pickup_zone_id IN ('ZONE_A', 'ZONE_B') AND dropoff_zone_id IN ('ZONE_A', 'ZONE_B')),
        CONSTRAINT ck_quotes_distance CHECK (distance_meters BETWEEN 1 AND 100000),
        CONSTRAINT ck_quotes_duration CHECK (duration_seconds BETWEEN 1 AND 14400),
        CONSTRAINT ck_quotes_amount CHECK (amount BETWEEN 0 AND 99999999999999),
        CONSTRAINT ck_quotes_currency CHECK (currency = 'VND'),
        CONSTRAINT ck_quotes_expiry CHECK (expires_at > created_at)
      )
    `);
    await queryRunner.query('CREATE INDEX ix_quotes_passenger ON pricing_schema.quotes (passenger_id, created_at DESC)');
    await queryRunner.query('CREATE INDEX ix_quotes_expires ON pricing_schema.quotes (expires_at)');

    // Chống gửi trùng request: phạm vi (người gọi, method, path, key); replay giữ nguyên quoteId/hạn cũ.
    await queryRunner.query(`
      CREATE TABLE pricing_schema.idempotency_keys (
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
    await queryRunner.query('CREATE INDEX ix_idempotency_keys_expires ON pricing_schema.idempotency_keys (expires_at)');

    // Bảng giá ô tô bản 1: 12.000đ + 8.000đ/km + 500đ/phút.
    await queryRunner.query(`
      INSERT INTO pricing_schema.fare_rules (rule_version, vehicle_type, base_fee, per_km, per_min, currency)
      VALUES ('CAR_V1', 'CAR', 12000, 8000, 500, 'VND')
    `);

    // Quyền của app: bảng giá chỉ đọc; báo giá chỉ thêm và đọc (bất biến).
    await queryRunner.query('REVOKE ALL ON ALL TABLES IN SCHEMA pricing_schema FROM PUBLIC');
    await queryRunner.query('GRANT SELECT ON pricing_schema.fare_rules TO pricing_app');
    await queryRunner.query('GRANT SELECT, INSERT ON pricing_schema.quotes TO pricing_app');
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON pricing_schema.idempotency_keys TO pricing_app');
    await queryRunner.query('REVOKE ALL ON pricing_schema.schema_migrations FROM pricing_app');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE pricing_schema.idempotency_keys');
    await queryRunner.query('DROP TABLE pricing_schema.quotes');
    await queryRunner.query('DROP TABLE pricing_schema.fare_rules');
  }
}
