ALTER TABLE pr_revisions
  DROP CONSTRAINT IF EXISTS pr_revisions_diff_truncation_read,
  DROP CONSTRAINT IF EXISTS pr_revisions_diff_truncation_flag,
  DROP CONSTRAINT IF EXISTS pr_revisions_diff_pair,
  DROP COLUMN IF EXISTS diff_truncation,
  DROP COLUMN IF EXISTS diff_sha256,
  DROP COLUMN IF EXISTS diff_bytes;

ALTER TABLE pull_requests DROP COLUMN IF EXISTS forge_updated_at;
