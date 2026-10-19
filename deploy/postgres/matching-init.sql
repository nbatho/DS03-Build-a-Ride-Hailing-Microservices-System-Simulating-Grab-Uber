-- Khởi tạo DB riêng của Matching (matching-db / matching_db). Docker chỉ chạy file này khi volume còn trống.
-- Chỉ tạo user và schema; bảng do migration của Matching tạo (npm run migration:matching:run).
\getenv app_password MATCHING_APP_PASSWORD
\getenv migrator_password MATCHING_MIGRATOR_PASSWORD
CREATE ROLE matching_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE matching_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE matching_db FROM PUBLIC;
GRANT CONNECT ON DATABASE matching_db TO matching_app, matching_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA matching_schema AUTHORIZATION matching_migrator;
REVOKE ALL ON SCHEMA matching_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA matching_schema TO matching_app;
ALTER ROLE matching_app IN DATABASE matching_db SET search_path TO matching_schema, pg_catalog;
ALTER ROLE matching_migrator IN DATABASE matching_db SET search_path TO matching_schema, pg_catalog;
