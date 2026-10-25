SET LOCAL ROLE rocky_retention;
DROP FUNCTION IF EXISTS retention.purge_audit_events(timestamptz);
DROP FUNCTION IF EXISTS retention.purge_jobs(timestamptz);
DROP FUNCTION IF EXISTS retention.purge_analyses(timestamptz);
DROP SCHEMA IF EXISTS retention;
RESET ROLE;

DROP POLICY IF EXISTS audit_events_retention_delete ON audit_events;
DROP POLICY IF EXISTS audit_events_retention_select ON audit_events;
DROP POLICY IF EXISTS jobs_retention_delete ON jobs;
DROP POLICY IF EXISTS jobs_retention_select ON jobs;
DROP POLICY IF EXISTS analyses_retention_delete ON analyses;
DROP POLICY IF EXISTS analyses_retention_select ON analyses;

REVOKE ALL ON analyses, jobs, audit_events FROM rocky_retention;
