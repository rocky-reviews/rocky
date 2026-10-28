-- Reverts 0013. The role rocky_auth is cluster-level and stays (like 0001 and 0007).
DROP FUNCTION IF EXISTS auth.login_orgs(text, bigint[], bigint[]);
DROP SCHEMA IF EXISTS auth;
DROP POLICY IF EXISTS orgs_auth_select ON orgs;
REVOKE SELECT (id, forge, installation_id, account_id, delete_after, erasing_at) ON orgs FROM rocky_auth;
REVOKE USAGE ON SCHEMA public FROM rocky_auth;

DROP TABLE IF EXISTS app.session_orgs;
DROP TRIGGER IF EXISTS sessions_guard_touch ON app.sessions;
DROP FUNCTION IF EXISTS app.sessions_guard_touch();
DROP TABLE IF EXISTS app.sessions;
DROP TABLE IF EXISTS app.login_attempts;
DROP TABLE IF EXISTS app.users;

ALTER TABLE members DROP CONSTRAINT IF EXISTS members_removed_has_no_token;
ALTER TABLE members DROP COLUMN IF EXISTS removed_at;
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_forge_access_expiry_needs_token;
ALTER TABLE members DROP COLUMN IF EXISTS forge_access_expires_at;
