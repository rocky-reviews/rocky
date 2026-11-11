#!/bin/sh
# Provisioning of the self-host database (P10-1, ADR 0043 §2; ADR 0005 §2 "Provisioning").
# The Postgres image runs this once, as the bootstrap superuser, when the data volume is empty.
# It does what a DBA does before the first migration and nothing more: the extensions, the
# revokes tenant isolation rests on (migration 0001 refuses to run without them), and the
# migrator role, which owns the database, is CREATEROLE and not a superuser. The group roles
# come from the migrations and the two login roles from the migration step (scripts/migrate.ts),
# exactly like the test harness in packages/db/src/testing.
#
# The migrator password reaches psql as a variable and is quoted by psql (:'name'); it is never
# part of the SQL text, so a password with quotes or backslashes cannot change the statement.
set -eu

: "${ROCKY_DB_MIGRATOR_PASSWORD:?ROCKY_DB_MIGRATOR_PASSWORD must be set (deploy/.env)}"
# The same alphabet the migration step accepts for the other logins: URL-safe, no `$` (compose
# interpolates it), no quotes or whitespace; 16 characters at least (`openssl rand -hex 24`).
case "$ROCKY_DB_MIGRATOR_PASSWORD" in
  *[!A-Za-z0-9._~-]*)
    echo "ROCKY_DB_MIGRATOR_PASSWORD may only use A-Z a-z 0-9 . _ ~ -" >&2
    exit 1
    ;;
esac
if [ "${#ROCKY_DB_MIGRATOR_PASSWORD}" -lt 16 ] || [ "${#ROCKY_DB_MIGRATOR_PASSWORD}" -gt 256 ]; then
  echo "ROCKY_DB_MIGRATOR_PASSWORD must be 16-256 characters" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_password="$ROCKY_DB_MIGRATOR_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- No procedural code for anyone but the migrator: a DO block or a function could call
-- set_config and switch tenant out of sight of the statement guard (ADR 0005 §3).
REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC;
REVOKE USAGE ON LANGUAGE sql FROM PUBLIC;
-- `UPDATE pg_settings` is set_config by another name.
REVOKE UPDATE ON pg_catalog.pg_settings FROM PUBLIC;
-- Catalog functions that execute SQL passed as text.
REVOKE EXECUTE ON FUNCTION
  pg_catalog.query_to_xml(text, boolean, boolean, text),
  pg_catalog.query_to_xmlschema(text, boolean, boolean, text),
  pg_catalog.query_to_xml_and_xmlschema(text, boolean, boolean, text),
  pg_catalog.ts_stat(text),
  pg_catalog.ts_stat(text, text),
  pg_catalog.ts_rewrite(tsquery, text)
FROM PUBLIC;

-- The migrator: owner of the database (so of the schemas and tables the migrations create),
-- CREATEROLE for the group and login roles, not a superuser, with the two languages back.
CREATE ROLE rocky LOGIN CREATEROLE;
GRANT USAGE ON LANGUAGE plpgsql, sql TO rocky;
ALTER DATABASE rocky OWNER TO rocky;
-- The password in a statement the server will not log, whatever logging the cluster has:
-- not as a statement, not on error, not as a slow query. psql sends it as a literal; Postgres
-- stores a SCRAM-SHA-256 verifier (password_encryption defaults to scram-sha-256).
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
ALTER ROLE rocky PASSWORD :'migrator_password';
RESET log_min_duration_statement;
RESET log_min_error_statement;
RESET log_statement;
SQL
