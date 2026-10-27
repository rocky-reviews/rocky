DROP FUNCTION IF EXISTS worker.claim_analyses(integer, integer, integer);
DROP POLICY IF EXISTS analyses_lifecycle_update ON analyses;
DROP POLICY IF EXISTS analyses_lifecycle_select ON analyses;
REVOKE SELECT (id, org_id, status, attempts, available_at, created_at, claimed_at, lease_id,
               lease_until, error_code) ON analyses FROM rocky_lifecycle;
REVOKE UPDATE (status, attempts, available_at, claimed_at, lease_id, lease_until, error_code,
               completed_at) ON analyses FROM rocky_lifecycle;

DROP INDEX IF EXISTS analyses_lease_until_idx;
DROP INDEX IF EXISTS analyses_org_claimed_idx;
DROP INDEX IF EXISTS analyses_running_org_idx;
DROP INDEX IF EXISTS analyses_queued_idx;
DROP INDEX IF EXISTS analyses_live_revision_unique;

-- The 0002 states only: a row waiting for approval was never analysed (failed, no document).
ALTER TABLE analyses NO FORCE ROW LEVEL SECURITY;
UPDATE analyses
   SET status = 'failed', error_code = 'over_token_limit', completed_at = now(),
       lease_id = NULL, lease_until = NULL
 WHERE status = 'awaiting_approval';
ALTER TABLE analyses FORCE ROW LEVEL SECURITY;

ALTER TABLE analyses
  DROP CONSTRAINT IF EXISTS analyses_approved_by_fk,
  DROP CONSTRAINT IF EXISTS analyses_approval_pair,
  DROP CONSTRAINT IF EXISTS analyses_estimate_when_awaiting,
  DROP CONSTRAINT IF EXISTS analyses_lease_when_running,
  DROP CONSTRAINT IF EXISTS analyses_status_check,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_tokens,
  DROP COLUMN IF EXISTS limit_tokens,
  DROP COLUMN IF EXISTS estimated_tokens,
  DROP COLUMN IF EXISTS lease_until,
  DROP COLUMN IF EXISTS lease_id,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS available_at,
  DROP COLUMN IF EXISTS attempts;
ALTER TABLE analyses
  ADD CONSTRAINT analyses_status_check CHECK (status IN ('queued', 'running', 'done', 'failed'));
