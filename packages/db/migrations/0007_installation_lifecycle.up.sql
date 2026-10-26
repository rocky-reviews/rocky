-- 0007 installation lifecycle (P3-3, ADR 0009).
--
-- Install → org, uninstall → deletion after the grace period, reinstall → cancel. Four parts:
--   1. Two new group roles. `rocky_worker` is what the worker logs in through, in addition to
--      `rocky_app`: it alone may create orgs, schedule, cancel or start an org's erasure, rebind
--      an installation, claim inbox rows and run the deletion sweep. The internet-facing server
--      (a plain `rocky_app` member) can do none of those: on `orgs` it may only update settings
--      and the encrypted key columns (column-level grants, plus a trigger as a second fence). So
--      a compromised server can neither plant tenants, nor schedule, postpone or cancel an
--      erasure, nor mark an uninstall "processed" to suppress it. `rocky_lifecycle` never logs
--      in; it owns the SECURITY DEFINER functions in schema `worker` (ADR 0005 template).
--   2. `orgs` binds by (forge, installation_id) and the immutable forge account id; the login is
--      display data only (ADR 0007 §4). The installer is a candidate, not a member.
--      `delete_after` is NULL or inside [now() + grace, now() + grace + 1 h] when written, never
--      infinite. `erasing_at` marks an erasure in progress: from then on the org can no longer be
--      cancelled or rebound, and a reinstall gets a fresh org.
--   3. The inbox gets a processing state (lease, attempts, strikes, outcome, parked, last error
--      code), installation rows must have the decodable shape (CHECK), and a claim path per
--      forge: one claim at a time (advisory lock), one live lease per installation, oldest first,
--      no row finished by anyone but its lease holder, transient errors that do not exhaust the
--      budget; the purge skips unprocessed rows.
--   4. The deletion sweep: list due orgs, erase each through retention.delete_org, which now also
--      removes the erased installation's inbox rows (or scrubs the ones still pending), the
--      account's finished rows under installations no live org holds, and leaves a tombstone in
--      app.org_deletions. Rows of a reinstall (another installation) are never touched.

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


-- --- 2. Orgs: bind by installation and account id; the schedule is the worker's --------------

-- The forge's immutable account id (an org or a user). NOT NULL without a default: no org can
-- exist yet (only the worker creates them, from here on).
ALTER TABLE orgs ADD COLUMN account_id bigint NOT NULL CHECK (account_id > 0);
-- Who installed the app, as reported by the (untrusted) webhook sender. A candidate for the
-- first admin only: P7-1 must verify it on the forge before granting anything.
ALTER TABLE orgs ADD COLUMN installer_forge_user_id bigint CHECK (installer_forge_user_id > 0);
-- Set by the deletion sweep under the row lock before it erases anything (external stores first,
-- then retention.delete_org). An erasing org is past the point of no return.
ALTER TABLE orgs ADD COLUMN erasing_at timestamptz;
ALTER TABLE orgs ADD CONSTRAINT orgs_installation_id_positive CHECK (installation_id > 0);
ALTER TABLE orgs ADD CONSTRAINT orgs_delete_after_finite
  CHECK (delete_after IS NULL OR isfinite(delete_after));
ALTER TABLE orgs ADD CONSTRAINT orgs_erasing_when_scheduled
  CHECK (erasing_at IS NULL OR delete_after IS NOT NULL);
-- One live org per installation and per account. An org being erased no longer counts, so a
-- reinstall that arrives during the erasure gets a fresh org instead of the dying one.
ALTER TABLE orgs DROP CONSTRAINT orgs_forge_installation_unique;
CREATE UNIQUE INDEX orgs_forge_installation_live_unique ON orgs (forge, installation_id)
  WHERE erasing_at IS NULL;
CREATE UNIQUE INDEX orgs_forge_account_live_unique ON orgs (forge, account_id)
  WHERE erasing_at IS NULL;

-- Identity and lifecycle columns, for every role. `id`, `forge`, `account_id` never change. The
-- lifecycle columns (installation, schedule, erasure, installer, display login/kind) change only
-- for members of rocky_worker (the column grants below already say so; this is the second
-- fence). An erasing org can no longer be cancelled, rescheduled or rebound.
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
  IF (NEW.installation_id IS DISTINCT FROM OLD.installation_id
      OR NEW.delete_after IS DISTINCT FROM OLD.delete_after
      OR NEW.erasing_at IS DISTINCT FROM OLD.erasing_at
      OR NEW.installer_forge_user_id IS DISTINCT FROM OLD.installer_forge_user_id
      OR NEW.login IS DISTINCT FROM OLD.login
      OR NEW.kind IS DISTINCT FROM OLD.kind)
     AND NOT pg_has_role(current_user, 'rocky_worker', 'USAGE') THEN
    RAISE EXCEPTION 'orgs: the installation lifecycle columns belong to the worker'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.erasing_at IS NOT NULL
     AND (NEW.erasing_at IS DISTINCT FROM OLD.erasing_at
          OR NEW.delete_after IS DISTINCT FROM OLD.delete_after
          OR NEW.installation_id IS DISTINCT FROM OLD.installation_id) THEN
    RAISE EXCEPTION 'orgs: the org is being erased'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.erasing_at IS NULL AND NEW.erasing_at IS NOT NULL
     AND (NEW.delete_after IS NULL OR NEW.delete_after > now()) THEN
    RAISE EXCEPTION 'orgs: an erasure starts only once the grace period is over'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER orgs_guard_identity
  BEFORE UPDATE ON orgs
  FOR EACH ROW EXECUTE FUNCTION app.orgs_guard_identity();

