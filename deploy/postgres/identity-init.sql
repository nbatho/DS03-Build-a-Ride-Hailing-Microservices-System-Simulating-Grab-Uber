\getenv app_password IDENTITY_APP_PASSWORD
\getenv migrator_password IDENTITY_MIGRATOR_PASSWORD
CREATE ROLE identity_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE identity_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE ride_hailing FROM PUBLIC;
GRANT CONNECT ON DATABASE ride_hailing TO identity_app, identity_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA identity_schema AUTHORIZATION identity_migrator;
REVOKE ALL ON SCHEMA identity_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA identity_schema TO identity_app;
ALTER ROLE identity_app IN DATABASE ride_hailing SET search_path TO identity_schema, pg_catalog;
ALTER ROLE identity_migrator IN DATABASE ride_hailing SET search_path TO identity_schema, pg_catalog;
