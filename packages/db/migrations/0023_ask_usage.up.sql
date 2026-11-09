-- 0023 Ask usage in the ledger (P9-3, ADR 0042 §4; amends 0011 / ADR 0016).
--
-- Ask (P9-2) makes model and embedding calls from the server, which until now could only read
-- llm_usage: the worker inserted (it made every call) and the server's records went to a log
-- line. Three parts:
--   1. Columns: the repository and the pull request a call was made for (nullable; analysis
--      calls keep their analysis_id, and the index run's embeddings may name their repository).
--      Composite foreign keys with ON DELETE SET NULL, like analysis_id: the ledger survives
--      what it was made for (billing reconciles from it).
--   2. Append-only kept: the one UPDATE the trigger allows is now "unlink", setting any of
--      analysis_id, repo_id or pull_request_id to NULL and changing nothing else, which is what a
--      foreign key's SET NULL does.
--   3. The server's grant, as narrow as the ledger allows: INSERT on the columns a usage row
--      needs minus org_id (the tenant's default, FORCE RLS checks it) and analysis_id (the server
--      makes no analysis call), and a RESTRICTIVE policy that lets a login without rocky_worker
--      insert only `ask` and `embed` rows with no analysis link. The worker keeps its table
--      grant; the tenant policy (0003) still applies to both.

-- --- 1. Columns ----------------------------------------------------------------------------------

ALTER TABLE llm_usage
  ADD COLUMN repo_id          uuid,
  ADD COLUMN pull_request_id  uuid,
  ADD CONSTRAINT llm_usage_repo_fk FOREIGN KEY (org_id, repo_id)
    REFERENCES repos (org_id, id) ON DELETE SET NULL (repo_id),
  ADD CONSTRAINT llm_usage_pull_request_fk FOREIGN KEY (org_id, pull_request_id)
    REFERENCES pull_requests (org_id, id) ON DELETE SET NULL (pull_request_id),
  -- A pull request is named with its repository, or not at all.
  ADD CONSTRAINT llm_usage_pull_request_has_repo
    CHECK (pull_request_id IS NULL OR repo_id IS NOT NULL);

-- Usage per repository (billing and the usage display, P11); analysis rows are reached through
-- llm_usage_org_analysis_idx.
CREATE INDEX llm_usage_org_repo_idx ON llm_usage (org_id, repo_id) WHERE repo_id IS NOT NULL;

-- --- 2. Append-only ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.llm_usage_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  unlinked public.llm_usage;
BEGIN
  -- Retention deletes run as rocky_retention inside its SECURITY DEFINER functions, called by
  -- the server or worker login. The owner can also SET ROLE rocky_retention (it is a member: it
  -- hands functions over to it), so the session's login must not be the table owner or one of
  -- its members: that keeps "only the purge and the erasure delete" true for the owner too.
  IF TG_OP = 'DELETE' AND current_user = 'rocky_retention'
     AND NOT pg_has_role(session_user,
                         (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    RETURN OLD;
  END IF;
  -- The link columns' foreign keys are ON DELETE SET NULL: purging an analysis, a repository or
  -- a pull request unlinks its usage and keeps it. That update, setting one or more links to
  -- NULL and nothing else, is the only one allowed.
  IF TG_OP = 'UPDATE' THEN
    unlinked := OLD;
    IF NEW.analysis_id IS NULL THEN unlinked.analysis_id := NULL; END IF;
    IF NEW.repo_id IS NULL THEN unlinked.repo_id := NULL; END IF;
    IF NEW.pull_request_id IS NULL THEN unlinked.pull_request_id := NULL; END IF;
    IF NEW IS DISTINCT FROM OLD AND NEW IS NOT DISTINCT FROM unlinked THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'llm_usage is append-only: % blocked for role %', TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Usage rows are removed only by retention (purge_llm_usage, delete_org).';
END
$$;

-- --- 3. The server's grant -----------------------------------------------------------------------

GRANT INSERT (call_id, attempt, role, provider, model, outcome, error_kind, usage_status,
              input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens,
              cache_write_1h_tokens, cost_micro_usd, cost_status, price_version,
              repo_id, pull_request_id)
  ON llm_usage TO rocky_app;

-- A login that is not the worker records what the server calls: the ask and embed roles, never
-- an analysis. The worker login is a rocky_app member too, so the policy names it explicitly.
CREATE POLICY llm_usage_server_roles ON llm_usage AS RESTRICTIVE FOR INSERT TO rocky_app
  WITH CHECK (pg_has_role(current_user, 'rocky_worker', 'USAGE')
              OR (role IN ('ask', 'embed') AND analysis_id IS NULL));
