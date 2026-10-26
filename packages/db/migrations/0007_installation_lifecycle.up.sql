-- 0007 installation lifecycle (P3-3, ADR 0009).
--
-- Install → org, uninstall → deletion after the grace period, reinstall → cancel. Four parts:
--   1. Two new group roles. `rocky_worker` is what the worker logs in through, in addition to
--      `rocky_app`: it alone may create orgs, claim inbox rows and run the deletion sweep. The
--      internet-facing server (a plain `rocky_app` member) can do none of those, so a compromised
--      server can neither plant tenants nor mark an uninstall "processed" to suppress a deletion.
--      `rocky_lifecycle` never logs in; it owns the SECURITY DEFINER functions in schema
--      `worker` (the ADR 0005 template: a dedicated owner per cross-tenant path).
--   2. `orgs` binds by (forge, installation_id) and the immutable forge account id; the account
--      login is display data only (ADR 0007 §4). The installer is kept as a candidate, not a
--      member.
--   3. The inbox gets a processing state (lease, attempts, outcome, parked, last error code) and
--      a claim path with FOR UPDATE SKIP LOCKED; the purge skips unprocessed rows.
--   4. The deletion sweep: list due orgs, erase each through retention.delete_org, which now also
--      removes the org's processed inbox rows and leaves a tombstone in app.org_deletions.

-- --- 1. Roles ----------------------------------------------------------------------------------

