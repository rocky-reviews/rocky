-- 0022 repository index (P9-1, ADR 0040).
--
-- Five parts:
--   1. Inbox: `repository.push` deliveries (pushes to a default branch: ids and the new head).
--   2. code_indexes: one row per repository, the index's state and its job (queued, running under
--      a lease, done, failed, over_limit), the commit and the embedding space it holds.
--   3. code_files and code_chunks: what was indexed, from which blob, cut where. No code text:
--      paths, blob ids, line ranges, node kinds and a sha256 per chunk (ADR 0040 §5).
--   4. embeddings: the vector column settled at vector(1024) with the space stored on every row
--      (provider, model, dimensions), a link to a code chunk, and one HNSW index (ADR 0040 §3).
--      Nothing wrote embeddings before P9-1 (P8 never did); any row left is derived data and is
--      dropped, since a 1536-wide vector cannot become a 1024-wide one.
--   5. worker.claim_code_indexes: the cross-org claim, SECURITY DEFINER owned by
--      rocky_lifecycle, executable by rocky_worker only; one running index per org at a time.
--
-- Tenant tables get RLS (FORCE) with the tenant policy, composite (org_id, id) foreign keys and
-- cascades, like every other (0003). rocky_app gets DML on them; the worker writes through it.

-- --- 1. Inbox -------------------------------------------------------------------------------------

ALTER TABLE app.webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE app.webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check
  CHECK (event_type IN (
    'installation.created', 'installation.deleted',
    'pull_request.opened', 'pull_request.synchronize',
    'pull_request.closed', 'pull_request.reopened',
    'org_member.removed',
    'repository.push'));

-- The shape `minimalEvent` (packages/db) accepts: a repository id and a head object id.
ALTER TABLE app.webhook_deliveries ADD CONSTRAINT webhook_deliveries_repository_shape CHECK (
  event_type NOT LIKE 'repository.%' OR CASE
    WHEN jsonb_typeof(event -> 'repositoryId') IS DISTINCT FROM 'number' THEN false
    WHEN (event ->> 'repositoryId') !~ '^[1-9][0-9]{0,15}$' THEN false
    WHEN (event ->> 'repositoryId')::numeric > 9007199254740991 THEN false
    WHEN jsonb_typeof(event -> 'headSha') IS DISTINCT FROM 'string' THEN false
    ELSE (event ->> 'headSha') ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  END);

-- --- 2. code_indexes ------------------------------------------------------------------------------

