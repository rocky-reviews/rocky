-- 0003 row-level security and application grants (P2-2, ADR 0003).
--
-- For every tenant table: enable RLS, FORCE it (so the owner is subject to it too), one policy
-- for the application role that filters reads and checks writes against the current tenant,
-- and exactly the DML privileges the application needs. There is no policy for PUBLIC and no
-- permissive fallback: a role without a policy sees nothing.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'members', 'repos', 'pull_requests', 'pr_revisions', 'analyses', 'findings_state',
    'comments_pending', 'memory_entries', 'embeddings', 'audit_events', 'llm_usage', 'jobs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO rocky_app
         USING (org_id = app.current_org_id())
         WITH CHECK (org_id = app.current_org_id())',
      t || '_tenant', t);
  END LOOP;
END
$$;

-- orgs is the tenant root: its tenant column is `id`.
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
CREATE POLICY orgs_tenant ON orgs FOR ALL TO rocky_app
  USING (id = app.current_org_id())
  WITH CHECK (id = app.current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  orgs, members, repos, pull_requests, pr_revisions, analyses, findings_state,
  comments_pending, memory_entries, embeddings, llm_usage, jobs
TO rocky_app;

-- Append-only for the application (trigger in 0004 adds the same rule for everyone else).
GRANT SELECT, INSERT ON audit_events TO rocky_app;
