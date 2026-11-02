\getenv app_password TRIP_APP_PASSWORD
\getenv migrator_password TRIP_MIGRATOR_PASSWORD
CREATE ROLE trip_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE trip_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE trip_db FROM PUBLIC;
GRANT CONNECT ON DATABASE trip_db TO trip_app, trip_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA trip_schema AUTHORIZATION trip_migrator;
REVOKE ALL ON SCHEMA trip_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA trip_schema TO trip_app;
ALTER ROLE trip_app IN DATABASE trip_db SET search_path TO trip_schema, pg_catalog;
ALTER ROLE trip_migrator IN DATABASE trip_db SET search_path TO trip_schema, pg_catalog;
