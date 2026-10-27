-- 0008 pull request mirror (P3-4, ADR 0010).
--
-- The mirror is derived data: GitHub is the source of truth, and the rebuild command recreates
-- it from GitHub. The tables exist since 0002; this adds what the mirror needs to be rebuilt
-- safely and to say how complete a revision's diff was:
--   * pull_requests.forge_updated_at: the forge's last-modified time of the snapshot stored, so
--     a slower writer (a webhook and the rebuild command at once) never replaces a newer
--     snapshot with an older one;
--   * pr_revisions.diff_*: what was read of the revision's diff. The diff text itself is not
--     stored here (it is code: the analysis reads it from the forge when it needs it); its size
--     and sha256 identify what was read, and `diff_truncation` says why it is incomplete.
-- No grants change: the worker writes these tables through rocky_app's existing privileges,
-- inside withOrg, under the tenant policies of 0003.

ALTER TABLE pull_requests ADD COLUMN forge_updated_at timestamptz;

ALTER TABLE pr_revisions
  ADD COLUMN diff_bytes      integer CHECK (diff_bytes >= 0),
  ADD COLUMN diff_sha256     bytea   CHECK (octet_length(diff_sha256) = 32),
  ADD COLUMN diff_truncation text    CHECK (diff_truncation IN ('max_bytes', 'forge_limit', 'unavailable')),
  ADD CONSTRAINT pr_revisions_diff_pair CHECK ((diff_bytes IS NULL) = (diff_sha256 IS NULL)),
  -- The flag 0002 introduced is set exactly when a reason is recorded.
  ADD CONSTRAINT pr_revisions_diff_truncation_flag
    CHECK (diff_truncated = (diff_truncation IS NOT NULL)),
  -- A reason only for a diff that was read.
  ADD CONSTRAINT pr_revisions_diff_truncation_read
    CHECK (diff_truncation IS NULL OR diff_bytes IS NOT NULL);
