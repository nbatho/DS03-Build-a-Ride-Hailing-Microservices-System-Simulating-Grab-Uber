-- Khởi tạo DB riêng của Notification (notification-db / notification_db). Docker chỉ chạy file này khi volume còn trống.
-- Chỉ tạo user và schema; bảng do migration của Notification tạo (npm run migration:notification:run).
\getenv app_password NOTIFICATION_APP_PASSWORD
\getenv migrator_password NOTIFICATION_MIGRATOR_PASSWORD
CREATE ROLE notification_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE notification_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE notification_db FROM PUBLIC;
GRANT CONNECT ON DATABASE notification_db TO notification_app, notification_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA notification_schema AUTHORIZATION notification_migrator;
REVOKE ALL ON SCHEMA notification_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA notification_schema TO notification_app;
ALTER ROLE notification_app IN DATABASE notification_db SET search_path TO notification_schema, pg_catalog;
ALTER ROLE notification_migrator IN DATABASE notification_db SET search_path TO notification_schema, pg_catalog;
