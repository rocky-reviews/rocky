-- Reverts 0024. Token orgs cannot exist without the column: the rollback refuses while one
-- exists, so the schema can go back to "every org has an installation". Functions owned by
-- rocky_auth and rocky_lifecycle are dropped by their owners and recreated by the migrator with
-- their 0013 and 0007 bodies, then handed back (the same pattern as the up script).

ALTER TABLE repos DROP COLUMN synced_at;

GRANT USAGE ON SCHEMA auth TO rocky_auth;
SET LOCAL ROLE rocky_auth;
DROP FUNCTION auth.token_org(text);
DROP FUNCTION auth.create_token_org(text, bigint, text);
DROP FUNCTION auth.login_orgs(text, bigint[], bigint[]);
RESET ROLE;
REVOKE USAGE ON SCHEMA auth FROM rocky_auth;
DROP POLICY orgs_auth_insert ON orgs;
REVOKE INSERT ON orgs FROM rocky_auth;
REVOKE USAGE ON SCHEMA app FROM rocky_auth;
REVOKE SELECT (connection) ON orgs FROM rocky_auth;

CREATE FUNCTION auth.login_orgs(p_forge text, p_installation_ids bigint[], p_account_ids bigint[])
  RETURNS TABLE (org_id uuid, installation_id bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT o.id, o.installation_id
    FROM public.orgs o
    JOIN unnest(p_installation_ids, p_account_ids) AS i(installation_id, account_id)
      ON o.installation_id = i.installation_id AND o.account_id = i.account_id
   WHERE o.forge = p_forge
     AND o.erasing_at IS NULL
     AND o.delete_after IS NULL
     AND cardinality(p_installation_ids) = cardinality(p_account_ids)
     AND cardinality(p_installation_ids) <= 1000
   ORDER BY o.id
$$;
REVOKE ALL ON FUNCTION auth.login_orgs(text, bigint[], bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.login_orgs(text, bigint[], bigint[]) TO rocky_app;
GRANT CREATE ON SCHEMA auth TO rocky_auth;
ALTER FUNCTION auth.login_orgs(text, bigint[], bigint[]) OWNER TO rocky_auth;
REVOKE CREATE ON SCHEMA auth FROM rocky_auth;

GRANT USAGE ON SCHEMA worker TO rocky_lifecycle;
SET LOCAL ROLE rocky_lifecycle;
DROP FUNCTION worker.installation_orgs(text, bigint, bigint);
RESET ROLE;
REVOKE USAGE ON SCHEMA worker FROM rocky_lifecycle;

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
REVOKE ALL ON FUNCTION worker.installation_orgs(text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker.installation_orgs(text, bigint, bigint) TO rocky_worker;
GRANT CREATE ON SCHEMA worker TO rocky_lifecycle;
ALTER FUNCTION worker.installation_orgs(text, bigint, bigint) OWNER TO rocky_lifecycle;
REVOKE CREATE ON SCHEMA worker FROM rocky_lifecycle;

CREATE OR REPLACE FUNCTION app.orgs_guard_identity() RETURNS trigger
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

-- Token orgs have no place in the 0023 schema, and a migration never deletes tenant data: with a
-- token org present, SET NOT NULL below fails and the rollback stops (erase the org first).
ALTER TABLE orgs DROP CONSTRAINT orgs_token_connection_user;
ALTER TABLE orgs DROP CONSTRAINT orgs_connection_installation;
ALTER TABLE orgs ALTER COLUMN installation_id SET NOT NULL;
ALTER TABLE orgs DROP COLUMN connection;
