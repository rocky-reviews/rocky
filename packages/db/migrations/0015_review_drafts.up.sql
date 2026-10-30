-- 0015 review drafts (P6-4, ADR 0027).
--
-- What a reviewer decided about each AI draft, and the comments they will post, kept on the
-- server so a refresh (or another device) shows the same review. Both tables exist since 0002;
-- this makes them fit the drafts:
--
--   * findings_state is per reviewer: one row per (analysis, member, finding). Two people
--     reviewing the same PR each decide for themselves ("only you can see this until you accept
--     it"). A dismissal stores a fixed reason code (no free text), which project memory (P8) can
--     learn from later; nothing reads it yet. `agent_prompt_copied_at` notes "Send to agent".
--   * comments_pending is exactly what Finish review (P6-6) will post as the reviewer (P3-5): the
--     reviewer's own comments (`source = 'own'`) and accepted drafts (`ai`, or `ai_edited` when
--     the reviewer rewrote the body), each with its final body and new-side location
--     (`path`, `start_line`..`line`). An accepted draft has exactly one row, written in the same
--     transaction as its decision and deleted by its undo.
--   * Both belong to the analysis the reviewer saw (`analysis_id`); deleting the analysis
--     (retention) deletes them.
--
-- No grants or policies change: rocky_app keeps its DML under the tenant policies of 0003.

-- --- findings_state: per reviewer ---------------------------------------------------------------

ALTER TABLE findings_state ADD COLUMN member_id uuid;

-- A row nobody owns cannot be shown to anyone (0002 never wrote one); the decider owns the rest.
-- FORCE RLS hides every row from the owner, so it is lifted for these statements only.
ALTER TABLE findings_state NO FORCE ROW LEVEL SECURITY;
UPDATE findings_state SET member_id = decided_by WHERE member_id IS NULL;
DELETE FROM findings_state WHERE member_id IS NULL;
ALTER TABLE findings_state FORCE ROW LEVEL SECURITY;

ALTER TABLE findings_state
  ALTER COLUMN member_id SET NOT NULL,
  ADD COLUMN agent_prompt_copied_at timestamptz,
  ADD CONSTRAINT findings_state_member_fk FOREIGN KEY (org_id, member_id)
    REFERENCES members (org_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT findings_state_org_analysis_finding_unique,
  ADD CONSTRAINT findings_state_org_analysis_member_finding_unique
    UNIQUE (org_id, analysis_id, member_id, finding_id),
  -- The schema's `Id` (packages/schema primitives).
  ADD CONSTRAINT findings_state_finding_id_shape
    CHECK (finding_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  ADD CONSTRAINT findings_state_reason_code
    CHECK (reason IS NULL OR reason IN ('not_an_issue', 'intentional', 'not_worth_it', 'handled_elsewhere')),
  ADD CONSTRAINT findings_state_reason_only_dismissed CHECK (state = 'dismissed' OR reason IS NULL);

-- --- comments_pending: what will be posted ------------------------------------------------------

ALTER TABLE comments_pending
  ADD COLUMN analysis_id uuid,
  ADD COLUMN source      text    NOT NULL DEFAULT 'own',
  ADD COLUMN start_line  integer,
  ADD CONSTRAINT comments_pending_source_check CHECK (source IN ('own', 'ai', 'ai_edited')),
  ADD CONSTRAINT comments_pending_analysis_fk FOREIGN KEY (org_id, analysis_id)
    REFERENCES analyses (org_id, id) ON DELETE CASCADE,
  -- A comment is from a draft exactly when it names its finding, and a draft has an analysis.
  ADD CONSTRAINT comments_pending_finding_source CHECK ((finding_id IS NULL) = (source = 'own')),
  ADD CONSTRAINT comments_pending_draft_has_analysis
    CHECK (finding_id IS NULL OR analysis_id IS NOT NULL),
  ADD CONSTRAINT comments_pending_start_line
    CHECK (start_line IS NULL OR (line IS NOT NULL AND start_line > 0 AND start_line < line)),
  -- GitHub's limit for a review comment body.
  ADD CONSTRAINT comments_pending_body_length CHECK (char_length(body) BETWEEN 1 AND 65536),
  ADD CONSTRAINT comments_pending_one_per_draft UNIQUE (org_id, author_id, analysis_id, finding_id);

CREATE INDEX comments_pending_org_analysis_author_idx
  ON comments_pending (org_id, analysis_id, author_id);