-- The 0005 clamp, bounded at both ends: a written delete_after is pushed to at least now() +
-- grace, and refused when it is infinite or later than now() + grace + 1 h (a far-future date
-- would postpone an erasure forever and make the genuine uninstall look "already scheduled").
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
    IF NOT isfinite(NEW.delete_after)
       OR NEW.delete_after > now() + make_interval(days => grace) + interval '1 hour' THEN
      RAISE EXCEPTION 'orgs: delete_after must be within the deletion grace window'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.delete_after := greatest(NEW.delete_after, now() + make_interval(days => grace));
  END IF;
  RETURN NEW;
END
$$;

-- Only the worker creates orgs (inside withOrg(newId), so the tenant policy still checks the
-- row) and only it writes the lifecycle columns. The server keeps SELECT, and UPDATE on the
-- columns it writes (settings, the wrapped data key and the BYOK key, updated_at).
REVOKE INSERT, UPDATE ON orgs FROM rocky_app;
GRANT UPDATE (settings, data_key_ciphertext, data_key_version, llm_api_key_ciphertext,
              llm_api_key_version, updated_at) ON orgs TO rocky_app;
GRANT INSERT ON orgs TO rocky_worker;
GRANT UPDATE (installation_id, login, kind, delete_after, installer_forge_user_id, erasing_at,
              updated_at) ON orgs TO rocky_worker;
CREATE POLICY orgs_worker_insert ON orgs FOR INSERT TO rocky_worker
  WITH CHECK (id = app.current_org_id());

-- --- 3. Inbox processing state ------------------------------------------------------------

-- `lease_token`/`lease_until`: held by one worker while it processes the row; an expired lease
-- (a crash) makes the row claimable again. `attempts` counts claims. `strikes` counts failures
-- that say something about the row (a lost lease, a contradiction, a bad answer); after
-- WEBHOOK_MAX_STRIKES (5) the row is parked. Transient failures (the forge is down) do not
-- strike: the row is parked only once it is 72 h old. `last_error` is a SQLSTATE or a fixed
-- reason code, never a message. `outcome` is a fixed code recorded when processed.
ALTER TABLE app.webhook_deliveries
  ADD COLUMN attempts      integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN strikes       integer     NOT NULL DEFAULT 0 CHECK (strikes >= 0),
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

