-- =============================================================================
-- pricing_schema — Pricing service (B, cổng 3007)
-- Chạy trên Supabase: SQL Editor, chạy cả file một lần bằng role `postgres`.
-- Căn cứ: trien-khai-db-ds03.md mục 2, 3, 4.7, 5, 8.4; BA mục 3.2.
--
-- Trước khi chạy: thay hai mật khẩu REPLACE_ME_* bên dưới. Không commit mật khẩu thật.
-- Chạy lại từ đầu: DROP SCHEMA pricing_schema CASCADE; rồi chạy lại file
-- (role đã có thì chỉ đổi mật khẩu).
-- =============================================================================

BEGIN;

-- 1. Role: pricing_app cho ứng dụng, pricing_migrator sở hữu schema và chạy migration.
DO $$
DECLARE
  app_password      text := 'REPLACE_ME_PRICING_APP';
  migrator_password text := 'REPLACE_ME_PRICING_MIGRATOR';
BEGIN
  IF app_password LIKE 'REPLACE_ME%' OR migrator_password LIKE 'REPLACE_ME%' THEN
    RAISE EXCEPTION 'Thay mật khẩu REPLACE_ME_* trước khi chạy';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pricing_app') THEN
    EXECUTE format('ALTER ROLE pricing_app PASSWORD %L', app_password);
  ELSE
    EXECUTE format('CREATE ROLE pricing_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', app_password);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pricing_migrator') THEN
    EXECUTE format('ALTER ROLE pricing_migrator PASSWORD %L', migrator_password);
  ELSE
    EXECUTE format('CREATE ROLE pricing_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', migrator_password);
  END IF;
END $$;

-- postgres cần SET ROLE sang migrator để tạo schema/bảng thuộc sở hữu migrator.
GRANT pricing_migrator TO postgres;

-- 2. Schema: migrator sở hữu; app chỉ USAGE; role Supabase (anon/authenticated/service_role) không có quyền.
CREATE SCHEMA pricing_schema AUTHORIZATION pricing_migrator;
REVOKE ALL ON SCHEMA pricing_schema FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA pricing_schema TO pricing_app;

ALTER ROLE pricing_app      IN DATABASE postgres SET search_path TO pricing_schema, pg_catalog;
ALTER ROLE pricing_migrator IN DATABASE postgres SET search_path TO pricing_schema, pg_catalog;

-- 3. Bảng: tạo bằng migrator để migrator là owner, app không phải owner.
SET LOCAL ROLE pricing_migrator;

-- Bảng giá có phiên bản; đã phát hành thì không sửa, đổi giá thì thêm version mới.
-- App chỉ được SELECT; seed/thêm version bằng migrator.
CREATE TABLE pricing_schema.fare_rules (
  rule_version VARCHAR(40) PRIMARY KEY,
  vehicle_type TEXT NOT NULL,
  base_fee     BIGINT NOT NULL,
  per_km       BIGINT NOT NULL,
  per_min      BIGINT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'VND',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_fare_rules_version CHECK (char_length(btrim(rule_version)) BETWEEN 1 AND 40),
  CONSTRAINT ck_fare_rules_vehicle_type CHECK (vehicle_type = 'CAR'),
  CONSTRAINT ck_fare_rules_amounts CHECK (base_fee >= 0 AND per_km >= 0 AND per_min >= 0),
  CONSTRAINT ck_fare_rules_currency CHECK (currency = 'VND')
);

-- Chọn bảng giá mới nhất theo loại xe.
CREATE INDEX ix_fare_rules_vehicle_latest ON pricing_schema.fare_rules (vehicle_type, created_at DESC);

