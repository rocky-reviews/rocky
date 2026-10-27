DROP INDEX IF EXISTS analyses_org_revision_idx;
ALTER TABLE analyses DROP CONSTRAINT IF EXISTS analyses_file_units_when_done;
ALTER TABLE analyses DROP COLUMN IF EXISTS file_units;
