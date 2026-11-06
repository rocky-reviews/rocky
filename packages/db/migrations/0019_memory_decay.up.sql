-- 0019 project memory decay (P8-4, ADR 0038).
--
-- Three windows, in app.retention_settings like every retention period (migrator-owned, the
-- application reads them and cannot shorten them):
--   memory_decay       days without a citation after which a learned entry loses a confidence step
--   memory_unused      days without a citation after which a learned entry is removed
--   memory_superseded  days after which a superseded learned entry (history) is removed
-- Floors: a one-day "unused" window would erase every repository's memory on the first run, so
-- `memory_unused` is at least 30 days and `memory_superseded` at least 7 (history outlives a
-- weekend's review round). Member-written entries are never touched by the job (ADR 0038 §2).
--
-- decayed_at: when the decay job last lowered an entry's confidence; NULL until it does. With
-- it a run takes at most one step per idle period, so the job is idempotent at any instant.
--
-- worker.live_orgs: the job runs per org inside `withOrg` (never cross-tenant SQL, ADR 0036 §4),
-- so the worker needs the list of orgs to visit: ids only, in id order, paged by `p_after`,
-- orgs being erased or scheduled for deletion left out (their rows are going). Owned by
-- rocky_lifecycle (which already reads `orgs` through its 0007 policy), callable by the worker
-- role only, like worker.installation_orgs.

ALTER TABLE app.retention_settings DROP CONSTRAINT retention_settings_category_check;
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_category_check
  CHECK (category IN ('analyses', 'logs', 'audit', 'org_deletion_grace', 'webhook_deliveries',
                      'llm_usage', 'memory_decay', 'memory_unused', 'memory_superseded'));
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_memory_unused_floor
  CHECK (category <> 'memory_unused' OR days >= 30);
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_memory_superseded_floor
  CHECK (category <> 'memory_superseded' OR days >= 7);
INSERT INTO app.retention_settings (category, days) VALUES
  ('memory_decay', 90),
  ('memory_unused', 365),
  ('memory_superseded', 180);

ALTER TABLE memory_entries ADD COLUMN decayed_at timestamptz;

-- The job's candidate scans: current learned entries of an org by idle time, and superseded
-- learned entries by the time they were superseded (`updated_at`, stamped by the supersede).
CREATE INDEX memory_entries_org_learned_current_idx
  ON memory_entries (org_id, created_at) WHERE origin = 'learned' AND superseded_by IS NULL;
CREATE INDEX memory_entries_org_learned_history_idx
  ON memory_entries (org_id, updated_at) WHERE origin = 'learned' AND superseded_by IS NOT NULL;

CREATE FUNCTION worker.live_orgs(p_after uuid, p_limit integer)
  RETURNS TABLE (org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT o.id FROM public.orgs o
   WHERE o.erasing_at IS NULL AND o.delete_after IS NULL
     AND (p_after IS NULL OR o.id > p_after)
   ORDER BY o.id
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 1000)
$$;

REVOKE ALL ON FUNCTION worker.live_orgs(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker.live_orgs(uuid, integer) TO rocky_worker;
GRANT CREATE ON SCHEMA worker TO rocky_lifecycle;
ALTER FUNCTION worker.live_orgs(uuid, integer) OWNER TO rocky_lifecycle;
REVOKE CREATE ON SCHEMA worker FROM rocky_lifecycle;
