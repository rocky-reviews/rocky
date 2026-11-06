-- 0019 switching project memory off, per entry and per repository (P8-3, ADR 0038).
--
-- memory_entries.disabled_at: when an admin switched the entry off. A disabled entry is kept
-- (and shown on the memory page) but never offered to a review (`loadAnalysisMemory`), and
-- learning does not store the same pattern again beside it. NULL while it applies.
--
-- repos.memory_enabled: whether reviews of the repository use project memory at all. Off: no
-- entry is offered to a review and nothing is learned; the entries stay. A setting of Rocky's,
-- not mirrored from GitHub: the mirror's upsert never writes it.
--
-- Who may change either is `memory.edit` (admins and owners, ADR 0024), re-checked in the
-- writing transaction (packages/db `memory.ts`). No grants or policies change: rocky_app keeps
-- its DML under the tenant policies of 0003.

ALTER TABLE memory_entries
  ADD COLUMN disabled_at timestamptz;

ALTER TABLE repos
  ADD COLUMN memory_enabled boolean NOT NULL DEFAULT true;
