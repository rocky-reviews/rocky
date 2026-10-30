-- Reverts 0015. Pending comments from drafts go (0002's table had no way to tell them apart),
-- and findings_state goes back to one row per (analysis, finding): when several reviewers
-- decided the same finding, the oldest row is kept. FORCE RLS hides every row from the owner,
-- so it is lifted for the data statements only (0012's pattern).

DROP INDEX comments_pending_org_analysis_author_idx;
ALTER TABLE comments_pending NO FORCE ROW LEVEL SECURITY;
DELETE FROM comments_pending WHERE source <> 'own';
ALTER TABLE comments_pending FORCE ROW LEVEL SECURITY;
ALTER TABLE comments_pending
  DROP CONSTRAINT comments_pending_one_per_draft,
  DROP CONSTRAINT comments_pending_body_length,
  DROP CONSTRAINT comments_pending_start_line,
  DROP CONSTRAINT comments_pending_draft_has_analysis,
  DROP CONSTRAINT comments_pending_finding_source,
  DROP CONSTRAINT comments_pending_analysis_fk,
  DROP CONSTRAINT comments_pending_source_check,
  DROP COLUMN start_line,
  DROP COLUMN source,
  DROP COLUMN analysis_id;

ALTER TABLE findings_state NO FORCE ROW LEVEL SECURITY;
DELETE FROM findings_state a USING findings_state b
 WHERE a.org_id = b.org_id AND a.analysis_id = b.analysis_id AND a.finding_id = b.finding_id
   AND (a.created_at, a.id) > (b.created_at, b.id);
UPDATE findings_state SET decided_by = member_id WHERE state <> 'draft' AND decided_by IS NULL;
ALTER TABLE findings_state FORCE ROW LEVEL SECURITY;
ALTER TABLE findings_state
  DROP CONSTRAINT findings_state_reason_only_dismissed,
  DROP CONSTRAINT findings_state_reason_code,
  DROP CONSTRAINT findings_state_finding_id_shape,
  DROP CONSTRAINT findings_state_org_analysis_member_finding_unique,
  ADD CONSTRAINT findings_state_org_analysis_finding_unique UNIQUE (org_id, analysis_id, finding_id),
  DROP CONSTRAINT findings_state_member_fk,
  DROP COLUMN agent_prompt_copied_at,
  DROP COLUMN member_id;
