-- 0005 retention and org deletion (P2-6; the only delete paths for audit_events, P2-5).
--
-- Design (ADR 0005 §5): rocky_retention is a NOLOGIN role that owns one schema and four
-- SECURITY DEFINER functions, nothing else. The retention periods live in a migrator-owned
-- settings table that the application can read but not write, and every purge function derives
-- its cutoff from that table and the database clock: the caller can only pass an `as_of` in the
-- past (for tests and replays), never a cutoff closer to now. So a compromised application
-- credential can at most purge data that is already past its configured retention period.
--
-- RLS: the functions run as rocky_retention, which is not the owner and cannot bypass RLS, so it
-- gets explicit USING (true) policies for exactly the statements it issues. The application role
-- still sees one tenant at a time.

-- --- Settings -----------------------------------------------------------------------------------

CREATE TABLE app.retention_settings (
  category    text        PRIMARY KEY
                          CHECK (category IN ('analyses', 'logs', 'audit', 'org_deletion_grace')),
  days        integer     NOT NULL CHECK (days >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- The audit floor: the period is configurable, but never below 30 days.
  CONSTRAINT retention_settings_audit_floor CHECK (category <> 'audit' OR days >= 30)
);

INSERT INTO app.retention_settings (category, days) VALUES
  ('analyses', 90),
  ('logs', 30),
  ('audit', 365),
  ('org_deletion_grace', 7);

GRANT SELECT ON app.retention_settings TO rocky_app, rocky_retention;

-- --- Org deletion grace ---------------------------------------------------------------------

-- The application schedules deletion by setting orgs.delete_after (uninstall, P3-3). It can
-- never schedule it sooner than the configured grace period from now, so a compromised
-- credential cannot request-and-execute an erasure in one go.
CREATE FUNCTION app.orgs_enforce_deletion_grace() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  grace integer;
BEGIN
  IF NEW.delete_after IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.delete_after IS DISTINCT FROM NEW.delete_after) THEN
    SELECT s.days INTO STRICT grace FROM app.retention_settings s WHERE s.category = 'org_deletion_grace';
    NEW.delete_after := greatest(NEW.delete_after, now() + make_interval(days => grace));
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER orgs_deletion_grace
  BEFORE INSERT OR UPDATE OF delete_after ON orgs
  FOR EACH ROW EXECUTE FUNCTION app.orgs_enforce_deletion_grace();

-- --- Retention role: grants and policies ------------------------------------------------------

GRANT SELECT, DELETE ON analyses, jobs, orgs TO rocky_retention;
GRANT SELECT, INSERT, DELETE ON audit_events TO rocky_retention;

CREATE POLICY analyses_retention_select ON analyses FOR SELECT TO rocky_retention USING (true);
CREATE POLICY analyses_retention_delete ON analyses FOR DELETE TO rocky_retention USING (true);
CREATE POLICY jobs_retention_select ON jobs FOR SELECT TO rocky_retention USING (true);
CREATE POLICY jobs_retention_delete ON jobs FOR DELETE TO rocky_retention USING (true);
CREATE POLICY orgs_retention_select ON orgs FOR SELECT TO rocky_retention USING (true);
CREATE POLICY orgs_retention_delete ON orgs FOR DELETE TO rocky_retention USING (true);
CREATE POLICY audit_events_retention_select ON audit_events FOR SELECT TO rocky_retention USING (true);
CREATE POLICY audit_events_retention_delete ON audit_events FOR DELETE TO rocky_retention USING (true);
-- The purge functions record what they removed, in the same statement.
CREATE POLICY audit_events_retention_insert ON audit_events FOR INSERT TO rocky_retention WITH CHECK (true);

-- --- Retention role: schema and functions ------------------------------------------------------

-- Creating a schema needs CREATE on the database, which only the migrator has; everything
-- inside it is then created as rocky_retention (the migrator holds SET on it, see 0001).
CREATE SCHEMA retention AUTHORIZATION rocky_retention;

SET LOCAL ROLE rocky_retention;