CREATE TABLE code_indexes (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  repo_id               uuid        NOT NULL,
  status                text        NOT NULL DEFAULT 'queued'
                                    CHECK (status IN ('queued', 'running', 'done', 'failed', 'over_limit')),
  -- The commit a push asked for; null: the default branch's head when the run starts.
  requested_sha         text        CHECK (requested_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- Bumped by every enqueue; a run that finishes behind a newer request queues itself again.
  generation            integer     NOT NULL DEFAULT 1 CHECK (generation >= 1),
  -- The commit the stored chunks were read from, and the space their vectors are in.
  indexed_sha           text        CHECK (indexed_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  embedding_provider    text        CHECK (embedding_provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  embedding_model       text        CHECK (embedding_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  embedding_dimensions  integer     CHECK (embedding_dimensions BETWEEN 1 AND 1024),
  attempts              integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at          timestamptz NOT NULL DEFAULT now(),
  claimed_at            timestamptz,
  lease_id              uuid,
  lease_until           timestamptz,
  error_code            text        CHECK (error_code ~ '^(?:[0-9A-Z]{5}|[a-z][a-z0-9_]{0,63})$'),
  -- The last run's size: estimate and limit (over_limit), files and chunks it wrote, tokens it spent.
  estimated_tokens      integer     CHECK (estimated_tokens >= 0),
  limit_tokens          integer     CHECK (limit_tokens > 0),
  -- "Index anyway": a person allowed one run up to this many tokens.
  approved_tokens       integer     CHECK (approved_tokens > 0),
  files_indexed         integer     NOT NULL DEFAULT 0 CHECK (files_indexed >= 0),
  chunks_indexed        integer     NOT NULL DEFAULT 0 CHECK (chunks_indexed >= 0),
  spent_tokens          integer     NOT NULL DEFAULT 0 CHECK (spent_tokens >= 0),
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_indexes_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT code_indexes_org_repo_unique UNIQUE (org_id, repo_id),
  CONSTRAINT code_indexes_repo_fk FOREIGN KEY (org_id, repo_id) REFERENCES repos (org_id, id) ON DELETE CASCADE,
  CONSTRAINT code_indexes_lease_when_running CHECK (
    (status = 'running') = (lease_id IS NOT NULL)
    AND (lease_id IS NULL) = (lease_until IS NULL)
    AND (lease_id IS NULL OR claimed_at IS NOT NULL)),
  -- The space is known as a whole or not at all.
  CONSTRAINT code_indexes_space_whole CHECK (
    (embedding_provider IS NULL) = (embedding_model IS NULL)
    AND (embedding_model IS NULL) = (embedding_dimensions IS NULL)),
  CONSTRAINT code_indexes_estimate_when_over CHECK (
    status <> 'over_limit' OR (estimated_tokens IS NOT NULL AND limit_tokens IS NOT NULL))
);

CREATE INDEX code_indexes_queued_idx ON code_indexes (available_at, id) WHERE status = 'queued';
CREATE INDEX code_indexes_running_idx ON code_indexes (org_id) WHERE status = 'running';
CREATE INDEX code_indexes_lease_until_idx ON code_indexes (lease_until) WHERE status = 'running';

-- --- 3. code_files and code_chunks ----------------------------------------------------------------

-- A path as the forge lists it: relative, no control characters, bounded (classifyPath, core).
CREATE TABLE code_files (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  repo_id       uuid        NOT NULL,
  path          text        NOT NULL CHECK (
                              octet_length(path) BETWEEN 1 AND 1024
                              AND path !~ '[[:cntrl:]]'
                              AND path !~ '^/'),
  blob_sha      text        NOT NULL CHECK (blob_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  language      text        NOT NULL CHECK (language ~ '^[a-z][a-z0-9_+-]{0,31}$'),
  -- `skipped`: fetched and found binary, generated or empty; kept so it is not fetched again.
  status        text        NOT NULL CHECK (status IN ('indexed', 'skipped')),
  skip_reason   text        CHECK (skip_reason IN ('binary', 'generated', 'empty', 'too_large',
                                                   'unsupported', 'invalid_path', 'vendored')),
  chunk_count   integer     NOT NULL DEFAULT 0 CHECK (chunk_count BETWEEN 0 AND 500),
  indexed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_files_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT code_files_org_repo_path_unique UNIQUE (org_id, repo_id, path),
  CONSTRAINT code_files_repo_fk FOREIGN KEY (org_id, repo_id) REFERENCES repos (org_id, id) ON DELETE CASCADE,
  CONSTRAINT code_files_skip_reason CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CONSTRAINT code_files_skipped_no_chunks CHECK (status = 'indexed' OR chunk_count = 0)
);

CREATE TABLE code_chunks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  repo_id         uuid        NOT NULL,
  file_id         uuid        NOT NULL,
  ordinal         integer     NOT NULL CHECK (ordinal BETWEEN 0 AND 499),
  start_line      integer     NOT NULL CHECK (start_line >= 1),
  end_line        integer     NOT NULL,
  kind            text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- sha256 of the chunk's text: an unchanged chunk keeps its vector; the text is not stored.
  content_sha256  bytea       NOT NULL CHECK (octet_length(content_sha256) = 32),
  CONSTRAINT code_chunks_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT code_chunks_file_ordinal_unique UNIQUE (org_id, file_id, ordinal),
  CONSTRAINT code_chunks_lines CHECK (end_line >= start_line),
  CONSTRAINT code_chunks_repo_fk FOREIGN KEY (org_id, repo_id) REFERENCES repos (org_id, id) ON DELETE CASCADE,
  CONSTRAINT code_chunks_file_fk FOREIGN KEY (org_id, file_id) REFERENCES code_files (org_id, id) ON DELETE CASCADE
);

CREATE INDEX code_chunks_org_file_idx ON code_chunks (org_id, file_id);
CREATE INDEX code_chunks_org_repo_hash_idx ON code_chunks (org_id, repo_id, content_sha256);

-- --- 4. embeddings ----------------------------------------------------------------------------------

-- FORCE RLS (0003) hides every row from the owner; lift it for this statement only.
ALTER TABLE embeddings NO FORCE ROW LEVEL SECURITY;
DELETE FROM embeddings;
ALTER TABLE embeddings FORCE ROW LEVEL SECURITY;

ALTER TABLE embeddings
  ALTER COLUMN embedding TYPE vector(1024),
  ADD COLUMN provider       text    NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  ADD COLUMN dimensions     integer NOT NULL CHECK (dimensions BETWEEN 1 AND 1024),
  ADD COLUMN code_chunk_id  uuid,
  ADD CONSTRAINT embeddings_model_shape CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  ADD CONSTRAINT embeddings_code_chunk_fk FOREIGN KEY (org_id, code_chunk_id)
    REFERENCES code_chunks (org_id, id) ON DELETE CASCADE,
  -- A chunk's vector belongs to the chunk's repository and to nothing else.
  ADD CONSTRAINT embeddings_code_chunk_kind CHECK (
    code_chunk_id IS NULL
    OR (source_kind = 'code_chunk' AND memory_entry_id IS NULL AND repo_id IS NOT NULL));

-- One vector per chunk and space; the tenant-and-space filter every search starts from.
CREATE UNIQUE INDEX embeddings_code_chunk_space_unique
  ON embeddings (org_id, code_chunk_id, provider, model, dimensions)
  WHERE code_chunk_id IS NOT NULL;
CREATE INDEX embeddings_code_space_idx
  ON embeddings (org_id, repo_id, provider, model, dimensions)
  WHERE code_chunk_id IS NOT NULL;
-- One approximate index over the one indexed width, for every space (ADR 0040 §3).
CREATE INDEX embeddings_hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops);

-- --- RLS and grants -------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['code_indexes', 'code_files', 'code_chunks']
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

GRANT SELECT, INSERT, UPDATE, DELETE ON code_indexes, code_files, code_chunks TO rocky_app;

-- --- 5. The claim -----------------------------------------------------------------------------------

GRANT SELECT (id, org_id, status, attempts, available_at, lease_id, lease_until, generation,
              error_code)
  ON code_indexes TO rocky_lifecycle;
GRANT UPDATE (status, attempts, available_at, claimed_at, lease_id, lease_until, error_code,
              completed_at, updated_at)
  ON code_indexes TO rocky_lifecycle;
CREATE POLICY code_indexes_lifecycle_select ON code_indexes FOR SELECT TO rocky_lifecycle USING (true);
CREATE POLICY code_indexes_lifecycle_update ON code_indexes FOR UPDATE TO rocky_lifecycle
  USING (true) WITH CHECK (true);

-- Claims up to p_limit queued index runs for p_lease_seconds (clamped to 1..20 rows, 60..3600 s):
--   * one claim at a time across workers (transaction advisory lock);
--   * expired leases first: back to `queued`, or `failed` as `lease_expired` after 5 claims;
--   * at most one running index per org (an org's other repositories wait their turn), oldest
--     request first, orgs being erased or scheduled for deletion skipped;
--   * exactly the candidate row, or nothing (FOR UPDATE SKIP LOCKED).
CREATE FUNCTION worker.claim_code_indexes(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (org_id uuid, index_id uuid, lease_id uuid, attempts integer, generation integer,
                 lease_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 20);
  v_lease interval := make_interval(
    secs => least(greatest(coalesce(p_lease_seconds, 1800), 60), 3600));
  v_start timestamptz;
  v_now timestamptz;
  v_claimed integer := 0;
  v_orgs uuid[] := '{}';
  c record;
  r record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rocky.worker.claim_code_indexes', 0));
  v_start := clock_timestamp();

  UPDATE public.code_indexes i
     SET status = CASE WHEN i.attempts >= 5 THEN 'failed' ELSE 'queued' END,
         error_code = CASE WHEN i.attempts >= 5 THEN 'lease_expired' ELSE i.error_code END,
         completed_at = CASE WHEN i.attempts >= 5 THEN v_start END,
         lease_id = NULL,
         lease_until = NULL,
         available_at = v_start,
         updated_at = v_start
   WHERE i.status = 'running' AND i.lease_until <= v_start;

  FOR c IN
    SELECT q.id AS c_id, q.org_id AS c_org
      FROM public.code_indexes q
      JOIN public.orgs o ON o.id = q.org_id
     WHERE q.status = 'queued' AND q.available_at <= v_start
       AND o.erasing_at IS NULL AND o.delete_after IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.code_indexes x
                        WHERE x.org_id = q.org_id AND x.status = 'running')
     ORDER BY q.available_at, q.id
     LIMIT v_limit * 4
  LOOP
    EXIT WHEN v_claimed >= v_limit;
    CONTINUE WHEN c.c_org = ANY (v_orgs);
    PERFORM 1 FROM public.code_indexes i WHERE i.id = c.c_id AND i.status = 'queued'
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_now := clock_timestamp();
    UPDATE public.code_indexes i
       SET status = 'running',
           attempts = i.attempts + 1,
           claimed_at = v_now,
           lease_id = gen_random_uuid(),
           lease_until = v_now + v_lease,
           updated_at = v_now
     WHERE i.id = c.c_id AND i.status = 'queued'
    RETURNING i.org_id AS r_org, i.id AS r_id, i.lease_id AS r_token, i.attempts AS r_attempts,
              i.generation AS r_generation, i.lease_until AS r_until
      INTO r;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_orgs := v_orgs || r.r_org;
    org_id := r.r_org;
    index_id := r.r_id;
    lease_id := r.r_token;
    attempts := r.r_attempts;
    generation := r.r_generation;
    lease_until := r.r_until;
    RETURN NEXT;
    v_claimed := v_claimed + 1;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION worker.claim_code_indexes(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker.claim_code_indexes(integer, integer) TO rocky_worker;
GRANT CREATE ON SCHEMA worker TO rocky_lifecycle;
ALTER FUNCTION worker.claim_code_indexes(integer, integer) OWNER TO rocky_lifecycle;
REVOKE CREATE ON SCHEMA worker FROM rocky_lifecycle;
