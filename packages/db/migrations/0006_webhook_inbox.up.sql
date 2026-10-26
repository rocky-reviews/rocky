-- 0006 webhook inbox (P3-2, ADR 0007).
--
-- One row per authenticated forge webhook delivery the domain consumes: the durable,
-- deduplicated hand-off from the receiver (apps/server) to the worker. It is not a tenant table:
-- `installation.created` arrives before the org it creates exists. So it lives in `app` (the
-- isolation suite allow-lists it explicitly) and the application role may only INSERT:
--   * no SELECT: a compromised server cannot read other tenants' deliveries;
--   * no UPDATE/DELETE: it cannot remove a delivery to make a replay look new;
--   * received_at is stamped by a trigger, so it cannot date a row out of (or into) the purge.
-- Consumption by the worker (claiming rows) is added with its consumer (P3-3), through a
-- SECURITY DEFINER function like the retention ones, not through a table grant.
--
-- Stored: ids, the event type, the head sha / account login and a sha256 of the raw body. No
-- titles, bodies, diffs, emails or the raw payload (the adapter drops them before this point).

CREATE TABLE app.webhook_deliveries (
  forge            text        NOT NULL CHECK (forge IN ('github', 'gitlab', 'gitea')),
  -- The forge's delivery id (a GUID), lower-cased by the adapter: the idempotency key.
  delivery_id      text        NOT NULL
                               CHECK (delivery_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- sha256 of the raw signed body. Unique per forge: the same signed body replayed under a new
  -- (unsigned) delivery id header is the same delivery.
  payload_sha256   bytea       NOT NULL CHECK (octet_length(payload_sha256) = 32),
  event_type       text        NOT NULL CHECK (event_type IN (
                                 'installation.created', 'installation.deleted',
                                 'pull_request.opened', 'pull_request.synchronize',
                                 'pull_request.closed', 'pull_request.reopened')),
  installation_id  bigint      NOT NULL CHECK (installation_id > 0),
  -- The decoded, minimal event (packages/core ForgeEvent). Small by construction; capped anyway.
  event            jsonb       NOT NULL
                               CHECK (jsonb_typeof(event) = 'object' AND octet_length(event::text) <= 1024),
  received_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (forge, delivery_id),
  CONSTRAINT webhook_deliveries_payload_unique UNIQUE (forge, payload_sha256),
  -- IS NOT DISTINCT FROM / IS NOT NULL: a missing key must fail the CHECK, not pass it as NULL.
  CONSTRAINT webhook_deliveries_event_type_matches
    CHECK ((event ->> 'type') IS NOT DISTINCT FROM event_type),
  CONSTRAINT webhook_deliveries_installation_matches
    CHECK ((event ->> 'installationId') IS NOT NULL
           AND (event ->> 'installationId')::numeric = installation_id)
);

CREATE INDEX webhook_deliveries_received_idx ON app.webhook_deliveries (received_at);

-- received_at is the purge key: set it for every role (the audit_events pattern, 0004).
CREATE FUNCTION app.webhook_deliveries_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.received_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER webhook_deliveries_stamp
  BEFORE INSERT ON app.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.webhook_deliveries_stamp();

-- RLS as a second fence: a stray future SELECT/UPDATE/DELETE grant to the app still matches no
-- row, because the only policy for it is INSERT.
ALTER TABLE app.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_app_insert ON app.webhook_deliveries
  FOR INSERT TO rocky_app WITH CHECK (true);
GRANT INSERT ON app.webhook_deliveries TO rocky_app;

-- --- Retention ----------------------------------------------------------------------------------

-- The dedup window is the retention period: GitHub redelivers for up to 3 days, so the floor is
-- 7 days. Default 30.
ALTER TABLE app.retention_settings DROP CONSTRAINT retention_settings_category_check;
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_category_check
  CHECK (category IN ('analyses', 'logs', 'audit', 'org_deletion_grace', 'webhook_deliveries'));
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_webhook_floor
  CHECK (category <> 'webhook_deliveries' OR days >= 7);
INSERT INTO app.retention_settings (category, days) VALUES ('webhook_deliveries', 30);

GRANT SELECT, DELETE ON app.webhook_deliveries TO rocky_retention;
CREATE POLICY webhook_deliveries_retention_select ON app.webhook_deliveries
  FOR SELECT TO rocky_retention USING (true);
CREATE POLICY webhook_deliveries_retention_delete ON app.webhook_deliveries
  FOR DELETE TO rocky_retention USING (true);

-- Same contract as the 0005 purges: the period comes from the owner-written settings, `as_of`
-- can only move the cutoff into the past, a missing setting deletes nothing. Not audited per
-- org (a delivery has no org); returns the count for the caller to log.
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

REVOKE ALL ON FUNCTION retention.purge_webhook_deliveries(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention.purge_webhook_deliveries(timestamptz) TO rocky_app;

GRANT CREATE ON SCHEMA retention TO rocky_retention;
ALTER FUNCTION retention.purge_webhook_deliveries(timestamptz) OWNER TO rocky_retention;
REVOKE CREATE ON SCHEMA retention FROM rocky_retention;