-- Boundary: a row is expired when created_at < before (strictly older), where
-- before = least(as_of, now()) - period. A row created exactly `period` ago is kept.
-- `as_of` lets a caller purge as of an earlier instant; a value in the future is clamped.
-- If the settings row is missing the cutoff is NULL and nothing is deleted (fail closed).
CREATE FUNCTION retention.purge_analyses(as_of timestamptz DEFAULT now())
  RETURNS TABLE (org_id uuid, deleted bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH cutoff AS (
    SELECT least(as_of, now()) - make_interval(days => s.days) AS before
      FROM app.retention_settings s WHERE s.category = 'analyses'
  ),
  removed AS (
    DELETE FROM public.analyses a USING cutoff c WHERE a.created_at < c.before RETURNING a.org_id
  ),
  counts AS (
    SELECT removed.org_id, count(*) AS deleted FROM removed GROUP BY removed.org_id
  ),
  logged AS (
    INSERT INTO public.audit_events (org_id, actor_type, actor_id, action, target_type, target_id, metadata)
    SELECT counts.org_id, 'system', 'retention', 'retention.purged', 'table', 'analyses',
           jsonb_build_object('category', 'analyses', 'deleted', counts.deleted, 'before', c.before)
      FROM counts, cutoff c
  )
  SELECT counts.org_id, counts.deleted FROM counts
$$;

-- "Logs" = finished job rows (done/failed/cancelled). Queued and running jobs are never purged.
CREATE FUNCTION retention.purge_jobs(as_of timestamptz DEFAULT now())
  RETURNS TABLE (org_id uuid, deleted bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH cutoff AS (
    SELECT least(as_of, now()) - make_interval(days => s.days) AS before
      FROM app.retention_settings s WHERE s.category = 'logs'
  ),
  removed AS (
    DELETE FROM public.jobs j USING cutoff c
     WHERE j.finished_at IS NOT NULL AND j.finished_at < c.before RETURNING j.org_id
  ),
  counts AS (
    SELECT removed.org_id, count(*) AS deleted FROM removed GROUP BY removed.org_id
  ),
  logged AS (
    INSERT INTO public.audit_events (org_id, actor_type, actor_id, action, target_type, target_id, metadata)
    SELECT counts.org_id, 'system', 'retention', 'retention.purged', 'table', 'jobs',
           jsonb_build_object('category', 'logs', 'deleted', counts.deleted, 'before', c.before)
      FROM counts, cutoff c
  )
  SELECT counts.org_id, counts.deleted FROM counts
$$;

-- The audit period is the floor: it is read from the settings table, whose CHECK keeps it at
-- 30 days or more, and the application cannot change it.
CREATE FUNCTION retention.purge_audit_events(as_of timestamptz DEFAULT now())
  RETURNS TABLE (org_id uuid, deleted bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH cutoff AS (
    SELECT least(as_of, now()) - make_interval(days => s.days) AS before
      FROM app.retention_settings s WHERE s.category = 'audit'
  ),
  removed AS (
    DELETE FROM public.audit_events e USING cutoff c WHERE e.created_at < c.before RETURNING e.org_id
  ),
  counts AS (
    SELECT removed.org_id, count(*) AS deleted FROM removed GROUP BY removed.org_id
  ),
  logged AS (
    INSERT INTO public.audit_events (org_id, actor_type, actor_id, action, target_type, target_id, metadata)
    SELECT counts.org_id, 'system', 'retention', 'retention.purged', 'table', 'audit_events',
           jsonb_build_object('category', 'audit', 'deleted', counts.deleted, 'before', c.before)
      FROM counts, cutoff c
  )
  SELECT counts.org_id, counts.deleted FROM counts
$$;

-- Erases one org (uninstall grace elapsed, GDPR). Foreign-key cascades run as the table owner,
-- which the append-only trigger blocks, so audit_events is deleted here first as rocky_retention;
-- deleting the orgs row then cascades through every other tenant table (RI ignores RLS).
-- Nothing is audited: the tenant that would own the event no longer exists; the caller logs it.
CREATE FUNCTION retention.delete_org(org uuid)
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  due timestamptz;
  n bigint;
BEGIN
  SELECT o.delete_after INTO due FROM public.orgs o WHERE o.id = org;
  IF NOT FOUND OR due IS NULL THEN
    RAISE EXCEPTION 'org % is not scheduled for deletion', org
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF due > now() THEN
    RAISE EXCEPTION 'org % is inside its deletion grace period until %', org, due
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.audit_events e WHERE e.org_id = org;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'audit_events'; deleted := n; RETURN NEXT;

  DELETE FROM public.orgs o WHERE o.id = org;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'orgs'; deleted := n; RETURN NEXT;
  RETURN;
END
$$;

REVOKE ALL ON FUNCTION retention.purge_analyses(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retention.purge_jobs(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retention.purge_audit_events(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retention.delete_org(uuid) FROM PUBLIC;

GRANT USAGE ON SCHEMA retention TO rocky_app;
GRANT EXECUTE ON FUNCTION retention.purge_analyses(timestamptz) TO rocky_app;
GRANT EXECUTE ON FUNCTION retention.purge_jobs(timestamptz) TO rocky_app;
GRANT EXECUTE ON FUNCTION retention.purge_audit_events(timestamptz) TO rocky_app;
GRANT EXECUTE ON FUNCTION retention.delete_org(uuid) TO rocky_app;

RESET ROLE;
