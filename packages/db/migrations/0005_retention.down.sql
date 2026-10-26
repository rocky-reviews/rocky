-- The functions are owned by rocky_retention (the migrator holds SET on it); the schema by the
-- migrator. The owner needs USAGE on the schema to drop its functions; the schema goes right after.
GRANT USAGE ON SCHEMA retention TO rocky_retention;
SET LOCAL ROLE rocky_retention;
DROP FUNCTION IF EXISTS retention.delete_org(uuid);
DROP FUNCTION IF EXISTS retention.purge_audit_events(timestamptz);
DROP FUNCTION IF EXISTS retention.purge_jobs(timestamptz);
DROP FUNCTION IF EXISTS retention.purge_analyses(timestamptz);
RESET ROLE;
DROP SCHEMA IF EXISTS retention;

DROP POLICY IF EXISTS audit_events_retention_insert ON audit_events;
DROP POLICY IF EXISTS audit_events_retention_delete ON audit_events;
DROP POLICY IF EXISTS audit_events_retention_select ON audit_events;
DROP POLICY IF EXISTS orgs_retention_delete ON orgs;
DROP POLICY IF EXISTS orgs_retention_update ON orgs;
DROP POLICY IF EXISTS orgs_retention_select ON orgs;
DROP POLICY IF EXISTS jobs_retention_delete ON jobs;
DROP POLICY IF EXISTS jobs_retention_select ON jobs;
DROP POLICY IF EXISTS analyses_retention_delete ON analyses;
DROP POLICY IF EXISTS analyses_retention_select ON analyses;

REVOKE ALL ON analyses, jobs, orgs, audit_events FROM rocky_retention;

DROP TRIGGER IF EXISTS orgs_deletion_audit ON orgs;
DROP TRIGGER IF EXISTS orgs_deletion_grace ON orgs;
DROP FUNCTION IF EXISTS app.orgs_audit_deletion_schedule();
DROP FUNCTION IF EXISTS app.orgs_enforce_deletion_grace();

DROP TABLE IF EXISTS app.retention_settings;
