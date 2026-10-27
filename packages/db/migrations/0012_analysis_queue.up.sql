-- 0012 analysis queue lane (P4-6, ADR 0017).
--
-- The worker runs analyses from a queue: `queued` rows are claimed with a lease, run, and
-- finished. Four parts:
--   1. Lease and retry state on `analyses`: `attempts` (claims so far), `available_at` (not
--      claimable before; the retry backoff), `claimed_at` (the last claim), `lease_id` and
--      `lease_until` (held while `running`, by exactly one worker). Only the holder of the token
--      can finish, requeue, hold or renew a row (packages/db/src/analyses.ts). An expired lease
--      (the worker crashed, or failing the row failed too) is reclaimed by the next claim: back to
--      `queued`, or `failed` as `lease_expired` once its attempts are used up (ADR 0014 R3).
--   2. The per-PR token limit: a new state `awaiting_approval` with the estimate and the limit
--      it exceeded, and the "Analyze anyway" approval (`approved_tokens`, `approved_by`,
--      `approved_at`) on that row only; a new push is a new revision and a new row, estimated
--      again. Counts, ids and times only.
--   3. One live analysis per revision (partial unique index): the mirror and the rebuild can
--      both enqueue a head revision without paying for it twice.
--   4. The claim: worker.claim_analyses, SECURITY DEFINER owned by rocky_lifecycle, executable by
--      rocky_worker only (the server cannot claim). Fair across orgs: a per-org cap on running
--      rows, and a round-robin order (an org's k-th waiting row goes after every other org's
--      (k-1)-th), so one org's backlog cannot starve another. One claim at a time (advisory
--      lock), so the cap holds across workers; bounded work per claim (orgs with work × cap).
--
-- No new grants for rocky_app (it already has DML on analyses under its tenant policy, 0003).
-- rocky_lifecycle reads analyses and updates only the queue columns, through the claim alone.

-- --- 1, 2. Columns ------------------------------------------------------------------------------

-- Nothing ran analyses before 0012, so a `running` row has no lease to honour: queue it again.
-- FORCE RLS (0003) hides every row from the owner, which would make this a silent no-op; lift it
-- for this statement only, inside the migration's transaction.
ALTER TABLE analyses NO FORCE ROW LEVEL SECURITY;
UPDATE analyses SET status = 'queued' WHERE status = 'running';
ALTER TABLE analyses FORCE ROW LEVEL SECURITY;

