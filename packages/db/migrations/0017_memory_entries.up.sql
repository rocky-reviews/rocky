-- 0017 project memory entries (P8-1, ADR 0036).
--
-- memory_entries (0002) gets its real shape: one entry per repository with its evidence (a
-- repository path, a full commit sha, an inclusive line range, the source PR number), a
-- confidence, a fixed origin, the dismissal reason for `dismissal` entries, when a review last
-- used it, and which entry superseded it. The text is scrubbed of personal identifiers before it
-- is stored (core `prepareMemoryEntry`); the author stays a member id (`created_by`, FK with
-- ON DELETE SET NULL since 0002), so there is never a name to erase: a reader shows "former
-- member" when the member row is gone or removed.
--
-- Every rule core enforces is repeated as a CHECK, so a future caller cannot store a malformed
-- row. The old `source jsonb` column is dropped. Nothing in the product had written this table
-- before P8-1 (the only writer was the test fixture), so the table is emptied first: NOT NULL
-- columns without defaults cannot be added over rows, and a default would be a lie. FORCE RLS
-- hides every row from the owner, so it is lifted for that one statement, as 0015 did.
--
-- No grants or policies change: rocky_app keeps its DML under the tenant policy of 0003.

ALTER TABLE memory_entries NO FORCE ROW LEVEL SECURITY;
DELETE FROM memory_entries;
ALTER TABLE memory_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE memory_entries
  DROP COLUMN source,
  ALTER COLUMN repo_id SET NOT NULL,
  ADD COLUMN origin           text        NOT NULL,
  ADD COLUMN evidence_path    text        NOT NULL,
  ADD COLUMN evidence_sha     text        NOT NULL,
  ADD COLUMN evidence_start   integer     NOT NULL,
  ADD COLUMN evidence_end     integer     NOT NULL,
  ADD COLUMN source_pr_number integer     NOT NULL,
  ADD COLUMN confidence       integer     NOT NULL,
  ADD COLUMN reason           text,
  ADD COLUMN last_used_at     timestamptz,
  ADD COLUMN superseded_by    uuid,
  ADD CONSTRAINT memory_entries_kind_check
    CHECK (kind IN ('convention', 'decision', 'dismissal')),
  ADD CONSTRAINT memory_entries_origin_check
    CHECK (origin IN ('member', 'learned')),
  -- One line of 1..300 characters (schema MAX_MEMORY_TEXT_LENGTH), no control characters.
  ADD CONSTRAINT memory_entries_content_shape
    CHECK (char_length(content) BETWEEN 1 AND 300 AND content !~ '[\x01-\x1F\x7F]'),
  -- Repository-relative POSIX path: no leading '/', no backslash, no '.' or '..' segment, no
  -- trailing '/', no control characters (the full rule is the schema's pathProblem, in core).
  ADD CONSTRAINT memory_entries_evidence_path_shape
    CHECK (char_length(evidence_path) BETWEEN 1 AND 1024
           AND evidence_path !~ '^/' AND evidence_path !~ '\\' AND evidence_path !~ '/$'
           AND evidence_path !~ '(^|/)\.\.?(/|$)' AND evidence_path !~ '[\x01-\x1F\x7F]'),
  ADD CONSTRAINT memory_entries_evidence_sha_shape
    CHECK (evidence_sha ~ '^[0-9a-f]{40}$'),
  -- Inclusive 1-based range of at most 200 lines (schema MAX_RANGE_LINES, MAX_LINE_NUMBER).
  ADD CONSTRAINT memory_entries_evidence_range
    CHECK (evidence_start >= 1 AND evidence_end >= evidence_start
           AND evidence_end - evidence_start < 200 AND evidence_end <= 10000000),
  ADD CONSTRAINT memory_entries_source_pr_number_check
    CHECK (source_pr_number BETWEEN 1 AND 1000000000),
  ADD CONSTRAINT memory_entries_confidence_range
    CHECK (confidence BETWEEN 0 AND 100),
  -- The dismissal reason codes of findings_state (0015); present exactly for dismissals.
  ADD CONSTRAINT memory_entries_reason_code
    CHECK (reason IS NULL OR reason IN ('not_an_issue', 'intentional', 'not_worth_it', 'handled_elsewhere')),
  ADD CONSTRAINT memory_entries_reason_for_dismissal
    CHECK ((kind = 'dismissal') = (reason IS NOT NULL)),
  ADD CONSTRAINT memory_entries_not_self_superseded
    CHECK (superseded_by IS NULL OR superseded_by <> id),
  -- Same org by construction (composite FK, as every parent reference, ADR 0003). Deleting the
  -- newer entry makes the older one current again.
  ADD CONSTRAINT memory_entries_superseded_by_fk
    FOREIGN KEY (org_id, superseded_by) REFERENCES memory_entries (org_id, id)
    ON DELETE SET NULL (superseded_by);

-- The per-repository listing, newest first.
CREATE INDEX memory_entries_org_repo_created_idx ON memory_entries (org_id, repo_id, created_at);
