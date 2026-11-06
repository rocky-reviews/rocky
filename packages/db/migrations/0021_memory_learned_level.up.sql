-- 0021 the triage level a learned dismissal was taken at (P8-2b, ADR 0037 §7).
--
-- learned_level: for a learned dismissal, the triage level (after the rule floor) the dismissed
-- finding's file had in the analysis the reviewer dismissed it on, read by the learner from the
-- stored document's triage (never from a model answer, never from a request). The review stage
-- lets a dismissal taken on a `critical` file stand on a critical file within the same file or
-- directory as its evidence (core `suppressionStands`); every other value, and NULL (entries
-- learned before this column, and every other kind of entry), ranks as non-critical, so nothing
-- that was learned before changes behaviour. Only a learned dismissal may carry it: a
-- member-written entry (P8-3) records a person's rule, not a decision taken in critical context.
--
-- Nullable with no default, so rows written under 0018 stay valid as they are. No grants or
-- policies change.

ALTER TABLE memory_entries
  ADD COLUMN learned_level text,
  ADD CONSTRAINT memory_entries_learned_level_code
    CHECK (learned_level IS NULL OR learned_level IN ('critical', 'important', 'normal', 'low')),
  ADD CONSTRAINT memory_entries_learned_level_learned_dismissal
    CHECK (learned_level IS NULL OR (kind = 'dismissal' AND origin = 'learned'));
