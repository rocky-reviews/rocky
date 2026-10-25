-- Roles and the extension are cluster-level and shared with other databases: they stay.
-- The app schema stays too because it holds the migration ledger.
DROP FUNCTION IF EXISTS app.current_org_id();
REVOKE USAGE ON SCHEMA app FROM rocky_app, rocky_retention;
REVOKE USAGE ON SCHEMA public FROM rocky_app, rocky_retention;
