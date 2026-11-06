-- Back to the 0018 shape: the learned level is dropped with its checks.
ALTER TABLE memory_entries
  DROP CONSTRAINT memory_entries_learned_level_learned_dismissal,
  DROP CONSTRAINT memory_entries_learned_level_code,
  DROP COLUMN learned_level;
