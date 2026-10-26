DO $$
BEGIN
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END
$$;

DROP POLICY IF EXISTS orgs_app_no_delete ON orgs;

REVOKE ALL ON
  orgs, members, repos, pull_requests, pr_revisions, analyses, findings_state,
  comments_pending, memory_entries, embeddings, audit_events, llm_usage, jobs
FROM rocky_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orgs', 'members', 'repos', 'pull_requests', 'pr_revisions', 'analyses', 'findings_state',
    'comments_pending', 'memory_entries', 'embeddings', 'audit_events', 'llm_usage', 'jobs'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant', t);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
