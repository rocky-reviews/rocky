-- 0011 LLM metering (P4-5, ADR 0015).
--
-- Every LLM call writes one llm_usage row per attempt the provider reported (packages/llm
-- meterRoles). This migration turns the P2-1 placeholder into that ledger:
--   1. Columns: the call id and attempt (a server-side fallback chain is one call, several
--      attempts), cache writes split by lifetime (5 minutes / 1 hour are priced differently), the
--      outcome and error kind, whether the provider reported usage, and why a row has no price.
--      Token counts are null only when nothing was reported; the cost is null only when it is not
--      a list price (no verified price, unverified billing, no usage). Every field is an id, an
--      enum or a number: CHECKs bound the shapes, so no prompt, code or model output fits.
--   2. Append-only, like audit_events (0004): no UPDATE, DELETE or TRUNCATE for any role, the
--      owner included, except DELETE as rocky_retention (the purge and the erasure below) and the
--      one update the analyses foreign key makes when an analysis is purged (analysis_id → NULL).
--      created_at is the database clock. (call_id, attempt) is unique per org, so a write retried
--      after an unclear failure is stored once.
--   3. Grants: the worker inserts (it makes the calls); the server reads its tenant's rows (usage
--      display, P11); neither can change or delete one. rocky_retention selects and deletes.
--   4. Retention: category `llm_usage` (default 730 days, floor 400) with its own purge, audited
--      like the others. The analyses purge keeps usage (billing reconciles from it).
--   5. Erasure: retention.delete_org deletes the org's usage rows as rocky_retention before the
--      org row (a cascade would run as the owner, which the append-only trigger refuses) and
--      counts them in the tombstone.

-- --- 1. Columns ----------------------------------------------------------------------------------

ALTER TABLE llm_usage RENAME COLUMN cache_write_tokens TO cache_write_5m_tokens;

ALTER TABLE llm_usage
  ADD COLUMN call_id               uuid,
  ADD COLUMN attempt               smallint NOT NULL DEFAULT 0,
  ADD COLUMN cache_write_1h_tokens integer DEFAULT 0,
  ADD COLUMN outcome               text NOT NULL DEFAULT 'ok',
  ADD COLUMN error_kind            text,
  ADD COLUMN usage_status          text NOT NULL DEFAULT 'reported',
  ADD COLUMN cost_status           text NOT NULL DEFAULT 'priced';

-- Rows written before this migration (none in a deployment: nothing metered before P4-5) get a
-- call id of their own; afterwards the writer must state every field.
UPDATE llm_usage SET call_id = gen_random_uuid() WHERE call_id IS NULL;
ALTER TABLE llm_usage
  ALTER COLUMN call_id SET NOT NULL,
  ALTER COLUMN attempt DROP DEFAULT,
  ALTER COLUMN outcome DROP DEFAULT,
  ALTER COLUMN usage_status DROP DEFAULT,
  ALTER COLUMN cost_status DROP DEFAULT,
  ALTER COLUMN input_tokens DROP NOT NULL,
  ALTER COLUMN output_tokens DROP NOT NULL,
  ALTER COLUMN cache_read_tokens DROP NOT NULL,
  ALTER COLUMN cache_read_tokens DROP DEFAULT,
  ALTER COLUMN cache_write_5m_tokens DROP NOT NULL,
  ALTER COLUMN cache_write_5m_tokens DROP DEFAULT,
  ALTER COLUMN cache_write_1h_tokens DROP DEFAULT,
  ALTER COLUMN cost_micro_usd DROP NOT NULL;

