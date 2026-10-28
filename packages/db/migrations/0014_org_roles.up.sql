-- 0014 roles per org (P7-2, ADR 0024).
--
--   * members.role gains `owner` (owner > admin > member). Roles live on the tenant table, so they
--     are only read and changed inside withOrg (RLS), like every other member column.
--   * An org that has an owner always keeps one: the trigger below refuses any change (role,
--     removal, delete) that would leave an org with owners with none. Changes to an org's owners
--     are serialised on a transaction-scoped advisory lock, so two concurrent demotions cannot
--     each see the other owner and both succeed. The server takes the same lock first.
--   * app.session_orgs: the application may delete the links of the current tenant only, so a
--     person who leaves the GitHub organization (webhook) or is removed in Rocky loses that org in
--     every live session at once.
--   * The webhook inbox accepts `org_member.removed` (the forge's "someone left the
--     organization"), with a CHECK on its stored shape like the installation rows (0007).

-- --- Roles ------------------------------------------------------------------------------------

ALTER TABLE members DROP CONSTRAINT members_role_check;
ALTER TABLE members ADD CONSTRAINT members_role_check CHECK (role IN ('owner', 'admin', 'member'));

-- The lock every change to an org's owners takes (the server's role changes, the first owner at
-- sign-in, and this trigger). Transaction-scoped: released at commit or rollback.
CREATE FUNCTION app.lock_org_owners(org uuid) RETURNS void
  LANGUAGE sql VOLATILE
  SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rocky.org_owners:' || org::text, 0))
$$;
REVOKE ALL ON FUNCTION app.lock_org_owners(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_org_owners(uuid) TO rocky_app;

-- SECURITY INVOKER on purpose: it counts owners as the role making the change sees them. For the
-- application that is inside withOrg, where RLS shows exactly that org's members. An org that is
-- gone or being erased (retention.delete_org cascades through members) is not checked: there is
-- nothing left to own. READ COMMITTED: the count after the lock sees every committed change.
CREATE FUNCTION app.members_keep_an_owner() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM 'owner' OR OLD.removed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND NEW.removed_at IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orgs o WHERE o.id = OLD.org_id AND o.erasing_at IS NULL) THEN
    RETURN NULL;
  END IF;
  PERFORM app.lock_org_owners(OLD.org_id);
  IF NOT EXISTS (SELECT 1 FROM public.members m
                  WHERE m.org_id = OLD.org_id AND m.role = 'owner' AND m.removed_at IS NULL) THEN
    RAISE EXCEPTION 'members: an org must keep at least one owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'members_keep_an_owner';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER members_keep_an_owner
  AFTER UPDATE OF role, removed_at OR DELETE ON members
  FOR EACH ROW EXECUTE FUNCTION app.members_keep_an_owner();

-- --- Sessions lose an org at once ---------------------------------------------------------------

CREATE POLICY session_orgs_app_delete ON app.session_orgs FOR DELETE TO rocky_app
  USING (org_id = app.current_org_id());
GRANT DELETE ON app.session_orgs TO rocky_app;

-- --- Inbox: someone left the organization ------------------------------------------------------

ALTER TABLE app.webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE app.webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check
  CHECK (event_type IN (
    'installation.created', 'installation.deleted',
    'pull_request.opened', 'pull_request.synchronize',
    'pull_request.closed', 'pull_request.reopened',
    'org_member.removed'));

-- The shape `minimalEvent` (packages/db) accepts: an organization account and the person's id.
ALTER TABLE app.webhook_deliveries ADD CONSTRAINT webhook_deliveries_org_member_shape CHECK (
  event_type NOT LIKE 'org_member.%' OR CASE
    WHEN jsonb_typeof(event -> 'account') IS DISTINCT FROM 'object' THEN false
    WHEN jsonb_typeof(event #> '{account,id}') IS DISTINCT FROM 'number' THEN false
    WHEN (event #>> '{account,id}') !~ '^[1-9][0-9]{0,15}$' THEN false
    WHEN (event #>> '{account,id}')::numeric > 9007199254740991 THEN false
    WHEN jsonb_typeof(event #> '{account,login}') IS DISTINCT FROM 'string' THEN false
    WHEN (event #>> '{account,login}') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$' THEN false
    WHEN (event #>> '{account,kind}') IS DISTINCT FROM 'organization' THEN false
    WHEN jsonb_typeof(event -> 'memberForgeUserId') IS DISTINCT FROM 'number' THEN false
    WHEN (event ->> 'memberForgeUserId') !~ '^[1-9][0-9]{0,15}$' THEN false
    ELSE (event ->> 'memberForgeUserId')::numeric <= 9007199254740991
  END);
