-- 0020 switching project memory off, per entry and per repository (P8-3, ADR 0039).
--
-- memory_entries.disabled_at: when an admin switched the entry off. A disabled entry is kept
-- (and shown on the memory page) but never offered to a review (`loadAnalysisMemory`), and
-- learning does not store the same pattern again beside it. NULL while it applies.
--
-- repos.memory_enabled: whether reviews of the repository use project memory at all. Off: no
-- entry is offered to a review and nothing is learned; the entries stay. A setting of Rocky's,
-- not mirrored from GitHub: the mirror's upsert never writes it.
--
-- memory_entries.learned_subject: what a learned entry is about (`memorySubject` of its stored
-- text: the text after the fixed prefix, whitespace collapsed, lower-cased), kept when P8-3
-- edits the entry, so an edit with new text still holds the pattern's switch-off and decision.
-- Learning matches on it; NULL for entries a person wrote. Existing learned rows are filled from
-- their text below. An edit also keeps the entry's learner_role (the role whose decision it
-- is), so 0018's rule that only learned entries carry one is dropped.
--
-- Who may change either is `memory.edit` (admins and owners, ADR 0024), re-checked in the
-- writing transaction (packages/db `memory.ts`). No grants or policies change: rocky_app keeps
-- its DML under the tenant policies of 0003.

ALTER TABLE memory_entries
  ADD COLUMN disabled_at timestamptz;

ALTER TABLE memory_entries
  ADD COLUMN learned_subject text;

UPDATE memory_entries AS e
   SET learned_subject = nullif(lower(btrim(regexp_replace(
         substring(e.content FROM length(p.prefix) + 1), '\s+', ' ', 'g'))), '')
  FROM (VALUES ('Dismissed as intentional: '), ('Dismissed as not an issue: '),
               ('Dismissed as handled elsewhere: '), ('Accepted in review: ')) AS p (prefix)
 WHERE e.origin = 'learned' AND starts_with(e.content, p.prefix);

ALTER TABLE memory_entries
  DROP CONSTRAINT memory_entries_learner_role_learned;

ALTER TABLE repos
  ADD COLUMN memory_enabled boolean NOT NULL DEFAULT true;