-- Same rules as 0001: created if missing, never ALTERed (a non-superuser migrator could not),
-- and a pre-existing role with stronger attributes or memberships aborts the migration.
DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rocky_worker') THEN
    CREATE ROLE rocky_worker INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rocky_lifecycle') THEN
    CREATE ROLE rocky_lifecycle NOINHERIT;
  END IF;

  FOR r IN
    SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
      FROM pg_roles WHERE rolname IN ('rocky_worker', 'rocky_lifecycle')
  LOOP
    IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolcanlogin THEN
      RAISE EXCEPTION 'role % must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOLOGIN; fix it before migrating', r.rolname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = r.rolname)) THEN
      RAISE EXCEPTION 'role % must not be a member of any other role', r.rolname;
    END IF;
  END LOOP;

  -- The migrator hands the worker functions to rocky_lifecycle (ALTER FUNCTION … OWNER TO), for
  -- which it needs SET on the role, never INHERIT.
  IF NOT pg_has_role(current_user, 'rocky_lifecycle', 'SET') THEN
    EXECUTE format('GRANT rocky_lifecycle TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO rocky_lifecycle;

-- --- 2. Orgs: bind by installation and account id -------------------------------------------

-- The forge's immutable account id (an org or a user). One org per account per forge: a
-- reinstall within the grace period rebinds the existing org instead of creating a second one.
-- NOT NULL without a default: no org can exist yet (only the worker creates them, from here on).
ALTER TABLE orgs ADD COLUMN account_id bigint NOT NULL CHECK (account_id > 0);
-- Who installed the app, as reported by the (untrusted) webhook sender. A candidate for the
-- first admin only: P7-1 must verify it on the forge before granting anything. Nullable: the
-- forge does not always say (ADR 0007, `sender: null`).
ALTER TABLE orgs ADD COLUMN installer_forge_user_id bigint CHECK (installer_forge_user_id > 0);
ALTER TABLE orgs ADD CONSTRAINT orgs_forge_account_unique UNIQUE (forge, account_id);
ALTER TABLE orgs ADD CONSTRAINT orgs_installation_id_positive CHECK (installation_id > 0);

-- Identity is not editable data. `id`, `forge` and `account_id` never change; `installation_id`
-- changes only when the worker rebinds an org to a reinstallation of the same account. A plain
-- application login (the server) cannot rebind an org to someone else's installation.
CREATE FUNCTION app.orgs_guard_identity() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.forge IS DISTINCT FROM OLD.forge
     OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'orgs: id, forge and account_id are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.installation_id IS DISTINCT FROM OLD.installation_id
     AND NOT pg_has_role(current_user, 'rocky_worker', 'USAGE') THEN
    RAISE EXCEPTION 'orgs: only the worker rebinds an installation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER orgs_guard_identity
  BEFORE UPDATE ON orgs
  FOR EACH ROW EXECUTE FUNCTION app.orgs_guard_identity();

-- Only the worker creates orgs (inside withOrg(newId), so the tenant policy still checks the
-- row). The server keeps SELECT/UPDATE for its own tenant.
REVOKE INSERT ON orgs FROM rocky_app;
GRANT INSERT ON orgs TO rocky_worker;
CREATE POLICY orgs_worker_insert ON orgs FOR INSERT TO rocky_worker
  WITH CHECK (id = app.current_org_id());

-- --- 3. Inbox processing state ------------------------------------------------------------

-- `lease_token`/`lease_until`: held by one worker while it processes the row; an expired lease
-- (a crash) makes the row claimable again. `attempts` counts claims; after WEBHOOK_MAX_ATTEMPTS
-- (5, worker.* below) the row is parked for a human. `last_error` is a SQLSTATE or a fixed
-- reason code, never a message. `outcome` is a fixed code recorded when processed.
ALTER TABLE app.webhook_deliveries
  ADD COLUMN attempts      integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN available_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_token   uuid,
  ADD COLUMN lease_until   timestamptz,
  ADD COLUMN processed_at  timestamptz,
  ADD COLUMN outcome       text CHECK (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD COLUMN parked_at     timestamptz,
  ADD COLUMN last_error    text CHECK (last_error ~ '^(?:[0-9A-Z]{5}|[a-z][a-z0-9_]{0,63})$'),
  ADD CONSTRAINT webhook_deliveries_lease_pair CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  ADD CONSTRAINT webhook_deliveries_outcome_when_processed CHECK ((processed_at IS NULL) = (outcome IS NULL)),
  ADD CONSTRAINT webhook_deliveries_processed_or_parked CHECK (processed_at IS NULL OR parked_at IS NULL);

CREATE INDEX webhook_deliveries_pending_idx ON app.webhook_deliveries (received_at)
  WHERE processed_at IS NULL AND parked_at IS NULL;

-- The receiver (INSERT only) cannot pre-set any processing state: a row always starts pending.
CREATE OR REPLACE FUNCTION app.webhook_deliveries_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.received_at := now();
  NEW.available_at := now();
  NEW.attempts := 0;
  NEW.lease_token := NULL;
  NEW.lease_until := NULL;
  NEW.processed_at := NULL;
  NEW.outcome := NULL;
  NEW.parked_at := NULL;
  NEW.last_error := NULL;
  RETURN NEW;
END
$$;

GRANT SELECT, UPDATE ON app.webhook_deliveries TO rocky_lifecycle;
CREATE POLICY webhook_deliveries_lifecycle_select ON app.webhook_deliveries
  FOR SELECT TO rocky_lifecycle USING (true);
CREATE POLICY webhook_deliveries_lifecycle_update ON app.webhook_deliveries
  FOR UPDATE TO rocky_lifecycle USING (true) WITH CHECK (true);
-- The installation lookup reads orgs across tenants (ids and the grace deadline only).
GRANT SELECT ON orgs TO rocky_lifecycle;
CREATE POLICY orgs_lifecycle_select ON orgs FOR SELECT TO rocky_lifecycle USING (true);

CREATE SCHEMA worker;

-- Claims up to p_limit pending rows of the given event types for p_lease_seconds (clamped to
-- 1..100 rows and 5..3600 s). FOR UPDATE SKIP LOCKED: concurrent workers never get the same row.
-- A row whose lease expired is claimable again (the holder crashed); a row that was claimed
-- WEBHOOK_MAX_ATTEMPTS times without finishing is parked here instead of being handed out again.
CREATE FUNCTION worker.claim_webhook_deliveries(
    p_event_types text[], p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (forge text, delivery_id text, event_type text, installation_id bigint,
                 event jsonb, attempts integer, lease_token uuid)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH candidates AS (
    SELECT d.forge, d.delivery_id, d.attempts AS tries, d.lease_token IS NOT NULL AS was_leased
      FROM app.webhook_deliveries d
     WHERE d.processed_at IS NULL AND d.parked_at IS NULL
       AND d.available_at <= now()
       AND (d.lease_until IS NULL OR d.lease_until <= now())
       AND d.event_type = ANY (p_event_types)
     ORDER BY d.received_at, d.delivery_id
     LIMIT least(greatest(coalesce(p_limit, 1), 1), 100)
       FOR UPDATE OF d SKIP LOCKED
  ),
  exhausted AS (
    UPDATE app.webhook_deliveries d
       SET parked_at = now(), lease_token = NULL, lease_until = NULL, last_error = 'lease_expired'
      FROM candidates c
     WHERE d.forge = c.forge AND d.delivery_id = c.delivery_id AND c.tries >= 5
    RETURNING 1
  ),
  claimed AS (
    UPDATE app.webhook_deliveries d
       SET attempts = d.attempts + 1,
           lease_token = gen_random_uuid(),
           lease_until = now() + make_interval(
             secs => least(greatest(coalesce(p_lease_seconds, 300), 5), 3600)),
           last_error = CASE WHEN c.was_leased THEN 'lease_expired' ELSE d.last_error END
      FROM candidates c
     WHERE d.forge = c.forge AND d.delivery_id = c.delivery_id AND c.tries < 5
    RETURNING d.forge, d.delivery_id, d.event_type, d.installation_id, d.event, d.attempts,
              d.lease_token, d.received_at
  )
  SELECT c.forge, c.delivery_id, c.event_type, c.installation_id, c.event, c.attempts, c.lease_token
    FROM claimed c ORDER BY c.received_at, c.delivery_id
$$;

-- Marks a claimed row processed with a fixed outcome code. Only the current lease holder can:
-- after a lease expired and another worker claimed the row, the old token matches nothing and
-- this returns false. Called inside the tenant transaction that applied the effect, so the
-- effect and the "processed" mark commit together or not at all.
CREATE FUNCTION worker.complete_webhook_delivery(
    p_forge text, p_delivery_id text, p_lease_token uuid, p_outcome text)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH done AS (
    UPDATE app.webhook_deliveries d
       SET processed_at = now(), outcome = p_outcome, lease_token = NULL, lease_until = NULL
     WHERE d.forge = p_forge AND d.delivery_id = p_delivery_id
       AND d.lease_token = p_lease_token
       AND d.processed_at IS NULL AND d.parked_at IS NULL
    RETURNING 1
  )
  SELECT count(*) = 1 FROM done
$$;

-- Records a failed attempt (an error code, never a message) and releases the lease. The row is
-- retried after p_retry_after_seconds (0..86400), or parked when p_permanent or when it has
-- used its WEBHOOK_MAX_ATTEMPTS. Returns 'retry', 'parked', or 'stale' for a lease that is no
-- longer held.
CREATE FUNCTION worker.fail_webhook_delivery(
    p_forge text, p_delivery_id text, p_lease_token uuid, p_error text,
    p_retry_after_seconds integer, p_permanent boolean)
  RETURNS text
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH failed AS (
    UPDATE app.webhook_deliveries d
       SET last_error = p_error,
           lease_token = NULL,
           lease_until = NULL,
           parked_at = CASE WHEN coalesce(p_permanent, false) OR d.attempts >= 5 THEN now() END,
           available_at = now() + make_interval(
             secs => least(greatest(coalesce(p_retry_after_seconds, 0), 0), 86400))
     WHERE d.forge = p_forge AND d.delivery_id = p_delivery_id
       AND d.lease_token = p_lease_token
       AND d.processed_at IS NULL AND d.parked_at IS NULL
    RETURNING d.parked_at
  )
  SELECT coalesce((SELECT CASE WHEN f.parked_at IS NULL THEN 'retry' ELSE 'parked' END FROM failed f),
                  'stale')
$$;

-- The orgs bound to an installation, or to the account (a reinstall gets a new installation id).
-- Ids and the deletion deadline only. p_account_id NULL → by installation only.
CREATE FUNCTION worker.installation_orgs(
    p_forge text, p_installation_id bigint, p_account_id bigint)
  RETURNS TABLE (org_id uuid, installation_id bigint, account_id bigint, delete_after timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT o.id, o.installation_id, o.account_id, o.delete_after
    FROM public.orgs o
   WHERE o.forge = p_forge
     AND (o.installation_id = p_installation_id OR o.account_id = p_account_id)
   ORDER BY o.id
$$;

REVOKE ALL ON FUNCTION worker.claim_webhook_deliveries(text[], integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker.complete_webhook_delivery(text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker.fail_webhook_delivery(text, text, uuid, text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker.installation_orgs(text, bigint, bigint) FROM PUBLIC;

GRANT USAGE ON SCHEMA worker TO rocky_worker;
GRANT EXECUTE ON FUNCTION worker.claim_webhook_deliveries(text[], integer, integer) TO rocky_worker;
GRANT EXECUTE ON FUNCTION worker.complete_webhook_delivery(text, text, uuid, text) TO rocky_worker;
GRANT EXECUTE ON FUNCTION worker.fail_webhook_delivery(text, text, uuid, text, integer, boolean) TO rocky_worker;
GRANT EXECUTE ON FUNCTION worker.installation_orgs(text, bigint, bigint) TO rocky_worker;

GRANT CREATE ON SCHEMA worker TO rocky_lifecycle;
ALTER FUNCTION worker.claim_webhook_deliveries(text[], integer, integer) OWNER TO rocky_lifecycle;
ALTER FUNCTION worker.complete_webhook_delivery(text, text, uuid, text) OWNER TO rocky_lifecycle;
ALTER FUNCTION worker.fail_webhook_delivery(text, text, uuid, text, integer, boolean) OWNER TO rocky_lifecycle;
ALTER FUNCTION worker.installation_orgs(text, bigint, bigint) OWNER TO rocky_lifecycle;
REVOKE CREATE ON SCHEMA worker FROM rocky_lifecycle;

-- --- 4. Retention: purge only processed rows; the deletion sweep -----------------------------

-- Erasure evidence: one row per erased org, ids and counts only (no login, no account id: the
-- account of a personal installation is a person). Written only by retention.delete_org, in the
-- same transaction as the erasure. Kept: it holds no personal data and proves the erasure ran.
CREATE TABLE app.org_deletions (
  org_id                uuid        PRIMARY KEY,
  forge                 text        NOT NULL,
  installation_id       bigint      NOT NULL,
  was_due               timestamptz NOT NULL,
  deleted_at            timestamptz NOT NULL DEFAULT now(),
  audit_events_deleted  bigint      NOT NULL CHECK (audit_events_deleted >= 0),
  inbox_rows_deleted    bigint      NOT NULL CHECK (inbox_rows_deleted >= 0)
);

-- Append-only like audit_events (0004): nobody updates it; only rocky_retention may delete.
CREATE FUNCTION app.org_deletions_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'rocky_retention' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'org_deletions is append-only: % blocked for role %', TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER org_deletions_no_update_delete
  BEFORE UPDATE OR DELETE ON app.org_deletions
  FOR EACH ROW EXECUTE FUNCTION app.org_deletions_append_only();
CREATE TRIGGER org_deletions_no_truncate
  BEFORE TRUNCATE ON app.org_deletions
  FOR EACH STATEMENT EXECUTE FUNCTION app.org_deletions_append_only();

CREATE FUNCTION app.org_deletions_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.deleted_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER org_deletions_stamp
  BEFORE INSERT ON app.org_deletions
  FOR EACH ROW EXECUTE FUNCTION app.org_deletions_stamp();

ALTER TABLE app.org_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.org_deletions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.org_deletions TO rocky_retention;
CREATE POLICY org_deletions_retention_select ON app.org_deletions
  FOR SELECT TO rocky_retention USING (true);
CREATE POLICY org_deletions_retention_insert ON app.org_deletions
  FOR INSERT TO rocky_retention WITH CHECK (true);

-- delete_org and purge_webhook_deliveries are replaced. They are owned by rocky_retention, which
-- has no language to recreate them with, so the owner drops them (USAGE on the schema only for
-- that) and the migrator creates the new versions and hands them over (the 0005 pattern).
GRANT USAGE ON SCHEMA retention TO rocky_retention;
SET LOCAL ROLE rocky_retention;
DROP FUNCTION retention.delete_org(uuid);
DROP FUNCTION retention.purge_webhook_deliveries(timestamptz);
RESET ROLE;
REVOKE USAGE ON SCHEMA retention FROM rocky_retention;

-- Unchanged contract (0006), except that only processed rows are purged: a row that is pending,
-- leased or parked is work not yet done (an uninstall must never be lost to retention).
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
    DELETE FROM app.webhook_deliveries d USING cutoff c
     WHERE d.processed_at IS NOT NULL AND d.received_at < c.before
    RETURNING 1
  )
  SELECT count(*) FROM removed
$$;

-- 0005's erasure plus: the org's finished inbox rows (by installation or account id; pending rows
-- stay, a reinstall's `created` among them) and a tombstone in app.org_deletions. The FOR UPDATE
-- lock and the order of deletes are unchanged (see 0005).
CREATE FUNCTION retention.delete_org(org uuid)
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  due timestamptz;
  inst bigint;
  acct bigint;
  frg text;
  n_audit bigint;
  n_orgs bigint;
  n_inbox bigint;
BEGIN
  SELECT o.delete_after, o.installation_id, o.account_id, o.forge
    INTO due, inst, acct, frg
    FROM public.orgs o WHERE o.id = org FOR UPDATE;
  IF NOT FOUND OR due IS NULL THEN
    RAISE EXCEPTION 'org % is not scheduled for deletion', org
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF due > now() THEN
    RAISE EXCEPTION 'org % is inside its deletion grace period until %', org, due
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.audit_events e WHERE e.org_id = org;
  GET DIAGNOSTICS n_audit = ROW_COUNT;
  table_name := 'audit_events'; deleted := n_audit; RETURN NEXT;

  DELETE FROM public.orgs o WHERE o.id = org;
  GET DIAGNOSTICS n_orgs = ROW_COUNT;
  table_name := 'orgs'; deleted := n_orgs; RETURN NEXT;

  DELETE FROM app.webhook_deliveries d
   WHERE d.forge = frg
     AND (d.processed_at IS NOT NULL OR d.parked_at IS NOT NULL)
     AND (d.installation_id = inst OR (d.event -> 'account' ->> 'id') = acct::text);
  GET DIAGNOSTICS n_inbox = ROW_COUNT;
  table_name := 'webhook_deliveries'; deleted := n_inbox; RETURN NEXT;

  INSERT INTO app.org_deletions (org_id, forge, installation_id, was_due, audit_events_deleted, inbox_rows_deleted)
  VALUES (org, frg, inst, due, n_audit, n_inbox);
  RETURN;
END
$$;

-- Orgs whose grace period has elapsed, by the database clock, oldest first (1..100 per call).
CREATE FUNCTION retention.orgs_due_for_deletion(p_limit integer)
  RETURNS TABLE (org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT o.id FROM public.orgs o
   WHERE o.delete_after IS NOT NULL AND o.delete_after <= now()
   ORDER BY o.delete_after, o.id
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 100)
$$;

REVOKE ALL ON FUNCTION retention.purge_webhook_deliveries(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retention.delete_org(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION retention.orgs_due_for_deletion(integer) FROM PUBLIC;
-- The purge stays with the application role (period-bounded, like the 0005 purges). Erasure and
-- the due list move to the worker: the server never needs them.
GRANT EXECUTE ON FUNCTION retention.purge_webhook_deliveries(timestamptz) TO rocky_app;
GRANT USAGE ON SCHEMA retention TO rocky_worker;
GRANT EXECUTE ON FUNCTION retention.delete_org(uuid) TO rocky_worker;
GRANT EXECUTE ON FUNCTION retention.orgs_due_for_deletion(integer) TO rocky_worker;

GRANT CREATE ON SCHEMA retention TO rocky_retention;
ALTER FUNCTION retention.purge_webhook_deliveries(timestamptz) OWNER TO rocky_retention;
ALTER FUNCTION retention.delete_org(uuid) OWNER TO rocky_retention;
ALTER FUNCTION retention.orgs_due_for_deletion(integer) OWNER TO rocky_retention;
REVOKE CREATE ON SCHEMA retention FROM rocky_retention;
