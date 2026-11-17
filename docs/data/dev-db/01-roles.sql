-- Local databases only (fitanalytica_dev, fitanalytica_test). Run once in each, connected to it.
--   psql -d fitanalytica_dev -f 01-roles.sql
-- api_writer is the writer pool's role. api_reader is the reader pool's role and is read-only, like a replica:
-- a write through the reader pool fails here, as it would in production.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_writer') THEN CREATE ROLE api_writer LOGIN PASSWORD 'dev'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_reader') THEN CREATE ROLE api_reader LOGIN PASSWORD 'dev'; END IF;
END $$;

ALTER ROLE api_reader SET default_transaction_read_only = on;

-- connect rights on the database this is run in (dev or test)
SELECT format('GRANT CONNECT ON DATABASE %I TO api_writer, api_reader', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO api_writer, api_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO api_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO api_reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO api_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO api_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO api_writer;