ALTER TABLE llm_usage
  ADD CONSTRAINT llm_usage_cache_write_1h_tokens_check CHECK (cache_write_1h_tokens >= 0),
  ADD CONSTRAINT llm_usage_attempt_range CHECK (attempt BETWEEN 0 AND 15),
  ADD CONSTRAINT llm_usage_role_known
    CHECK (role IN ('triage', 'review', 'graph', 'ask', 'embed')),
  ADD CONSTRAINT llm_usage_provider_shape CHECK (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  ADD CONSTRAINT llm_usage_model_shape CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  ADD CONSTRAINT llm_usage_price_version_shape
    CHECK (price_version ~ '^(none|[0-9]{4}-[0-9]{2}-[0-9]{2}([.][0-9]{1,3})?)$'),
  ADD CONSTRAINT llm_usage_outcome_known
    CHECK (outcome IN ('ok', 'refused', 'truncated', 'invalid_output', 'error')),
  -- A failure's kind (LlmErrorKind) when it had one; nothing on a call that did not fail.
  ADD CONSTRAINT llm_usage_error_kind_shape
    CHECK (error_kind IS NULL OR (outcome = 'error' AND error_kind ~ '^[a-z][a-z_]{0,31}$')),
  ADD CONSTRAINT llm_usage_usage_status_known
    CHECK (usage_status IN ('reported', 'partial', 'unreported')),
  -- Partial usage only comes from a call that failed part-way.
  ADD CONSTRAINT llm_usage_partial_is_error CHECK (usage_status <> 'partial' OR outcome = 'error'),
  ADD CONSTRAINT llm_usage_cost_status_known
    CHECK (cost_status IN ('priced', 'no_price', 'billing_unverified', 'no_usage')),
  -- All five counts are known, or none is (never a guessed zero).
  ADD CONSTRAINT llm_usage_tokens_when_reported CHECK (
    (usage_status = 'unreported') = (input_tokens IS NULL)
    AND (input_tokens IS NULL) = (output_tokens IS NULL)
    AND (input_tokens IS NULL) = (cache_read_tokens IS NULL)
    AND (input_tokens IS NULL) = (cache_write_5m_tokens IS NULL)
    AND (input_tokens IS NULL) = (cache_write_1h_tokens IS NULL)),
  ADD CONSTRAINT llm_usage_no_usage_when_unreported
    CHECK ((usage_status = 'unreported') = (cost_status = 'no_usage')),
  -- A cost exactly when the row is priced at list price.
  ADD CONSTRAINT llm_usage_cost_when_priced
    CHECK ((cost_status = 'priced') = (cost_micro_usd IS NOT NULL)),
  ADD CONSTRAINT llm_usage_call_attempt_unique UNIQUE (org_id, call_id, attempt);

CREATE INDEX llm_usage_org_analysis_idx ON llm_usage (org_id, analysis_id)
  WHERE analysis_id IS NOT NULL;
CREATE INDEX llm_usage_created_idx ON llm_usage (created_at);

-- --- 2. Append-only ------------------------------------------------------------------------------

CREATE FUNCTION app.llm_usage_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  unlinked public.llm_usage;
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'rocky_retention' THEN
    RETURN OLD;
  END IF;
  -- The analyses foreign key is ON DELETE SET NULL (analysis_id): purging an analysis unlinks
  -- its usage and keeps it. That update, and only that one, is allowed.
  IF TG_OP = 'UPDATE' AND OLD.analysis_id IS NOT NULL AND NEW.analysis_id IS NULL THEN
    unlinked := OLD;
    unlinked.analysis_id := NULL;
    IF NEW IS NOT DISTINCT FROM unlinked THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'llm_usage is append-only: % blocked for role %', TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Usage rows are removed only by retention (purge_llm_usage, delete_org).';
END
$$;

CREATE TRIGGER llm_usage_no_update_delete
  BEFORE UPDATE OR DELETE ON llm_usage
  FOR EACH ROW EXECUTE FUNCTION app.llm_usage_append_only();

CREATE TRIGGER llm_usage_no_truncate
  BEFORE TRUNCATE ON llm_usage
  FOR EACH STATEMENT EXECUTE FUNCTION app.llm_usage_append_only();

-- A backdated row would fall into the next purge; the database clock decides (as for audit).
CREATE FUNCTION app.llm_usage_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER llm_usage_stamp
  BEFORE INSERT ON llm_usage
  FOR EACH ROW EXECUTE FUNCTION app.llm_usage_stamp();

-- --- 3. Grants -----------------------------------------------------------------------------------

-- The tenant policy (0003, FOR ALL TO rocky_app) still filters every statement; the worker login
-- is a rocky_app member, so it applies to the worker's inserts too.
REVOKE ALL ON llm_usage FROM rocky_app;
GRANT SELECT ON llm_usage TO rocky_app;
GRANT INSERT ON llm_usage TO rocky_worker;

GRANT SELECT, DELETE ON llm_usage TO rocky_retention;
CREATE POLICY llm_usage_retention_select ON llm_usage FOR SELECT TO rocky_retention USING (true);
CREATE POLICY llm_usage_retention_delete ON llm_usage FOR DELETE TO rocky_retention USING (true);

-- --- 4. Retention ---------------------------------------------------------------------------------

ALTER TABLE app.retention_settings DROP CONSTRAINT retention_settings_category_check;
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_category_check
  CHECK (category IN ('analyses', 'logs', 'audit', 'org_deletion_grace', 'webhook_deliveries',
                      'llm_usage'));
-- Usage is what billing reconciles against: never shorter than a yearly period plus a margin.
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_llm_usage_floor
  CHECK (category <> 'llm_usage' OR days >= 400);
INSERT INTO app.retention_settings (category, days) VALUES ('llm_usage', 730);

-- Same contract as the 0005 purges: the period comes from the settings table, `as_of` can only
-- move the cutoff into the past, and each affected org gets a `retention.purged` audit event.
CREATE FUNCTION retention.purge_llm_usage(as_of timestamptz DEFAULT now())
  RETURNS TABLE (org_id uuid, deleted bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH cutoff AS (
    SELECT least(as_of, now()) - make_interval(days => s.days) AS before
      FROM app.retention_settings s WHERE s.category = 'llm_usage'
  ),
  removed AS (
    DELETE FROM public.llm_usage u USING cutoff c WHERE u.created_at < c.before RETURNING u.org_id
  ),
  counts AS (
    SELECT removed.org_id, count(*) AS deleted FROM removed GROUP BY removed.org_id
  ),
  logged AS (
    INSERT INTO public.audit_events (org_id, actor_type, actor_id, action, target_type, target_id, metadata)
    SELECT counts.org_id, 'system', 'retention', 'retention.purged', 'table', 'llm_usage',
           jsonb_build_object('category', 'llm_usage', 'deleted', counts.deleted, 'before', c.before)
      FROM counts, cutoff c
  )
  SELECT counts.org_id, counts.deleted FROM counts
$$;

REVOKE ALL ON FUNCTION retention.purge_llm_usage(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention.purge_llm_usage(timestamptz) TO rocky_app;

-- --- 5. Erasure -----------------------------------------------------------------------------------

ALTER TABLE app.org_deletions ADD COLUMN llm_usage_deleted bigint NOT NULL DEFAULT 0
  CHECK (llm_usage_deleted >= 0);

-- delete_org is owned by rocky_retention, which has no language to recreate it with: the owner
-- drops it (USAGE on the schema only for that) and the migrator creates the new version and
-- hands it over (the 0005 / 0007 pattern).
GRANT USAGE ON SCHEMA retention TO rocky_retention;
SET LOCAL ROLE rocky_retention;
DROP FUNCTION retention.delete_org(uuid);
RESET ROLE;
REVOKE USAGE ON SCHEMA retention FROM rocky_retention;

-- 0007's erasure, unchanged except that the org's usage rows are deleted (as rocky_retention)
-- right after its audit events and before the org row, and counted in the tombstone.
CREATE FUNCTION retention.delete_org(org uuid)
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  due timestamptz;
  erasing timestamptz;
  inst bigint;
  acct bigint;
  frg text;
  n_audit bigint;
  n_usage bigint;
  n_orgs bigint;
  n_inbox bigint;
  n_older bigint;
  n_scrubbed bigint;
BEGIN
  SELECT o.delete_after, o.erasing_at, o.installation_id, o.account_id, o.forge
    INTO due, erasing, inst, acct, frg
    FROM public.orgs o WHERE o.id = org FOR UPDATE;
  IF NOT FOUND OR due IS NULL THEN
    RAISE EXCEPTION 'org % is not scheduled for deletion', org
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF due > now() THEN
    RAISE EXCEPTION 'org % is inside its deletion grace period until %', org, due
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF erasing IS NULL THEN
    RAISE EXCEPTION 'org % is not being erased (erasing_at is not set)', org
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  DELETE FROM public.audit_events e WHERE e.org_id = org;
  GET DIAGNOSTICS n_audit = ROW_COUNT;
  table_name := 'audit_events'; deleted := n_audit; RETURN NEXT;

  DELETE FROM public.llm_usage u WHERE u.org_id = org;
  GET DIAGNOSTICS n_usage = ROW_COUNT;
  table_name := 'llm_usage'; deleted := n_usage; RETURN NEXT;

  DELETE FROM public.orgs o WHERE o.id = org;
  GET DIAGNOSTICS n_orgs = ROW_COUNT;
  table_name := 'orgs'; deleted := n_orgs; RETURN NEXT;

  DELETE FROM app.webhook_deliveries d
   WHERE d.forge = frg AND d.installation_id = inst
     AND (d.processed_at IS NOT NULL OR d.parked_at IS NOT NULL
          OR d.event_type NOT LIKE 'installation.%'
          OR jsonb_typeof(d.event -> 'account') IS DISTINCT FROM 'object'
          OR coalesce(jsonb_typeof(d.event -> 'sender'), 'missing') NOT IN ('null', 'object'));
  GET DIAGNOSTICS n_inbox = ROW_COUNT;
  DELETE FROM app.webhook_deliveries d
   WHERE d.forge = frg AND d.installation_id <> inst
     AND (d.processed_at IS NOT NULL OR d.parked_at IS NOT NULL)
     AND jsonb_typeof(d.event -> 'account') = 'object'
     AND (d.event #>> '{account,id}') = acct::text
     AND NOT EXISTS (SELECT 1 FROM public.orgs o
                      WHERE o.forge = frg AND o.installation_id = d.installation_id
                        AND o.erasing_at IS NULL);
  GET DIAGNOSTICS n_older = ROW_COUNT;
  n_inbox := n_inbox + n_older;
  table_name := 'webhook_deliveries'; deleted := n_inbox; RETURN NEXT;

  UPDATE app.webhook_deliveries d
     SET event = jsonb_set(jsonb_set(d.event, '{sender}', 'null'::jsonb),
                           '{account,login}', '"erased"'::jsonb)
   WHERE d.forge = frg AND d.installation_id = inst
     AND jsonb_typeof(d.event -> 'account') = 'object'
     AND jsonb_typeof(d.event -> 'sender') IN ('null', 'object')
     AND (d.event -> 'sender' <> 'null'::jsonb
          OR d.event #>> '{account,login}' IS DISTINCT FROM 'erased');
  GET DIAGNOSTICS n_scrubbed = ROW_COUNT;

  INSERT INTO app.org_deletions (org_id, forge, installation_id, was_due, audit_events_deleted,
                                 llm_usage_deleted, inbox_rows_deleted, inbox_rows_scrubbed)
  VALUES (org, frg, inst, due, n_audit, n_usage, n_inbox, n_scrubbed);
  RETURN;
END
$$;

REVOKE ALL ON FUNCTION retention.delete_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention.delete_org(uuid) TO rocky_worker;

GRANT CREATE ON SCHEMA retention TO rocky_retention;
ALTER FUNCTION retention.purge_llm_usage(timestamptz) OWNER TO rocky_retention;
ALTER FUNCTION retention.delete_org(uuid) OWNER TO rocky_retention;
REVOKE CREATE ON SCHEMA retention FROM rocky_retention;
