-- 0010 analysis file units (P4-3, ADR 0014).
--
-- An analysis that finished records, next to its document, the unit key of every file it
-- analysed: a sha256 over what was sent to the model for that file (path, status, patch) under
-- the pipeline version and the role configuration. The next push of the same pull request reuses
-- a file's triage and findings when its key is unchanged, so only changed files are sent to a
-- model again. Keys and paths only: no code, no diff. The document itself stays the one
-- validated analysis document (packages/schema); the row keeps its tenant policy (0003),
-- retention (0005, category `analyses`) and cascades. No grants change.

ALTER TABLE analyses
  ADD COLUMN file_units jsonb,
  -- Only a finished analysis has units, and they are a JSON array.
  ADD CONSTRAINT analyses_file_units_when_done
    CHECK (file_units IS NULL OR (status = 'done' AND jsonb_typeof(file_units) = 'array'));

-- The previous analysis of a pull request is found through its revisions (pr_revisions already
-- has a unique index leading with (org_id, pull_request_id)).
CREATE INDEX analyses_org_revision_idx ON analyses (org_id, revision_id);
