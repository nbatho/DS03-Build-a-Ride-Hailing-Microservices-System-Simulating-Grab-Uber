-- Khởi tạo DB riêng của Pricing (pricing-db / pricing_db). Docker chỉ chạy file này khi volume còn trống.
-- Chỉ tạo user và schema; bảng và bảng giá CAR_V1 do migration của Pricing tạo (npm run migration:pricing:run).
\getenv app_password PRICING_APP_PASSWORD
\getenv migrator_password PRICING_MIGRATOR_PASSWORD
CREATE ROLE pricing_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE pricing_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE pricing_db FROM PUBLIC;
GRANT CONNECT ON DATABASE pricing_db TO pricing_app, pricing_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA pricing_schema AUTHORIZATION pricing_migrator;
REVOKE ALL ON SCHEMA pricing_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA pricing_schema TO pricing_app;
ALTER ROLE pricing_app IN DATABASE pricing_db SET search_path TO pricing_schema, pg_catalog;
ALTER ROLE pricing_migrator IN DATABASE pricing_db SET search_path TO pricing_schema, pg_catalog;
