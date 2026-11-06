-- Back to the 0018 shape: the switches are dropped (entries and repositories stay).
ALTER TABLE repos
  DROP COLUMN memory_enabled;

ALTER TABLE memory_entries
  DROP COLUMN disabled_at;
