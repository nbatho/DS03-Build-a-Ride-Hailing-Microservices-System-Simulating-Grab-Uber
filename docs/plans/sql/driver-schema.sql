-- =============================================================================
-- driver_schema — Driver/Vehicle/Location service (B, cổng 3002)
-- Chạy trên Supabase: SQL Editor, chạy cả file một lần bằng role `postgres`.
-- Căn cứ: trien-khai-db-ds03.md mục 2, 3, 4.2, 4.3, 5; BA mục 3.2.
--
-- Trước khi chạy: thay hai mật khẩu REPLACE_ME_* bên dưới. Không commit mật khẩu thật.
-- Chạy lại từ đầu: DROP SCHEMA driver_schema CASCADE; rồi chạy lại file
-- (role đã có thì chỉ đổi mật khẩu).
-- =============================================================================

BEGIN;

-- 1. Role: driver_app cho ứng dụng, driver_migrator sở hữu schema và chạy migration.
DO $$
DECLARE
  app_password      text := 'REPLACE_ME_DRIVER_APP';
  migrator_password text := 'REPLACE_ME_DRIVER_MIGRATOR';
BEGIN
  IF app_password LIKE 'REPLACE_ME%' OR migrator_password LIKE 'REPLACE_ME%' THEN
    RAISE EXCEPTION 'Thay mật khẩu REPLACE_ME_* trước khi chạy';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'driver_app') THEN
    EXECUTE format('ALTER ROLE driver_app PASSWORD %L', app_password);
  ELSE
    EXECUTE format('CREATE ROLE driver_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', app_password);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'driver_migrator') THEN
    EXECUTE format('ALTER ROLE driver_migrator PASSWORD %L', migrator_password);
  ELSE
    EXECUTE format('CREATE ROLE driver_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', migrator_password);
  END IF;
END $$;

-- postgres cần SET ROLE sang migrator để tạo schema/bảng thuộc sở hữu migrator.
GRANT driver_migrator TO postgres;

-- 2. Schema: migrator sở hữu; app chỉ USAGE; role Supabase (anon/authenticated/service_role) không có quyền.
CREATE SCHEMA driver_schema AUTHORIZATION driver_migrator;
REVOKE ALL ON SCHEMA driver_schema FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA driver_schema TO driver_app;

ALTER ROLE driver_app      IN DATABASE postgres SET search_path TO driver_schema, pg_catalog;
ALTER ROLE driver_migrator IN DATABASE postgres SET search_path TO driver_schema, pg_catalog;

-- 3. Bảng: tạo bằng migrator để migrator là owner, app không phải owner.
SET LOCAL ROLE driver_migrator;

-- Hồ sơ tài xế; id = users.id của tài khoản DRIVER (không FK sang Identity).
-- version tăng khi đổi bật/tắt hoặc giữ xe; gửi GPS không tăng version.
CREATE TABLE driver_schema.drivers (
  id             UUID PRIMARY KEY,
  license_number VARCHAR(40) NOT NULL,
  online         BOOLEAN NOT NULL DEFAULT false,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_drivers_license_number CHECK (char_length(btrim(license_number)) BETWEEN 3 AND 40),
  CONSTRAINT ck_drivers_version CHECK (version >= 1)
);

-- Tìm ứng viên: tài xế đang bật, sắp theo id tăng dần.
CREATE INDEX ix_drivers_online ON driver_schema.drivers (id) WHERE online;

-- Mỗi tài xế một xe; biển số đã chuẩn hóa (uppercase, bỏ khoảng trắng hai đầu) không trùng.
CREATE TABLE driver_schema.vehicles (
  id           UUID PRIMARY KEY,
  driver_id    UUID NOT NULL REFERENCES driver_schema.drivers (id),
  plate_number VARCHAR(20) NOT NULL,
  model        VARCHAR(80) NOT NULL,
  color        VARCHAR(30) NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'CAR',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_vehicles_driver UNIQUE (driver_id),
  CONSTRAINT uq_vehicles_plate UNIQUE (plate_number),
  CONSTRAINT ck_vehicles_plate CHECK (plate_number = upper(btrim(plate_number)) AND char_length(plate_number) BETWEEN 3 AND 20),
  CONSTRAINT ck_vehicles_model CHECK (char_length(btrim(model)) BETWEEN 1 AND 80),
  CONSTRAINT ck_vehicles_color CHECK (char_length(btrim(color)) BETWEEN 1 AND 30),
  CONSTRAINT ck_vehicles_type CHECK (vehicle_type = 'CAR')
);

-- Vị trí mới nhất; chỉ ghi đè khi sequence mới hơn (UPSERT ... WHERE stored.sequence < incoming.sequence).
-- Chưa có GPS thì không có dòng (DriverProfile trả locationSequence = 0).
-- Độ mới tính theo received_at (giờ server), không theo recorded_at của client.
CREATE TABLE driver_schema.latest_locations (
  driver_id   UUID PRIMARY KEY REFERENCES driver_schema.drivers (id),
  lat         NUMERIC(9, 6) NOT NULL,
  lng         NUMERIC(9, 6) NOT NULL,
  zone_id     TEXT NOT NULL,
  sequence    BIGINT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_latest_locations_lat CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT ck_latest_locations_lng CHECK (lng BETWEEN -180 AND 180),
  CONSTRAINT ck_latest_locations_zone CHECK (zone_id IN ('ZONE_A', 'ZONE_B')),
  CONSTRAINT ck_latest_locations_sequence CHECK (sequence >= 1)
);

