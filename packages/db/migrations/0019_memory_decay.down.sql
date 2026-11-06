-- Back to the 0018 shape: the decay marker, its indexes, the worker's org list and the three
-- memory windows go; the category CHECK returns to the 0011 list.
DROP FUNCTION IF EXISTS worker.live_orgs(uuid, integer);

DROP INDEX IF EXISTS memory_entries_org_learned_history_idx;
DROP INDEX IF EXISTS memory_entries_org_learned_current_idx;
ALTER TABLE memory_entries DROP COLUMN decayed_at;

DELETE FROM app.retention_settings
 WHERE category IN ('memory_decay', 'memory_unused', 'memory_superseded');
ALTER TABLE app.retention_settings DROP CONSTRAINT IF EXISTS retention_settings_memory_superseded_floor;
ALTER TABLE app.retention_settings DROP CONSTRAINT IF EXISTS retention_settings_memory_unused_floor;
ALTER TABLE app.retention_settings DROP CONSTRAINT retention_settings_category_check;
ALTER TABLE app.retention_settings ADD CONSTRAINT retention_settings_category_check
  CHECK (category IN ('analyses', 'logs', 'audit', 'org_deletion_grace', 'webhook_deliveries',
                      'llm_usage'));
