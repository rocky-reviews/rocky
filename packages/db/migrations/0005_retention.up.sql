-- 0005 retention purge path (P2-6; the only delete path for audit_events, P2-5).
--
-- Design (ADR 0005): rocky_retention is a NOLOGIN role that owns one schema and three
-- SECURITY DEFINER functions, nothing else. Each function deletes rows of one table older than
-- a cutoff and reports how many per org. The application role may EXECUTE them, so a compromised
-- application can at most purge data that is already past its retention period; the audit
-- function additionally refuses any cutoff newer than a hard floor.
--
-- RLS: the functions run as rocky_retention, which is not the owner and cannot bypass RLS, so it
-- gets explicit SELECT/DELETE policies (USING true) on the three tables it purges. Those policies
-- apply to rocky_retention only; the application role still sees one tenant at a time.

GRANT SELECT, DELETE ON analyses, jobs, audit_events TO rocky_retention;

CREATE POLICY analyses_retention_select ON analyses FOR SELECT TO rocky_retention USING (true);
CREATE POLICY analyses_retention_delete ON analyses FOR DELETE TO rocky_retention USING (true);
CREATE POLICY jobs_retention_select ON jobs FOR SELECT TO rocky_retention USING (true);
CREATE POLICY jobs_retention_delete ON jobs FOR DELETE TO rocky_retention USING (true);
CREATE POLICY audit_events_retention_select ON audit_events FOR SELECT TO rocky_retention USING (true);
CREATE POLICY audit_events_retention_delete ON audit_events FOR DELETE TO rocky_retention USING (true);

-- Creating a schema needs CREATE on the database, which only the migrator has; everything
-- inside it is then created as rocky_retention (the migrator holds SET on it, see 0001).
CREATE SCHEMA retention AUTHORIZATION rocky_retention;

SET LOCAL ROLE rocky_retention;

-- Boundary: a row is expired when created_at < before (strictly older). A row created exactly
-- `period` ago is kept. The TypeScript side (src/retention.ts) computes `before` the same way.
CREATE FUNCTION retention.purge_analyses(before timestamptz)
  RETURNS TABLE (org_id uuid, deleted bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH removed AS (
    DELETE FROM public.analyses a WHERE a.created_at < before RETURNING a.org_id
  )
  SELECT removed.org_id, count(*) FROM removed GROUP BY removed.org_id
$$;

-- "Logs" = finished job rows (done/failed/cancelled). Queued and running jobs are never purged.
CREATE FUNCTION retention.purge_jobs(before timestamptz)
  RETURNS TABLE (org_id uuid, deleted bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH removed AS (
    DELETE FROM public.jobs j WHERE j.finished_at IS NOT NULL AND j.finished_at < before RETURNING j.org_id
  )
  SELECT removed.org_id, count(*) FROM removed GROUP BY removed.org_id
$$;

-- The floor (30 days) is deliberately not configurable: it bounds what a compromised
-- application credential can erase. src/retention.ts mirrors it as AUDIT_MIN_RETENTION_DAYS.
CREATE FUNCTION retention.purge_audit_events(before timestamptz)
  RETURNS TABLE (org_id uuid, deleted bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF before > now() - make_interval(days => 30) THEN
    RAISE EXCEPTION 'audit_events: cutoff % is newer than the minimum retention of 30 days', before
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    WITH removed AS (
      DELETE FROM public.audit_events e WHERE e.created_at < before RETURNING e.org_id
    )
    SELECT removed.org_id, count(*) FROM removed GROUP BY removed.org_id;
END
$$;

REVOKE ALL ON FUNCTION retention.purge_analyses(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retention.purge_jobs(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retention.purge_audit_events(timestamptz) FROM PUBLIC;

GRANT USAGE ON SCHEMA retention TO rocky_app;
GRANT EXECUTE ON FUNCTION retention.purge_analyses(timestamptz) TO rocky_app;
GRANT EXECUTE ON FUNCTION retention.purge_jobs(timestamptz) TO rocky_app;
GRANT EXECUTE ON FUNCTION retention.purge_audit_events(timestamptz) TO rocky_app;

RESET ROLE;