-- Review round 2 (A): an installation row must have the shape `minimalEvent` (packages/db)
-- accepts, for every role: `account` an object with a positive safe-integer `id`, a login and a
-- known kind; `sender` present and either null or an object with a positive safe-integer `id` and
-- an actor login. The receiver only ever stores such rows, so a row without them was planted by
-- whoever holds the receiver's credential; the worker could not decode it anyway, and a stored
-- shape the erasure's scrub can rely on (CASE: evaluated in order, so no cast ever fails).
ALTER TABLE app.webhook_deliveries ADD CONSTRAINT webhook_deliveries_installation_shape CHECK (
  event_type NOT LIKE 'installation.%' OR CASE
    WHEN jsonb_typeof(event -> 'account') IS DISTINCT FROM 'object' THEN false
    WHEN jsonb_typeof(event #> '{account,id}') IS DISTINCT FROM 'number' THEN false
    WHEN (event #>> '{account,id}') !~ '^[1-9][0-9]{0,15}$' THEN false
    WHEN (event #>> '{account,id}')::numeric > 9007199254740991 THEN false
    WHEN jsonb_typeof(event #> '{account,login}') IS DISTINCT FROM 'string' THEN false
    WHEN (event #>> '{account,login}') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$' THEN false
    WHEN jsonb_typeof(event #> '{account,kind}') IS DISTINCT FROM 'string' THEN false
    WHEN (event #>> '{account,kind}') NOT IN ('organization', 'user') THEN false
    WHEN jsonb_typeof(event -> 'sender') = 'null' THEN true
    WHEN jsonb_typeof(event -> 'sender') IS DISTINCT FROM 'object' THEN false
    WHEN jsonb_typeof(event #> '{sender,id}') IS DISTINCT FROM 'number' THEN false
    WHEN (event #>> '{sender,id}') !~ '^[1-9][0-9]{0,15}$' THEN false
    WHEN (event #>> '{sender,id}')::numeric > 9007199254740991 THEN false
    WHEN jsonb_typeof(event #> '{sender,login}') IS DISTINCT FROM 'string' THEN false
    ELSE (event #>> '{sender,login}') ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(\[bot\])?$'
  END);

CREATE INDEX webhook_deliveries_pending_idx ON app.webhook_deliveries (forge, installation_id, received_at)
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
  NEW.strikes := 0;
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

-- Claims up to p_limit pending rows of one forge and the given event types, for p_lease_seconds
-- (clamped to 1..100 rows and 5..3600 s). In order:
--   * one claim at a time across workers (transaction advisory lock), so the per-installation
--     rule below cannot race;
--   * nothing is marked processed here: a row is only ever finished by its own lease holder
--     (review round 2: superseding one row because of another let a planted row swallow a
--     genuine uninstall; duplicates are cheap, they are processed one at a time);
--   * expired leases (the holder crashed) are released with a strike; the fifth parks the row;
--   * per installation only the oldest pending row is a candidate, and only when nothing of that
--     installation is leased: events of one installation are processed one at a time, in order.
CREATE FUNCTION worker.claim_webhook_deliveries(
    p_forge text, p_event_types text[], p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (forge text, delivery_id text, event_type text, installation_id bigint,
                 event jsonb, attempts integer, strikes integer, lease_token uuid,
                 lease_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rocky.worker.claim_webhook_deliveries', 0));

  UPDATE app.webhook_deliveries d
     SET strikes = d.strikes + 1,
         last_error = 'lease_expired',
         lease_token = NULL,
         lease_until = NULL,
         parked_at = CASE WHEN d.strikes + 1 >= 5 THEN now() END
   WHERE d.forge = p_forge AND d.event_type = ANY (p_event_types)
     AND d.processed_at IS NULL AND d.parked_at IS NULL
     AND d.lease_token IS NOT NULL AND d.lease_until <= now();

  RETURN QUERY
  WITH pending AS (
    SELECT d.delivery_id, d.installation_id, d.received_at, d.available_at, d.lease_token
      FROM app.webhook_deliveries d
     WHERE d.forge = p_forge AND d.event_type = ANY (p_event_types)
       AND d.processed_at IS NULL AND d.parked_at IS NULL
  ),
  heads AS (
    SELECT DISTINCT ON (p.installation_id) p.delivery_id, p.received_at, p.available_at
      FROM pending p
     WHERE NOT EXISTS (SELECT 1 FROM pending l
                        WHERE l.installation_id = p.installation_id AND l.lease_token IS NOT NULL)
     ORDER BY p.installation_id, p.received_at, p.delivery_id
  ),
  picked AS (
    SELECT d.delivery_id
      FROM app.webhook_deliveries d JOIN heads h ON h.delivery_id = d.delivery_id
     WHERE d.forge = p_forge AND h.available_at <= now()
     ORDER BY h.received_at, h.delivery_id
     LIMIT least(greatest(coalesce(p_limit, 1), 1), 100)
       FOR UPDATE OF d SKIP LOCKED
  ),
  claimed AS (
    UPDATE app.webhook_deliveries d
       SET attempts = d.attempts + 1,
           lease_token = gen_random_uuid(),
           lease_until = now() + make_interval(
             secs => least(greatest(coalesce(p_lease_seconds, 300), 5), 3600))
      FROM picked p
     WHERE d.forge = p_forge AND d.delivery_id = p.delivery_id
    RETURNING d.forge, d.delivery_id, d.event_type, d.installation_id, d.event, d.attempts,
              d.strikes, d.lease_token, d.lease_until, d.received_at
  )
  SELECT c.forge, c.delivery_id, c.event_type, c.installation_id, c.event, c.attempts,
         c.strikes, c.lease_token, c.lease_until
    FROM claimed c ORDER BY c.received_at, c.delivery_id;
END
$$;

-- Marks a claimed row processed with a fixed outcome code. Only the current lease holder can:
-- after a lease expired the old token matches nothing and this returns false. Called inside the
-- tenant transaction that applied the effect, so effect and mark commit together or not at all.
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

-- Records a failed attempt (an error code, never a message), releases the lease and sets the
-- retry delay (0..86400 s). p_kind:
--   'transient' — the forge or the database is unavailable: no strike; parked only once the row
--                 is 72 h old (an outage must not park every row);
--   'strike'    — the row itself is suspect (contradiction, bad answer): parked at 5 strikes;
--   'permanent' — it can never succeed: parked now. Anything else parks too (fail closed).
-- Returns 'retry', 'parked', or 'stale' for a lease that is no longer held.
CREATE FUNCTION worker.fail_webhook_delivery(
    p_forge text, p_delivery_id text, p_lease_token uuid, p_error text,
    p_retry_after_seconds integer, p_kind text)
  RETURNS text
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  WITH failed AS (
    UPDATE app.webhook_deliveries d
       SET last_error = p_error,
           lease_token = NULL,
           lease_until = NULL,
           strikes = d.strikes + CASE WHEN p_kind = 'strike' THEN 1 ELSE 0 END,
           parked_at = CASE
             WHEN p_kind IS NULL OR p_kind NOT IN ('transient', 'strike', 'permanent') THEN now()
             WHEN p_kind = 'permanent' THEN now()
             WHEN p_kind = 'strike' AND d.strikes + 1 >= 5 THEN now()
             WHEN p_kind = 'transient' AND d.received_at < now() - interval '72 hours' THEN now()
           END,
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

-- The live orgs bound to an installation, or to the account (a reinstall gets a new installation
-- id). Ids and the deletion deadline only; an org being erased is not returned (a reinstall then
-- gets a fresh org). p_account_id NULL → by installation only.
CREATE FUNCTION worker.installation_orgs(
    p_forge text, p_installation_id bigint, p_account_id bigint)
  RETURNS TABLE (org_id uuid, installation_id bigint, account_id bigint, delete_after timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT o.id, o.installation_id, o.account_id, o.delete_after
    FROM public.orgs o
   WHERE o.forge = p_forge AND o.erasing_at IS NULL
     AND (o.installation_id = p_installation_id OR o.account_id = p_account_id)
   ORDER BY o.id
$$;

REVOKE ALL ON FUNCTION worker.claim_webhook_deliveries(text, text[], integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker.complete_webhook_delivery(text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker.fail_webhook_delivery(text, text, uuid, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker.installation_orgs(text, bigint, bigint) FROM PUBLIC;

GRANT USAGE ON SCHEMA worker TO rocky_worker;
GRANT EXECUTE ON FUNCTION worker.claim_webhook_deliveries(text, text[], integer, integer) TO rocky_worker;
GRANT EXECUTE ON FUNCTION worker.complete_webhook_delivery(text, text, uuid, text) TO rocky_worker;
GRANT EXECUTE ON FUNCTION worker.fail_webhook_delivery(text, text, uuid, text, integer, text) TO rocky_worker;
GRANT EXECUTE ON FUNCTION worker.installation_orgs(text, bigint, bigint) TO rocky_worker;

GRANT CREATE ON SCHEMA worker TO rocky_lifecycle;
ALTER FUNCTION worker.claim_webhook_deliveries(text, text[], integer, integer) OWNER TO rocky_lifecycle;
ALTER FUNCTION worker.complete_webhook_delivery(text, text, uuid, text) OWNER TO rocky_lifecycle;
ALTER FUNCTION worker.fail_webhook_delivery(text, text, uuid, text, integer, text) OWNER TO rocky_lifecycle;
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
  inbox_rows_deleted    bigint      NOT NULL CHECK (inbox_rows_deleted >= 0),
  inbox_rows_scrubbed   bigint      NOT NULL CHECK (inbox_rows_scrubbed >= 0)
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

-- The erasure scrubs the org's inbox rows that must stay (pending installation events: a
-- reinstall may be among them), so rocky_retention updates the inbox too.
GRANT UPDATE ON app.webhook_deliveries TO rocky_retention;
CREATE POLICY webhook_deliveries_retention_update ON app.webhook_deliveries
  FOR UPDATE TO rocky_retention USING (true) WITH CHECK (true);
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

-- 0005's erasure plus the org's inbox rows. Of the erased installation: finished rows, rows that
-- are not installation events (pull requests: no org will consume them) and rows of an
-- unexpected shape are deleted; its installation events still pending stay, with the installer
-- and the account login scrubbed (they stay decodable: sender null is valid, the login is
-- display data the worker re-reads from the forge). Of the account's other installations: only
-- finished rows of installations no live org holds (the org's own past, before a rebind). Rows
-- of a reinstall (another installation, pending or bound to a live org) are not the erased
-- org's and are left alone. A tombstone goes to app.org_deletions. The FOR UPDATE lock and the
-- order of deletes are unchanged (see 0005).
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
  n_older bigint;
  n_scrubbed bigint;
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

-- Orgs whose grace period has elapsed, by the database clock, oldest first (1..100 per call),
-- with what the sweep needs to re-verify the uninstall and to resume an erasure in progress.
CREATE FUNCTION retention.orgs_due_for_deletion(p_limit integer)
  RETURNS TABLE (org_id uuid, forge text, installation_id bigint, erasing boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT o.id, o.forge, o.installation_id, o.erasing_at IS NOT NULL FROM public.orgs o
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
