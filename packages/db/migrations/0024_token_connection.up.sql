-- 0024 token connection (P10-4, ADR 0045): a self-hosted org connected through one person's
-- personal access token instead of a GitHub App installation.
--
--   1. `orgs.connection` says how the org reaches GitHub: 'app' (every org so far: bound to an
--      installation, ADR 0009) or 'token' (bound to the token owner's immutable account id only,
--      with no installation). `installation_id` becomes nullable, exactly for token orgs (CHECK).
--      A token org is always a User account. The kind is immutable (the identity trigger).
--   2. The installation lifecycle and login lookups (`worker.installation_orgs`,
--      `auth.login_orgs`) see App orgs only: a token org is never rebound, scheduled for deletion
--      by an uninstall, or offered to a GitHub sign-in.
--   3. Two narrow SECURITY DEFINER functions owned by `rocky_auth`, executable by the application
--      role, for the server (which cannot otherwise create orgs, ADR 0009):
--      `auth.create_token_org` inserts exactly a token org for the current tenant id (inside
--      `withOrg(newId)`, as the worker creates orgs), and `auth.token_org` answers "which live
--      token org exists?" with ids only. The token itself is stored like a member's sign-in token
--      (`members.forge_token_ciphertext`, envelope-encrypted, ADR 0020 §4); nothing here holds it.
--   4. `repos.synced_at`: when a repository's pull requests were last read from GitHub on the
--      token (the web app shows "last synced"; webhook-driven orgs leave it null).
--
-- Replacing a function another role owns: the owner drops it (SET ROLE, with USAGE on the
-- schema for that statement only: the 0009 pattern), the migrator creates the new one (it alone
-- may use the languages) and hands it over (ALTER OWNER with CREATE on the schema: the 0007 and
-- 0013 pattern), then the grants are made again.

-- --- 1. The connection kind ----------------------------------------------------------------------

ALTER TABLE orgs ADD COLUMN connection text NOT NULL DEFAULT 'app'
  CHECK (connection IN ('app', 'token'));
ALTER TABLE orgs ALTER COLUMN installation_id DROP NOT NULL;
-- An App org has an installation; a token org has none. Never both, never neither.
ALTER TABLE orgs ADD CONSTRAINT orgs_connection_installation
  CHECK ((connection = 'app') = (installation_id IS NOT NULL));
-- A token belongs to a person: a token org is that person's User account.
ALTER TABLE orgs ADD CONSTRAINT orgs_token_connection_user
  CHECK (connection = 'app' OR kind = 'user');

-- The connection kind never changes (an org is created one way and stays that way).
CREATE OR REPLACE FUNCTION app.orgs_guard_identity() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.forge IS DISTINCT FROM OLD.forge
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.connection IS DISTINCT FROM OLD.connection THEN
    RAISE EXCEPTION 'orgs: id, forge, account_id and connection are immutable'
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

-- --- 2. The installation lookups see App orgs only ------------------------------------------------

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
   WHERE o.forge = p_forge AND o.erasing_at IS NULL AND o.connection = 'app'
     AND (o.installation_id = p_installation_id OR o.account_id = p_account_id)
   ORDER BY o.id
$$;
REVOKE ALL ON FUNCTION worker.installation_orgs(text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker.installation_orgs(text, bigint, bigint) TO rocky_worker;
GRANT CREATE ON SCHEMA worker TO rocky_lifecycle;
ALTER FUNCTION worker.installation_orgs(text, bigint, bigint) OWNER TO rocky_lifecycle;
REVOKE CREATE ON SCHEMA worker FROM rocky_lifecycle;

GRANT SELECT (connection) ON orgs TO rocky_auth;
GRANT USAGE ON SCHEMA auth TO rocky_auth;
SET LOCAL ROLE rocky_auth;
DROP FUNCTION auth.login_orgs(text, bigint[], bigint[]);
RESET ROLE;
REVOKE USAGE ON SCHEMA auth FROM rocky_auth;

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
     AND o.connection = 'app'
     AND cardinality(p_installation_ids) = cardinality(p_account_ids)
     AND cardinality(p_installation_ids) <= 1000
   ORDER BY o.id
$$;
REVOKE ALL ON FUNCTION auth.login_orgs(text, bigint[], bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.login_orgs(text, bigint[], bigint[]) TO rocky_app;

-- --- 3. Creating and finding the token org -----------------------------------------------------

-- The server creates the token org from the setup wizard (there is no installation event to
-- create it from), inside withOrg(newId) like the worker: the tenant id is the transaction's.
-- rocky_auth may insert exactly that: a token org, for the current tenant id, with no
-- installation. The function pins the rest (a User account, display login).
-- The tenant id comes from app.current_org_id(), which lives in schema app.
GRANT USAGE ON SCHEMA app TO rocky_auth;
GRANT INSERT ON orgs TO rocky_auth;
CREATE POLICY orgs_auth_insert ON orgs FOR INSERT TO rocky_auth
  WITH CHECK (id = app.current_org_id() AND connection = 'token' AND installation_id IS NULL);

-- A token org exists only on an instance that has nothing else: no App org at all (an instance
-- connected through the App, such as Rocky Cloud, can never gain one, whatever the server's
-- configuration says) and no other live token org (one token, one owner). Otherwise nothing is
-- inserted and the function returns NULL.
CREATE FUNCTION auth.create_token_org(p_forge text, p_account_id bigint, p_login text)
  RETURNS uuid
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  INSERT INTO public.orgs (id, forge, connection, installation_id, account_id, login, kind)
  SELECT app.current_org_id(), p_forge, 'token', NULL, p_account_id, p_login, 'user'
   WHERE NOT EXISTS (SELECT 1 FROM public.orgs o WHERE o.connection = 'app')
     AND NOT EXISTS (SELECT 1 FROM public.orgs o
                      WHERE o.connection = 'token' AND o.erasing_at IS NULL)
  RETURNING id
$$;

-- The one live token org of a forge (at most one exists: create_token_org refuses a second),
-- ids only. Nothing scheduled for deletion or being
-- erased is returned.
CREATE FUNCTION auth.token_org(p_forge text)
  RETURNS TABLE (org_id uuid, account_id bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT o.id, o.account_id
    FROM public.orgs o
   WHERE o.forge = p_forge
     AND o.connection = 'token'
     AND o.delete_after IS NULL
     AND o.erasing_at IS NULL
   ORDER BY o.id
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth.create_token_org(text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.token_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.create_token_org(text, bigint, text) TO rocky_app;
GRANT EXECUTE ON FUNCTION auth.token_org(text) TO rocky_app;

GRANT CREATE ON SCHEMA auth TO rocky_auth;
ALTER FUNCTION auth.login_orgs(text, bigint[], bigint[]) OWNER TO rocky_auth;
ALTER FUNCTION auth.create_token_org(text, bigint, text) OWNER TO rocky_auth;
ALTER FUNCTION auth.token_org(text) OWNER TO rocky_auth;
REVOKE CREATE ON SCHEMA auth FROM rocky_auth;

-- --- 4. When a repository was last synced on the token ------------------------------------------

ALTER TABLE repos ADD COLUMN synced_at timestamptz;
