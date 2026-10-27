-- Reverts 0011. Usage rows the 0002 shape cannot hold (no reported tokens, or no list price) are
-- deleted: the old columns are NOT NULL, and writing a zero there would invent a count or a cost.

-- --- 5. Erasure: back to the 0007 function --------------------------------------------------------
GRANT USAGE ON SCHEMA retention TO rocky_retention;
SET LOCAL ROLE rocky_retention;
DROP FUNCTION IF EXISTS retention.delete_org(uuid);
DROP FUNCTION IF EXISTS retention.purge_llm_usage(timestamptz);
RESET ROLE;
REVOKE USAGE ON SCHEMA retention FROM rocky_retention;

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

  DELETE FROM public.orgs o WHERE o.id = org;
  GET DIAGNOSTICS n_orgs = ROW_COUNT;
  table_name := 'orgs'; deleted := n_orgs; RETURN NEXT;

  -- The erased installation's rows: finished ones, ones nobody will process for an erased org
  -- (pull requests), and any whose stored shape is unexpected (cannot be scrubbed safely; the
  -- CHECK on the table keeps new ones out, review round 2 B).
  DELETE FROM app.webhook_deliveries d
   WHERE d.forge = frg AND d.installation_id = inst
     AND (d.processed_at IS NOT NULL OR d.parked_at IS NOT NULL
          OR d.event_type NOT LIKE 'installation.%'
          OR jsonb_typeof(d.event -> 'account') IS DISTINCT FROM 'object'
          OR coalesce(jsonb_typeof(d.event -> 'sender'), 'missing') NOT IN ('null', 'object'));
  GET DIAGNOSTICS n_inbox = ROW_COUNT;
  -- The account's finished rows under its earlier installations (before a rebind), unless that
  -- installation belongs to a live org now (a reinstall during this erasure, review round 2 C).
  -- Pending rows of other installations are a reinstall's work and are left alone.
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

  -- The erased installation's remaining (pending, well-formed) rows keep ids only.
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
                                 inbox_rows_deleted, inbox_rows_scrubbed)
  VALUES (org, frg, inst, due, n_audit, n_inbox, n_scrubbed);
  RETURN;
END
$$;

REVOKE ALL ON FUNCTION retention.delete_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention.delete_org(uuid) TO rocky_worker;
GRANT CREATE ON SCHEMA retention TO rocky_retention;
ALTER FUNCTION retention.delete_org(uuid) OWNER TO rocky_retention;
REVOKE CREATE ON SCHEMA retention FROM rocky_retention;

ALTER TABLE app.org_deletions DROP COLUMN IF EXISTS llm_usage_deleted;

-- --- 4. Retention ---------------------------------------------------------------------------------
DELETE FROM app.retention_settings WHERE category = 'llm_usage';
ALTER TABLE app.retention_settings DROP CONSTRAINT IF EXISTS retention_settings_llm_usage_floor;
ALTER TABLE app.retention_settings DROP CONSTRAINT retention_settings_category_check;
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_category_check
  CHECK (category IN ('analyses', 'logs', 'audit', 'org_deletion_grace', 'webhook_deliveries'));

-- --- 3. Grants ------------------------------------------------------------------------------------
DROP POLICY IF EXISTS llm_usage_retention_delete ON llm_usage;
DROP POLICY IF EXISTS llm_usage_retention_select ON llm_usage;
REVOKE ALL ON llm_usage FROM rocky_retention;
REVOKE ALL ON llm_usage FROM rocky_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_usage TO rocky_app;

-- --- 2. Append-only -------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS llm_usage_stamp ON llm_usage;
DROP TRIGGER IF EXISTS llm_usage_no_truncate ON llm_usage;
DROP TRIGGER IF EXISTS llm_usage_no_update_delete ON llm_usage;
DROP FUNCTION IF EXISTS app.llm_usage_stamp();
DROP FUNCTION IF EXISTS app.llm_usage_append_only();

-- --- 1. Columns -----------------------------------------------------------------------------------
DROP INDEX IF EXISTS llm_usage_created_idx;
DROP INDEX IF EXISTS llm_usage_org_analysis_idx;
DELETE FROM llm_usage WHERE input_tokens IS NULL OR cost_micro_usd IS NULL;
ALTER TABLE llm_usage
  DROP CONSTRAINT IF EXISTS llm_usage_call_attempt_unique,
  DROP CONSTRAINT IF EXISTS llm_usage_cost_when_priced,
  DROP CONSTRAINT IF EXISTS llm_usage_no_usage_when_unreported,
  DROP CONSTRAINT IF EXISTS llm_usage_tokens_when_reported,
  DROP CONSTRAINT IF EXISTS llm_usage_cost_status_known,
  DROP CONSTRAINT IF EXISTS llm_usage_partial_is_error,
  DROP CONSTRAINT IF EXISTS llm_usage_usage_status_known,
  DROP CONSTRAINT IF EXISTS llm_usage_error_kind_shape,
  DROP CONSTRAINT IF EXISTS llm_usage_outcome_known,
  DROP CONSTRAINT IF EXISTS llm_usage_price_version_shape,
  DROP CONSTRAINT IF EXISTS llm_usage_model_shape,
  DROP CONSTRAINT IF EXISTS llm_usage_provider_shape,
  DROP CONSTRAINT IF EXISTS llm_usage_role_known,
  DROP CONSTRAINT IF EXISTS llm_usage_attempt_range;
ALTER TABLE llm_usage
  DROP COLUMN IF EXISTS cost_status,
  DROP COLUMN IF EXISTS usage_status,
  DROP COLUMN IF EXISTS error_kind,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS cache_write_1h_tokens,
  DROP COLUMN IF EXISTS attempt,
  DROP COLUMN IF EXISTS call_id,
  ALTER COLUMN input_tokens SET NOT NULL,
  ALTER COLUMN output_tokens SET NOT NULL,
  ALTER COLUMN cache_read_tokens SET NOT NULL,
  ALTER COLUMN cache_read_tokens SET DEFAULT 0,
  ALTER COLUMN cache_write_5m_tokens SET NOT NULL,
  ALTER COLUMN cache_write_5m_tokens SET DEFAULT 0,
  ALTER COLUMN cost_micro_usd SET NOT NULL;
ALTER TABLE llm_usage RENAME COLUMN cache_write_5m_tokens TO cache_write_tokens;
