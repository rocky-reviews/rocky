-- 0001 foundation: extension, infrastructure schema, roles, tenant-context function.
--
-- Runs as the migrator (table owner). Roles are cluster-wide, so they are created only if
-- missing and their attributes are re-asserted every time: a pre-existing role (for example
-- from deploy/dev/init.sql) can never keep stronger attributes than the ones below.

-- pgvector is provisioned by the DBA/superuser (deploy/dev/init.sql); IF NOT EXISTS makes
-- this a no-op there and a clear error where the extension is unavailable.
CREATE EXTENSION IF NOT EXISTS vector;

-- Infrastructure objects live outside `public`, so every table in `public` is a tenant table
-- (the isolation suite enumerates them and allow-lists only app.schema_migrations).
CREATE SCHEMA IF NOT EXISTS app;

-- rocky_app: the application. A LOGIN role is made a member of it per deployment
-- (ensureLoginRole); it gets exactly the grants below and nothing else.
-- rocky_retention: owns the retention purge functions (0005). Never logs in, inherits nothing.
-- CREATE ROLE defaults are NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOLOGIN.
-- A non-superuser migrator cannot ALTER those attributes (even to the same value), so a
-- pre-existing role is checked rather than fixed: stronger attributes abort the migration.
DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rocky_app') THEN
    CREATE ROLE rocky_app INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rocky_retention') THEN
    CREATE ROLE rocky_retention NOINHERIT;
  END IF;

  FOR r IN
    SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
      FROM pg_roles WHERE rolname IN ('rocky_app', 'rocky_retention')
  LOOP
    IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolcanlogin THEN
      RAISE EXCEPTION 'role % must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOLOGIN; fix it before migrating', r.rolname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = r.rolname)) THEN
      RAISE EXCEPTION 'role % must not be a member of any other role', r.rolname;
    END IF;
  END LOOP;

  -- The migrator must be able to SET ROLE rocky_retention to create objects it owns (0005).
  -- A superuser can already; a CREATEROLE migrator holds ADMIN on the role it created and
  -- grants itself SET (not INHERIT: the migrator must not pick up retention privileges).
  IF NOT pg_has_role(current_user, 'rocky_retention', 'SET') THEN
    EXECUTE format('GRANT rocky_retention TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  END IF;
END
$$;

-- Nobody but the owner creates objects in public (Postgres 15+ default, re-asserted).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rocky_app, rocky_retention;
GRANT USAGE ON SCHEMA app TO rocky_app, rocky_retention;

-- The tenant for the current transaction, set by withOrg via set_config('app.org_id', …, true).
-- Missing or empty → NULL, so `org_id = app.current_org_id()` matches no row. Anything that is
-- not a uuid raises (22P02) instead of widening the filter. STABLE + SQL body so the planner
-- inlines it into every policy.
CREATE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN nullif(current_setting('app.org_id', true), '')::uuid;

COMMENT ON FUNCTION app.current_org_id() IS
  'Tenant of the current transaction (app.org_id), NULL when unset. Used by every RLS policy.';
