-- Khởi tạo DB riêng của Driver (driver-db / driver_db). Docker chỉ chạy file này khi volume còn trống.
-- Chỉ tạo user và schema; bảng do migration của Driver tạo (npm run migration:driver:run).
\getenv app_password DRIVER_APP_PASSWORD
\getenv migrator_password DRIVER_MIGRATOR_PASSWORD
CREATE ROLE driver_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE driver_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE driver_db FROM PUBLIC;
GRANT CONNECT ON DATABASE driver_db TO driver_app, driver_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA driver_schema AUTHORIZATION driver_migrator;
REVOKE ALL ON SCHEMA driver_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA driver_schema TO driver_app;
ALTER ROLE driver_app IN DATABASE driver_db SET search_path TO driver_schema, pg_catalog;
ALTER ROLE driver_migrator IN DATABASE driver_db SET search_path TO driver_schema, pg_catalog;
