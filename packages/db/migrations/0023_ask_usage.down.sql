-- Back to the 0011 shape: the server's grant and policy go, the link columns go with their
-- usage (rows keep everything else), and the trigger allows only the analysis unlink again.

DROP POLICY llm_usage_server_roles ON llm_usage;
REVOKE INSERT ON llm_usage FROM rocky_app;

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
  -- The analyses foreign key is ON DELETE SET NULL (analysis_id): purging an analysis unlinks
  -- its usage and keeps it. That update, and only that one, is allowed.
  IF TG_OP = 'UPDATE' AND OLD.analysis_id IS NOT NULL AND NEW.analysis_id IS NULL THEN
    unlinked := OLD;
    unlinked.analysis_id := NULL;
    IF NEW IS NOT DISTINCT FROM unlinked THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'llm_usage is append-only: % blocked for role %', TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Usage rows are removed only by retention (purge_llm_usage, delete_org).';
END
$$;

DROP INDEX llm_usage_org_repo_idx;
ALTER TABLE llm_usage
  DROP CONSTRAINT llm_usage_pull_request_has_repo,
  DROP CONSTRAINT llm_usage_pull_request_fk,
  DROP CONSTRAINT llm_usage_repo_fk,
  DROP COLUMN pull_request_id,
  DROP COLUMN repo_id;
