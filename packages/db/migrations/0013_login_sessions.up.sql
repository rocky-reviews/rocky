-- 0013 login and sessions (P7-1, ADR 0020).
--
-- A person logs in with the forge (GitHub App user authorization, PKCE). Sessions are
-- user-level, not tenant-level: one session can reach every org the person is a member of, so
-- these tables live in `app` (the isolation suite allow-lists them) rather than in `public`.
-- Tenant data is still read only inside withOrg, after the session's membership of that org is
-- checked.
--
--   * app.users: one row per forge identity, bound by the forge's numeric user id, never by login.
--     No login, name, email or avatar is stored here.
--   * app.login_attempts: one row per login in flight, keyed by sha256(state). Deleting the row
--     is how a state is consumed, so a state works once. Never the state, never the PKCE verifier.
--   * app.sessions: keyed by sha256(cookie token); the token itself is never stored. Absolute
--     expiry (`expires_at`) is written once at creation and cannot be changed by the application
--     (no UPDATE grant on it); idle expiry is `last_seen_at + idle_timeout_seconds`. A revoked
--     session cannot be revived (the UPDATE policy only matches live rows).
--   * app.session_orgs: the orgs (and member rows) whose membership was verified with the forge
--     at login. Deleting the member deletes the link (cascade), so removing someone from an org
--     in Rocky ends that org for their sessions at once.
--   * auth.login_orgs: the one cross-tenant read login needs ("which live orgs are these
--     installations?"), as a SECURITY DEFINER function owned by a dedicated NOLOGIN role that can
--     read five columns of `orgs` and nothing else.
--
-- members gains `forge_access_expires_at`: when the stored user token expires (sessions never
-- outlive it). The refresh token is not stored (ADR 0020 §4).

-- --- Role -------------------------------------------------------------------------------------

-- Same rules as 0001 and 0007: created if missing, never ALTERed, and a pre-existing role with
-- stronger attributes or memberships aborts the migration.
DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rocky_auth') THEN
    CREATE ROLE rocky_auth NOINHERIT;
  END IF;
  SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
    INTO r FROM pg_roles WHERE rolname = 'rocky_auth';
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolcanlogin THEN
    RAISE EXCEPTION 'role rocky_auth must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOLOGIN; fix it before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'rocky_auth')) THEN
    RAISE EXCEPTION 'role rocky_auth must not be a member of any other role';
  END IF;
  -- The migrator hands the function to rocky_auth (ALTER FUNCTION … OWNER TO): SET, never INHERIT.
  IF NOT pg_has_role(current_user, 'rocky_auth', 'SET') THEN
    EXECUTE format('GRANT rocky_auth TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  END IF;
END
$$;

-- --- members: when the stored token expires ----------------------------------------------------

ALTER TABLE members ADD COLUMN forge_access_expires_at timestamptz;
ALTER TABLE members ADD CONSTRAINT members_forge_access_expiry_needs_token
  CHECK (forge_access_expires_at IS NULL OR forge_token_ciphertext IS NOT NULL);

-- --- Users --------------------------------------------------------------------------------------

CREATE TABLE app.users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  forge          text        NOT NULL CHECK (forge IN ('github', 'gitlab', 'gitea')),
  forge_user_id  bigint      NOT NULL CHECK (forge_user_id > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_forge_user_unique UNIQUE (forge, forge_user_id)
);

-- --- Logins in flight ----------------------------------------------------------------------------

CREATE TABLE app.login_attempts (
  state_sha256  bytea       PRIMARY KEY CHECK (octet_length(state_sha256) = 32),
  -- A same-origin relative path, validated by the server before it is stored and again before it
  -- is used. The CHECK is a backstop: it must start with one `/` and contain no `\`, no
  -- whitespace or control character.
  return_to     text        NOT NULL
                            CHECK (octet_length(return_to) <= 2048
                                   AND return_to ~ '^/([^/\\]|$)'
                                   AND return_to !~ '[\\[:space:][:cntrl:]]'),
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  CONSTRAINT login_attempts_lifetime
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX login_attempts_expires_idx ON app.login_attempts (expires_at);

-- --- Sessions ------------------------------------------------------------------------------------

CREATE TABLE app.sessions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256          bytea       NOT NULL CHECK (octet_length(token_sha256) = 32),
  user_id               uuid        NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  -- The org the person is working in; only meaningful while app.session_orgs links it (the
  -- server joins on that). Cleared when the org is erased.
  active_org_id         uuid        REFERENCES public.orgs (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL,
  last_seen_at          timestamptz NOT NULL,
  idle_timeout_seconds  integer     NOT NULL CHECK (idle_timeout_seconds BETWEEN 60 AND 86400),
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz,
  revoked_reason        text        CHECK (revoked_reason IN ('logout', 'superseded')),
  CONSTRAINT sessions_token_unique UNIQUE (token_sha256),
  CONSTRAINT sessions_lifetime
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CONSTRAINT sessions_seen_after_created CHECK (last_seen_at >= created_at),
  CONSTRAINT sessions_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX sessions_user_idx ON app.sessions (user_id);
CREATE INDEX sessions_expires_idx ON app.sessions (expires_at);
CREATE INDEX sessions_active_org_idx ON app.sessions (active_org_id) WHERE active_org_id IS NOT NULL;

CREATE TABLE app.session_orgs (
  session_id  uuid NOT NULL REFERENCES app.sessions (id) ON DELETE CASCADE,
  org_id      uuid NOT NULL,
  member_id   uuid NOT NULL,
  CONSTRAINT session_orgs_pkey PRIMARY KEY (session_id, org_id),
  -- Composite: the member row must belong to that org (FK checks ignore RLS, ADR 0005 §4).
  CONSTRAINT session_orgs_member_fk FOREIGN KEY (org_id, member_id)
    REFERENCES public.members (org_id, id) ON DELETE CASCADE
);
CREATE INDEX session_orgs_member_idx ON app.session_orgs (org_id, member_id);

-- --- Grants and policies -------------------------------------------------------------------------

-- RLS as a second fence on every table (the privileges are the first): a stray future grant
-- still matches only what the policies allow. No policy for anyone but rocky_app.
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_app_select ON app.users FOR SELECT TO rocky_app USING (true);
CREATE POLICY users_app_insert ON app.users FOR INSERT TO rocky_app WITH CHECK (true);
CREATE POLICY users_app_update ON app.users FOR UPDATE TO rocky_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.users TO rocky_app;
GRANT UPDATE (last_login_at) ON app.users TO rocky_app;

ALTER TABLE app.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.login_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY login_attempts_app ON app.login_attempts FOR ALL TO rocky_app USING (true) WITH CHECK (true);
-- SELECT only because DELETE … RETURNING needs it; no UPDATE: an attempt is never extended.
GRANT SELECT, INSERT, DELETE ON app.login_attempts TO rocky_app;

ALTER TABLE app.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_app_select ON app.sessions FOR SELECT TO rocky_app USING (true);
CREATE POLICY sessions_app_insert ON app.sessions FOR INSERT TO rocky_app WITH CHECK (revoked_at IS NULL);
-- Only live rows can change, so a revoked session is never revived.
CREATE POLICY sessions_app_update ON app.sessions FOR UPDATE TO rocky_app
  USING (revoked_at IS NULL) WITH CHECK (true);
-- Only dead rows can be removed (housekeeping); a live session ends by revocation.
CREATE POLICY sessions_app_delete ON app.sessions FOR DELETE TO rocky_app
  USING (revoked_at IS NOT NULL OR expires_at < now());
GRANT SELECT, INSERT, DELETE ON app.sessions TO rocky_app;
-- Never token_sha256, user_id, created_at, idle_timeout_seconds or expires_at: the absolute
-- expiry cannot be extended and a session cannot be moved to another user or token.
GRANT UPDATE (last_seen_at, active_org_id, revoked_at, revoked_reason) ON app.sessions TO rocky_app;

ALTER TABLE app.session_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.session_orgs FORCE ROW LEVEL SECURITY;
CREATE POLICY session_orgs_app_select ON app.session_orgs FOR SELECT TO rocky_app USING (true);
CREATE POLICY session_orgs_app_insert ON app.session_orgs FOR INSERT TO rocky_app WITH CHECK (true);
GRANT SELECT, INSERT ON app.session_orgs TO rocky_app;

-- --- Which orgs are these installations? ---------------------------------------------------------

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public TO rocky_auth;
GRANT SELECT (id, forge, installation_id, account_id, delete_after, erasing_at) ON orgs TO rocky_auth;
CREATE POLICY orgs_auth_select ON orgs FOR SELECT TO rocky_auth USING (true);

-- The live orgs bound to the given (installation id, account id) pairs, which the server got
-- from the forge for the user's own token. Both ids must match (orgs bind by both, ADR 0009). An
-- org scheduled for deletion or being erased is not offered. Ids only; at most 1000 pairs.
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
GRANT USAGE ON SCHEMA auth TO rocky_app;
GRANT EXECUTE ON FUNCTION auth.login_orgs(text, bigint[], bigint[]) TO rocky_app;
GRANT CREATE ON SCHEMA auth TO rocky_auth;
ALTER FUNCTION auth.login_orgs(text, bigint[], bigint[]) OWNER TO rocky_auth;
REVOKE CREATE ON SCHEMA auth FROM rocky_auth;
