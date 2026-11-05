-- 0018 what a learned memory entry covers and who taught it (P8-2 fix round, ADR 0037).
--
-- severity: for a learned dismissal, the severity of the finding it was learned from. The review
-- stage lets such an entry keep out only findings up to that severity, never a critical one
-- (core `coversSeverity`). NULL for other kinds and for entries a member wrote (P8-3); a dismissal
-- without one covers up to `medium`.
--
-- learner_role: the role the reviewer held when the entry was learned. A newer learned entry
-- never supersedes one learned by a reviewer with a higher role (owner > admin > member). NULL
-- for member-written entries; a learned entry without one ranks as `member`.
--
-- Both columns are nullable with no default, so rows written under 0017 stay valid as they are.
-- No grants or policies change.

ALTER TABLE memory_entries
  ADD COLUMN severity     text,
  ADD COLUMN learner_role text,
  ADD CONSTRAINT memory_entries_severity_code
    CHECK (severity IS NULL OR severity IN ('critical', 'high', 'medium', 'low')),
  ADD CONSTRAINT memory_entries_severity_for_dismissal
    CHECK (severity IS NULL OR kind = 'dismissal'),
  ADD CONSTRAINT memory_entries_learner_role_code
    CHECK (learner_role IS NULL OR learner_role IN ('owner', 'admin', 'member')),
  ADD CONSTRAINT memory_entries_learner_role_learned
    CHECK (learner_role IS NULL OR origin = 'learned');