-- Báo giá: bản chụp bất biến đầu vào + kết quả; hạn 300 giây tính bằng giờ DB.
-- passenger_id lấy từ JWT, không FK sang Identity. Không DELETE khi hết hạn.
CREATE TABLE pricing_schema.quotes (
  id               UUID PRIMARY KEY,
  passenger_id     UUID NOT NULL,
  pickup_lat       NUMERIC(9, 6) NOT NULL,
  pickup_lng       NUMERIC(9, 6) NOT NULL,
  pickup_zone_id   TEXT NOT NULL,
  dropoff_lat      NUMERIC(9, 6) NOT NULL,
  dropoff_lng      NUMERIC(9, 6) NOT NULL,
  dropoff_zone_id  TEXT NOT NULL,
  distance_meters  INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  amount           BIGINT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'VND',
  rule_version     VARCHAR(40) NOT NULL REFERENCES pricing_schema.fare_rules (rule_version),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  CONSTRAINT ck_quotes_pickup CHECK (pickup_lat BETWEEN -90 AND 90 AND pickup_lng BETWEEN -180 AND 180),
  CONSTRAINT ck_quotes_dropoff CHECK (dropoff_lat BETWEEN -90 AND 90 AND dropoff_lng BETWEEN -180 AND 180),
  CONSTRAINT ck_quotes_zones CHECK (pickup_zone_id IN ('ZONE_A', 'ZONE_B') AND dropoff_zone_id IN ('ZONE_A', 'ZONE_B')),
  CONSTRAINT ck_quotes_distance CHECK (distance_meters BETWEEN 1 AND 100000),
  CONSTRAINT ck_quotes_duration CHECK (duration_seconds BETWEEN 1 AND 14400),
  CONSTRAINT ck_quotes_amount CHECK (amount BETWEEN 0 AND 99999999999999),
  CONSTRAINT ck_quotes_currency CHECK (currency = 'VND'),
  CONSTRAINT ck_quotes_expiry CHECK (expires_at > created_at)
);

CREATE INDEX ix_quotes_passenger ON pricing_schema.quotes (passenger_id, created_at DESC);
CREATE INDEX ix_quotes_expires ON pricing_schema.quotes (expires_at);

-- Chống gửi trùng request: phạm vi (người gọi, method, path, key); replay giữ nguyên quoteId/hạn cũ; giữ >= 24 giờ.
CREATE TABLE pricing_schema.idempotency_keys (
  actor_id        UUID NOT NULL,
  method          VARCHAR(10) NOT NULL,
  path            VARCHAR(255) NOT NULL,
  key             UUID NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  response_status SMALLINT NULL,
  response_body   JSONB NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_idempotency_keys PRIMARY KEY (actor_id, method, path, key),
  CONSTRAINT ck_idempotency_keys_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  CONSTRAINT ck_idempotency_keys_completed CHECK (status = 'IN_PROGRESS' OR response_status IS NOT NULL),
  CONSTRAINT ck_idempotency_keys_expiry CHECK (expires_at > created_at)
);

CREATE INDEX ix_idempotency_keys_expires ON pricing_schema.idempotency_keys (expires_at);

-- 4. Seed bảng giá ô tô bản 1. Chạy lại không đổi; cùng version khác giá thì báo lỗi.
INSERT INTO pricing_schema.fare_rules (rule_version, vehicle_type, base_fee, per_km, per_min, currency)
VALUES ('CAR_V1', 'CAR', 12000, 8000, 500, 'VND')
ON CONFLICT (rule_version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pricing_schema.fare_rules
    WHERE rule_version = 'CAR_V1' AND vehicle_type = 'CAR'
      AND base_fee = 12000 AND per_km = 8000 AND per_min = 500 AND currency = 'VND'
  ) THEN
    RAISE EXCEPTION 'CAR_V1 đã tồn tại với giá khác; tạo version mới thay vì sửa CAR_V1';
  END IF;
END $$;

-- 5. Quyền của app: bảng giá chỉ đọc; báo giá chỉ thêm và đọc (bất biến).
REVOKE ALL ON ALL TABLES IN SCHEMA pricing_schema FROM PUBLIC;
GRANT SELECT                 ON pricing_schema.fare_rules       TO pricing_app;
GRANT SELECT, INSERT         ON pricing_schema.quotes           TO pricing_app;
GRANT SELECT, INSERT, UPDATE ON pricing_schema.idempotency_keys TO pricing_app;

-- 6. Supabase tự bật RLS cho bảng mới; không có policy thì app đọc ra rỗng và không ghi được.
-- Cô lập bằng schema + GRANT, schema không mở qua Data API, nên tắt RLS (giống Postgres local khi test).
ALTER TABLE pricing_schema.fare_rules       DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_schema.quotes           DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_schema.idempotency_keys DISABLE ROW LEVEL SECURITY;

RESET ROLE;

COMMIT;
