-- The purge function is owned by rocky_retention (the migrator holds SET on it, 0001); the owner
-- needs USAGE on the schema to drop it, granted only for the duration.
GRANT USAGE ON SCHEMA retention TO rocky_retention;
SET LOCAL ROLE rocky_retention;
DROP FUNCTION IF EXISTS retention.purge_webhook_deliveries(timestamptz);
RESET ROLE;
REVOKE USAGE ON SCHEMA retention FROM rocky_retention;

DELETE FROM app.retention_settings WHERE category = 'webhook_deliveries';
ALTER TABLE app.retention_settings DROP CONSTRAINT IF EXISTS retention_settings_webhook_floor;
ALTER TABLE app.retention_settings DROP CONSTRAINT retention_settings_category_check;
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_category_check
  CHECK (category IN ('analyses', 'logs', 'audit', 'org_deletion_grace'));

DROP TABLE IF EXISTS app.webhook_deliveries;
DROP FUNCTION IF EXISTS app.webhook_deliveries_stamp();
