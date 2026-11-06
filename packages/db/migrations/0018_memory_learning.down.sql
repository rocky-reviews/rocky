-- Back to the 0017 shape: the coverage and the learner's role are dropped with their checks.
ALTER TABLE memory_entries
  DROP CONSTRAINT memory_entries_learner_role_learned,
  DROP CONSTRAINT memory_entries_learner_role_code,
  DROP CONSTRAINT memory_entries_severity_for_dismissal,
  DROP CONSTRAINT memory_entries_severity_code,
  DROP COLUMN learner_role,
  DROP COLUMN severity;
