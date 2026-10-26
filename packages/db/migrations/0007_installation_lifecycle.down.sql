-- Reverts 0007. Roles are cluster-level and stay (ADR 0005); every grant to them is removed.

-- --- 4. Retention: back to the 0005/0006 functions --------------------------------------------
GRANT USAGE ON SCHEMA retention TO rocky_retention;
SET LOCAL ROLE rocky_retention;
DROP FUNCTION IF EXISTS retention.orgs_due_for_deletion(integer);
DROP FUNCTION IF EXISTS retention.delete_org(uuid);
DROP FUNCTION IF EXISTS retention.purge_webhook_deliveries(timestamptz);
RESET ROLE;
REVOKE USAGE ON SCHEMA retention FROM rocky_retention;
REVOKE USAGE ON SCHEMA retention FROM rocky_worker;

CREATE FUNCTION retention.purge_webhook_deliveries(as_of timestamptz DEFAULT now())
  RETURNS bigint
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH cutoff AS (
    SELECT least(as_of, now()) - make_interval(days => s.days) AS before
      FROM app.retention_settings s WHERE s.category = 'webhook_deliveries'
  ),
  removed AS (
    DELETE FROM app.webhook_deliveries d USING cutoff c WHERE d.received_at < c.before RETURNING 1
  )
  SELECT count(*) FROM removed
$$;

CREATE FUNCTION retention.delete_org(org uuid)
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  due timestamptz;
  n bigint;
BEGIN
  SELECT o.delete_after INTO due FROM public.orgs o WHERE o.id = org FOR UPDATE;
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

REVOKE ALL ON FUNCTION retention.purge_webhook_deliveries(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retention.delete_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention.purge_webhook_deliveries(timestamptz) TO rocky_app;
GRANT EXECUTE ON FUNCTION retention.delete_org(uuid) TO rocky_app;
GRANT CREATE ON SCHEMA retention TO rocky_retention;
ALTER FUNCTION retention.purge_webhook_deliveries(timestamptz) OWNER TO rocky_retention;
ALTER FUNCTION retention.delete_org(uuid) OWNER TO rocky_retention;
REVOKE CREATE ON SCHEMA retention FROM rocky_retention;

DROP POLICY IF EXISTS webhook_deliveries_retention_update ON app.webhook_deliveries;
REVOKE UPDATE ON app.webhook_deliveries FROM rocky_retention;

DROP TABLE IF EXISTS app.org_deletions;
DROP FUNCTION IF EXISTS app.org_deletions_stamp();
DROP FUNCTION IF EXISTS app.org_deletions_append_only();

-- --- 3. Inbox processing state ------------------------------------------------------------
GRANT USAGE ON SCHEMA worker TO rocky_lifecycle;
SET LOCAL ROLE rocky_lifecycle;
DROP FUNCTION IF EXISTS worker.installation_orgs(text, bigint, bigint);
DROP FUNCTION IF EXISTS worker.fail_webhook_delivery(text, text, uuid, text, integer, text);
DROP FUNCTION IF EXISTS worker.complete_webhook_delivery(text, text, uuid, text);
DROP FUNCTION IF EXISTS worker.claim_webhook_deliveries(text, text[], integer, integer);
RESET ROLE;
DROP SCHEMA IF EXISTS worker;

DROP POLICY IF EXISTS orgs_lifecycle_select ON orgs;
DROP POLICY IF EXISTS webhook_deliveries_lifecycle_update ON app.webhook_deliveries;
DROP POLICY IF EXISTS webhook_deliveries_lifecycle_select ON app.webhook_deliveries;
REVOKE ALL ON orgs FROM rocky_lifecycle;
REVOKE ALL ON app.webhook_deliveries FROM rocky_lifecycle;

CREATE OR REPLACE FUNCTION app.webhook_deliveries_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.received_at := now();
  RETURN NEW;
END
$$;

DROP INDEX IF EXISTS app.webhook_deliveries_pending_idx;
ALTER TABLE app.webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_processed_or_parked,
  DROP CONSTRAINT IF EXISTS webhook_deliveries_outcome_when_processed,
  DROP CONSTRAINT IF EXISTS webhook_deliveries_lease_pair,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS parked_at,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS processed_at,
  DROP COLUMN IF EXISTS lease_until,
  DROP COLUMN IF EXISTS lease_token,
  DROP COLUMN IF EXISTS available_at,
  DROP COLUMN IF EXISTS strikes,
  DROP COLUMN IF EXISTS attempts;

-- --- 2. Orgs ----------------------------------------------------------------------------------
DROP POLICY IF EXISTS orgs_worker_insert ON orgs;
REVOKE UPDATE (installation_id, login, kind, delete_after, installer_forge_user_id, erasing_at,
               updated_at) ON orgs FROM rocky_worker;
REVOKE ALL ON orgs FROM rocky_worker;
REVOKE UPDATE (settings, data_key_ciphertext, data_key_version, llm_api_key_ciphertext,
               llm_api_key_version, updated_at) ON orgs FROM rocky_app;
GRANT INSERT, UPDATE ON orgs TO rocky_app;

-- The 0005 clamp (lower bound only).
CREATE OR REPLACE FUNCTION app.orgs_enforce_deletion_grace() RETURNS trigger
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

DROP TRIGGER IF EXISTS orgs_guard_identity ON orgs;
DROP FUNCTION IF EXISTS app.orgs_guard_identity();
DROP INDEX IF EXISTS orgs_forge_account_live_unique;
DROP INDEX IF EXISTS orgs_forge_installation_live_unique;
ALTER TABLE orgs ADD CONSTRAINT orgs_forge_installation_unique UNIQUE (forge, installation_id);
ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_erasing_when_scheduled;
ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_delete_after_finite;
ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_installation_id_positive;
ALTER TABLE orgs DROP COLUMN IF EXISTS erasing_at;
ALTER TABLE orgs DROP COLUMN IF EXISTS installer_forge_user_id;
ALTER TABLE orgs DROP COLUMN IF EXISTS account_id;

-- --- 1. Roles ----------------------------------------------------------------------------------
REVOKE USAGE ON SCHEMA public, app FROM rocky_lifecycle;
