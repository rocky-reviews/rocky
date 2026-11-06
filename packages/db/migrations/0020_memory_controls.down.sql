-- Back to the 0018 shape: the switches are dropped (entries and repositories stay).
ALTER TABLE repos
  DROP COLUMN memory_enabled;

UPDATE memory_entries SET learner_role = NULL WHERE origin <> 'learned';

ALTER TABLE memory_entries
  ADD CONSTRAINT memory_entries_learner_role_learned
    CHECK (learner_role IS NULL OR origin = 'learned');

ALTER TABLE memory_entries
  DROP COLUMN learned_subject;

ALTER TABLE memory_entries
  DROP COLUMN disabled_at;
