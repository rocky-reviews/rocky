-- Back to the 0002 shape. Rows written under 0017 do not fit the old shape (no source, typed
-- evidence); the table is emptied the same way the up script did.
DROP INDEX IF EXISTS memory_entries_org_superseded_by_idx;
DROP INDEX IF EXISTS memory_entries_org_repo_created_idx;

ALTER TABLE memory_entries NO FORCE ROW LEVEL SECURITY;
DELETE FROM memory_entries;
ALTER TABLE memory_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE memory_entries
  DROP CONSTRAINT memory_entries_superseded_by_fk,
  DROP CONSTRAINT memory_entries_not_self_superseded,
  DROP CONSTRAINT memory_entries_reason_for_dismissal,
  DROP CONSTRAINT memory_entries_reason_code,
  DROP CONSTRAINT memory_entries_confidence_range,
  DROP CONSTRAINT memory_entries_source_pr_number_check,
  DROP CONSTRAINT memory_entries_evidence_range,
  DROP CONSTRAINT memory_entries_evidence_sha_shape,
  DROP CONSTRAINT memory_entries_evidence_path_shape,
  DROP CONSTRAINT memory_entries_content_shape,
  DROP CONSTRAINT memory_entries_origin_check,
  DROP CONSTRAINT memory_entries_kind_check,
  DROP COLUMN superseded_by,
  DROP COLUMN last_used_at,
  DROP COLUMN reason,
  DROP COLUMN confidence,
  DROP COLUMN source_pr_number,
  DROP COLUMN evidence_end,
  DROP COLUMN evidence_start,
  DROP COLUMN evidence_sha,
  DROP COLUMN evidence_path,
  DROP COLUMN origin,
  ALTER COLUMN repo_id DROP NOT NULL,
  ADD COLUMN source jsonb NOT NULL DEFAULT '{}'::jsonb;