ALTER TABLE analyses DROP CONSTRAINT analyses_status_check;
ALTER TABLE analyses
  ADD CONSTRAINT analyses_status_check
    CHECK (status IN ('queued', 'running', 'awaiting_approval', 'done', 'failed')),
  ADD COLUMN attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN available_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN claimed_at       timestamptz,
  ADD COLUMN lease_id      uuid,
  ADD COLUMN lease_until      timestamptz,
  ADD COLUMN estimated_tokens integer CHECK (estimated_tokens >= 0),
  ADD COLUMN limit_tokens      integer CHECK (limit_tokens > 0),
  ADD COLUMN approved_tokens  integer CHECK (approved_tokens >= 0),
  ADD COLUMN approved_by      uuid,
  ADD COLUMN approved_at      timestamptz,
  -- A lease exists exactly while the row runs, and always with its deadline and claim time.
  ADD CONSTRAINT analyses_lease_when_running CHECK (
    (status = 'running') = (lease_id IS NOT NULL)
    AND (lease_id IS NULL) = (lease_until IS NULL)
    AND (lease_id IS NULL OR claimed_at IS NOT NULL)),
  -- A row waiting for approval says what it was estimated at and which limit it exceeded.
  ADD CONSTRAINT analyses_estimate_when_awaiting CHECK (
    status <> 'awaiting_approval' OR (estimated_tokens IS NOT NULL AND limit_tokens IS NOT NULL)),
  -- An approval is a size and a time; the approver may be erased later (SET NULL below).
  ADD CONSTRAINT analyses_approval_pair CHECK ((approved_tokens IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT analyses_approved_by_fk FOREIGN KEY (org_id, approved_by)
    REFERENCES members (org_id, id) ON DELETE SET NULL (approved_by);

-- --- 3. Indexes ---------------------------------------------------------------------------------

CREATE UNIQUE INDEX analyses_live_revision_unique ON analyses (org_id, revision_id)
  WHERE status IN ('queued', 'running', 'awaiting_approval');
-- The claim: orgs with waiting rows (a skip scan on the leading org_id) and each org's oldest.
CREATE INDEX analyses_queued_idx ON analyses (org_id, available_at, created_at, id)
  WHERE status = 'queued';
-- Running rows per org (the cap) and expired leases (the reclaim).
CREATE INDEX analyses_running_org_idx ON analyses (org_id) WHERE status = 'running';
CREATE INDEX analyses_lease_until_idx ON analyses (lease_until) WHERE status = 'running';

-- --- 4. The claim -------------------------------------------------------------------------------

GRANT SELECT ON analyses TO rocky_lifecycle;
GRANT UPDATE (status, attempts, available_at, claimed_at, lease_id, lease_until, error_code,
              completed_at) ON analyses TO rocky_lifecycle;
CREATE POLICY analyses_lifecycle_select ON analyses FOR SELECT TO rocky_lifecycle USING (true);
CREATE POLICY analyses_lifecycle_update ON analyses FOR UPDATE TO rocky_lifecycle
  USING (true) WITH CHECK (true);

-- Claims up to p_limit queued rows across orgs for p_lease_seconds, at most p_org_cap running
-- per org (clamped to 1..100 rows, 30..3600 s, 1..100 per org). In order:
--   * one claim at a time across workers (transaction advisory lock), so the per-org cap cannot
--     race; the caller bounds the wait with a statement timeout;
--   * expired leases are reclaimed first: back to `queued` (claimable now), or `failed` as
--     `lease_expired` once ANALYSIS_MAX_ATTEMPTS (5) claims have been used;
--   * candidates: for each org with waiting rows (not being erased, not scheduled for deletion),
--     its oldest claimable rows, as many as its free slots (cap − running). Each gets a round:
--     running + its rank in the org. Rows are handed out by round, then age: every org's next
--     row comes before any org's row after it, so a backlog of 50 in one org delays another
--     org's first row by at most one row per org with work;
--   * exactly the candidate row, or nothing (FOR UPDATE SKIP LOCKED: a row an approval or a
--     finishing worker holds is left for the next claim);
--   * the lease runs from clock_timestamp(), the moment of the claim.
CREATE FUNCTION worker.claim_analyses(p_limit integer, p_lease_seconds integer, p_org_cap integer)
  RETURNS TABLE (org_id uuid, analysis_id uuid, lease_id uuid, attempts integer,
                 lease_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 100);
  v_cap integer := least(greatest(coalesce(p_org_cap, 1), 1), 100);
  v_lease interval := make_interval(
    secs => least(greatest(coalesce(p_lease_seconds, 600), 30), 3600));
  v_start timestamptz;
  v_now timestamptz;
  v_claimed integer := 0;
  c record;
  r record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rocky.worker.claim_analyses', 0));
  v_start := clock_timestamp();

  UPDATE public.analyses a
     SET status = CASE WHEN a.attempts >= 5 THEN 'failed' ELSE 'queued' END,
         error_code = CASE WHEN a.attempts >= 5 THEN 'lease_expired' ELSE a.error_code END,
         completed_at = CASE WHEN a.attempts >= 5 THEN v_start END,
         lease_id = NULL,
         lease_until = NULL,
         available_at = v_start
   WHERE a.status = 'running' AND a.lease_until <= v_start;

  FOR c IN
    WITH RECURSIVE waiting(org) AS (
      (SELECT q.org_id FROM public.analyses q WHERE q.status = 'queued' ORDER BY q.org_id LIMIT 1)
      UNION ALL
      SELECT (SELECT q.org_id FROM public.analyses q
               WHERE q.status = 'queued' AND q.org_id > w.org ORDER BY q.org_id LIMIT 1)
        FROM waiting w WHERE w.org IS NOT NULL
    ),
    ready AS (
      SELECT w.org,
             (SELECT count(*) FROM public.analyses x
               WHERE x.org_id = w.org AND x.status = 'running')::integer AS busy
        FROM waiting w
        JOIN public.orgs o ON o.id = w.org
       WHERE w.org IS NOT NULL AND o.erasing_at IS NULL AND o.delete_after IS NULL
    )
    SELECT k.id AS c_id, k.round AS c_round
      FROM ready r
      CROSS JOIN LATERAL (
        SELECT q.id, q.available_at, q.created_at,
               r.busy + row_number() OVER (ORDER BY q.available_at, q.created_at, q.id) AS round
          FROM public.analyses q
         WHERE q.org_id = r.org AND q.status = 'queued' AND q.available_at <= v_start
         ORDER BY q.available_at, q.created_at, q.id
         LIMIT least(greatest(v_cap - r.busy, 0), v_limit)) k
     ORDER BY k.round, k.available_at, k.created_at, k.id
  LOOP
    EXIT WHEN v_claimed >= v_limit;
    PERFORM 1 FROM public.analyses a WHERE a.id = c.c_id AND a.status = 'queued'
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_now := clock_timestamp();
    UPDATE public.analyses a
       SET status = 'running',
           attempts = a.attempts + 1,
           claimed_at = v_now,
           lease_id = gen_random_uuid(),
           lease_until = v_now + v_lease
     WHERE a.id = c.c_id AND a.status = 'queued'
    RETURNING a.org_id AS r_org, a.id AS r_id, a.lease_id AS r_token,
              a.attempts AS r_attempts, a.lease_until AS r_until
      INTO r;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    org_id := r.r_org;
    analysis_id := r.r_id;
    lease_id := r.r_token;
    attempts := r.r_attempts;
    lease_until := r.r_until;
    RETURN NEXT;
    v_claimed := v_claimed + 1;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION worker.claim_analyses(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker.claim_analyses(integer, integer, integer) TO rocky_worker;
GRANT CREATE ON SCHEMA worker TO rocky_lifecycle;
ALTER FUNCTION worker.claim_analyses(integer, integer, integer) OWNER TO rocky_lifecycle;
REVOKE CREATE ON SCHEMA worker FROM rocky_lifecycle;