CREATE INDEX ix_latest_locations_candidates ON driver_schema.latest_locations (zone_id, received_at DESC, driver_id);

-- Lượt giữ xe; id = assignmentId do Trip sinh. Không xóa dòng (tombstone).
-- HELD -> CONFIRMED | RELEASED | EXPIRED; CONFIRMED -> RELEASED; RELEASED/EXPIRED là cuối.
-- offer_id NULL chỉ ở tombstone RELEASED tạo khi lệnh trả xe đến trước lệnh giữ xe.
CREATE TABLE driver_schema.reservations (
  id             UUID PRIMARY KEY,
  trip_id        UUID NOT NULL,
  driver_id      UUID NOT NULL REFERENCES driver_schema.drivers (id),
  offer_id       UUID NULL,
  status         TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  release_reason TEXT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_reservations_status CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
  CONSTRAINT ck_reservations_release_reason CHECK (release_reason IN ('ASSIGNMENT_FAILED', 'TRIP_CANCELLED', 'TRIP_COMPLETED')),
  CONSTRAINT ck_reservations_released_has_reason CHECK ((status = 'RELEASED') = (release_reason IS NOT NULL)),
  CONSTRAINT ck_reservations_held_has_expiry CHECK (status <> 'HELD' OR expires_at IS NOT NULL),
  CONSTRAINT ck_reservations_offer CHECK (offer_id IS NOT NULL OR status = 'RELEASED'),
  CONSTRAINT ck_reservations_version CHECK (version >= 1)
);

-- Chống giữ một tài xế cho hai chuyến: mỗi tài xế, mỗi chuyến tối đa một lượt còn hiệu lực.
-- Không đưa now() vào điều kiện index; worker chuyển HELD quá hạn sang EXPIRED.
CREATE UNIQUE INDEX uq_reservations_active_driver ON driver_schema.reservations (driver_id) WHERE status IN ('HELD', 'CONFIRMED');
CREATE UNIQUE INDEX uq_reservations_active_trip   ON driver_schema.reservations (trip_id)   WHERE status IN ('HELD', 'CONFIRMED');
CREATE INDEX ix_reservations_held_expires ON driver_schema.reservations (expires_at) WHERE status = 'HELD';
CREATE INDEX ix_reservations_trip ON driver_schema.reservations (trip_id);

-- Chống gửi trùng request: phạm vi (người gọi, method, path, key); giữ >= 24 giờ.
CREATE TABLE driver_schema.idempotency_keys (
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

CREATE INDEX ix_idempotency_keys_expires ON driver_schema.idempotency_keys (expires_at);

-- Kết quả lệnh nội bộ (Trip/Matching gọi): RESERVE dùng reservationId làm command_id.
CREATE TABLE driver_schema.command_results (
  caller_service  TEXT NOT NULL,
  command_type    TEXT NOT NULL,
  command_id      UUID NOT NULL,
  resource_id     UUID NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'COMPLETED',
  response_status SMALLINT NULL,
  response_body   JSONB NULL,
  correlation_id  UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_command_results PRIMARY KEY (caller_service, command_type, command_id),
  CONSTRAINT ck_command_results_type CHECK (command_type IN ('RESERVE', 'CONFIRM', 'RELEASE')),
  CONSTRAINT ck_command_results_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  CONSTRAINT ck_command_results_completed CHECK (status = 'IN_PROGRESS' OR response_status IS NOT NULL)
);

-- 4. Quyền của app: không DELETE (giữ tombstone/bằng chứng), không DDL, không TRUNCATE.
REVOKE ALL ON ALL TABLES IN SCHEMA driver_schema FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON driver_schema.drivers          TO driver_app;
GRANT SELECT, INSERT         ON driver_schema.vehicles         TO driver_app;
GRANT SELECT, INSERT, UPDATE ON driver_schema.latest_locations TO driver_app;
GRANT SELECT, INSERT, UPDATE ON driver_schema.reservations     TO driver_app;
GRANT SELECT, INSERT, UPDATE ON driver_schema.idempotency_keys TO driver_app;
GRANT SELECT, INSERT, UPDATE ON driver_schema.command_results  TO driver_app;

-- 5. Supabase tự bật RLS cho bảng mới; không có policy thì app đọc ra rỗng và không ghi được.
-- Cô lập bằng schema + GRANT, schema không mở qua Data API, nên tắt RLS (giống Postgres local khi test).
ALTER TABLE driver_schema.drivers          DISABLE ROW LEVEL SECURITY;
ALTER TABLE driver_schema.vehicles         DISABLE ROW LEVEL SECURITY;
ALTER TABLE driver_schema.latest_locations DISABLE ROW LEVEL SECURITY;
ALTER TABLE driver_schema.reservations     DISABLE ROW LEVEL SECURITY;
ALTER TABLE driver_schema.idempotency_keys DISABLE ROW LEVEL SECURITY;
ALTER TABLE driver_schema.command_results  DISABLE ROW LEVEL SECURITY;

RESET ROLE;

COMMIT;
