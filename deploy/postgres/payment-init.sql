-- Khởi tạo DB riêng của Payment (payment-db / payment_db). Docker chỉ chạy file này khi volume còn trống.
-- Chỉ tạo user và schema; bảng do migration của Payment tạo (npm run migration:payment:run).
\getenv app_password PAYMENT_APP_PASSWORD
\getenv migrator_password PAYMENT_MIGRATOR_PASSWORD
CREATE ROLE payment_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE payment_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE payment_db FROM PUBLIC;
GRANT CONNECT ON DATABASE payment_db TO payment_app, payment_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA payment_schema AUTHORIZATION payment_migrator;
REVOKE ALL ON SCHEMA payment_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA payment_schema TO payment_app;
ALTER ROLE payment_app IN DATABASE payment_db SET search_path TO payment_schema, pg_catalog;
ALTER ROLE payment_migrator IN DATABASE payment_db SET search_path TO payment_schema, pg_catalog;
