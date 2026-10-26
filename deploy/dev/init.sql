-- Runs once when the dev database volume is created (docker-compose.dev.yml).
-- Mirrors what a production DBA provisions before the first migration (ADR 0005 §2,
-- "Provisioning"): extensions, the revokes the tenant model depends on, and a LOGIN role for
-- the application that is a member of rocky_app. Migration 0001 verifies the revokes and
-- refuses to run without them.
-- Changing this file requires recreating the volume: `pnpm dev:down -v` (dev data is lost).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- No procedural code for anyone but the migrator (here the superuser `rocky`, which needs no
-- grant). A DO block, or a function created in any language, could call set_config and switch
-- tenant in the middle of a transaction, out of sight of the statement guard.
REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC;
REVOKE USAGE ON LANGUAGE sql FROM PUBLIC;
-- `UPDATE pg_settings` is set_config by another name.
REVOKE UPDATE ON pg_catalog.pg_settings FROM PUBLIC;
-- Catalog functions that execute SQL passed as text (a set_config can hide in the literal).
REVOKE EXECUTE ON FUNCTION
  pg_catalog.query_to_xml(text, boolean, boolean, text),
  pg_catalog.query_to_xmlschema(text, boolean, boolean, text),
  pg_catalog.query_to_xml_and_xmlschema(text, boolean, boolean, text),
  pg_catalog.ts_stat(text),
  pg_catalog.ts_stat(text, text),
  pg_catalog.ts_rewrite(tsquery, text)
FROM PUBLIC;

-- Group role the migrations manage (created here so the login role can join it before the
-- first migration runs; migration 0001 verifies its attributes and adds the grants).
CREATE ROLE rocky_app NOLOGIN INHERIT;
-- The application's dev login. Development-only password; .env.example uses it.
CREATE ROLE rocky_app_dev LOGIN PASSWORD 'rocky-dev-only' INHERIT IN ROLE rocky_app;
