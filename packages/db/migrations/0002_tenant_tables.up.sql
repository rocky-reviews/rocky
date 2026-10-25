-- 0002 tenant tables (P2-1).
--
-- Conventions, enforced by src/isolation.test.ts:
--   * every table has `org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE`, defaulting
--     to the current tenant so inserts inside withOrg need not repeat it;
--   * parents expose UNIQUE (org_id, id) and children reference them with composite foreign
--     keys, so a row can never point at another tenant's parent (FK checks ignore RLS);
--   * secrets are `bytea *_ciphertext` + `integer *_key_version` pairs written by
--     packages/crypto (P2-3). There are no plaintext token columns;
--   * free text that came from GitHub (titles, logins, paths, bodies) is untrusted input.
--     It is stored verbatim and must be treated as such when rendered or prompted (P4).

-- One tenant = one forge installation (ADR 0003). `id` defaults to the current tenant: an org
-- is created inside withOrg(newId), which is also the only way the RLS policy lets it in.
CREATE TABLE orgs (
  id                      uuid        PRIMARY KEY DEFAULT app.current_org_id(),
  forge                   text        NOT NULL DEFAULT 'github',
  installation_id         bigint      NOT NULL,
  login                   text        NOT NULL,
  kind                    text        NOT NULL CHECK (kind IN ('organization', 'user')),
  settings                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Per-org data key, wrapped by the root/KMS key (envelope encryption, P2-3).
  data_key_ciphertext     bytea,
  data_key_version        integer,
  -- Bring-your-own LLM key, encrypted with the org data key.
  llm_api_key_ciphertext  bytea,
  llm_api_key_version     integer,
  -- Set on uninstall; the deletion job removes the org after the grace period (P3-3).
  delete_after            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orgs_forge_installation_unique UNIQUE (forge, installation_id),
  CONSTRAINT orgs_data_key_pair CHECK ((data_key_ciphertext IS NULL) = (data_key_version IS NULL)),
  CONSTRAINT orgs_llm_api_key_pair CHECK ((llm_api_key_ciphertext IS NULL) = (llm_api_key_version IS NULL))
);

CREATE TABLE members (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  forge_user_id             bigint      NOT NULL,
  login                     text        NOT NULL,
  role                      text        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  -- The user's own OAuth token, used to post reviews as the user (P3-5).
  forge_token_ciphertext    bytea,
  forge_token_key_version   integer,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT members_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT members_org_forge_user_unique UNIQUE (org_id, forge_user_id),
  CONSTRAINT members_forge_token_pair CHECK ((forge_token_ciphertext IS NULL) = (forge_token_key_version IS NULL))
);

CREATE TABLE repos (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  forge_repo_id   bigint      NOT NULL,
  full_name       text        NOT NULL,
  default_branch  text        NOT NULL DEFAULT 'main',
  private         boolean     NOT NULL DEFAULT true,
  enabled         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repos_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT repos_org_forge_repo_unique UNIQUE (org_id, forge_repo_id)
);

-- Mirror of the forge's pull request (GitHub is the source of truth; this can be rebuilt).
CREATE TABLE pull_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  repo_id       uuid        NOT NULL,
  number        integer     NOT NULL CHECK (number > 0),
  title         text        NOT NULL,
  author_login  text,
  state         text        NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  head_sha      text        NOT NULL,
  base_sha      text        NOT NULL,
  opened_at     timestamptz NOT NULL,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pull_requests_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT pull_requests_org_repo_number_unique UNIQUE (org_id, repo_id, number),
  CONSTRAINT pull_requests_repo_fk FOREIGN KEY (org_id, repo_id) REFERENCES repos (org_id, id) ON DELETE CASCADE
);

-- One row per head commit the PR has had; analyses attach to a revision, not to the PR.
CREATE TABLE pr_revisions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  pull_request_id  uuid        NOT NULL,
  head_sha         text        NOT NULL,
  base_sha         text        NOT NULL,
  diff_truncated   boolean     NOT NULL DEFAULT false,
  stats            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pr_revisions_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT pr_revisions_org_pr_head_unique UNIQUE (org_id, pull_request_id, head_sha),
  CONSTRAINT pr_revisions_pull_request_fk FOREIGN KEY (org_id, pull_request_id) REFERENCES pull_requests (org_id, id) ON DELETE CASCADE
);

-- The validated analysis document (packages/schema) for one revision. Subject to retention.
CREATE TABLE analyses (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  revision_id   uuid        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  document      jsonb,
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  CONSTRAINT analyses_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT analyses_document_when_done CHECK ((status = 'done') = (document IS NOT NULL)),
  CONSTRAINT analyses_revision_fk FOREIGN KEY (org_id, revision_id) REFERENCES pr_revisions (org_id, id) ON DELETE CASCADE
);

-- What the human decided about each AI finding. `finding_id` is the id inside the document.
CREATE TABLE findings_state (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  analysis_id  uuid        NOT NULL,
  finding_id   text        NOT NULL,
  state        text        NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'accepted', 'dismissed')),
  reason       text,
  decided_by   uuid,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT findings_state_org_analysis_finding_unique UNIQUE (org_id, analysis_id, finding_id),
  CONSTRAINT findings_state_dismissed_has_reason CHECK (state <> 'dismissed' OR reason IS NOT NULL),
  CONSTRAINT findings_state_decided_when_not_draft CHECK ((state = 'draft') = (decided_at IS NULL)),
  CONSTRAINT findings_state_analysis_fk FOREIGN KEY (org_id, analysis_id) REFERENCES analyses (org_id, id) ON DELETE CASCADE,
  CONSTRAINT findings_state_decided_by_fk FOREIGN KEY (org_id, decided_by) REFERENCES members (org_id, id) ON DELETE SET NULL (decided_by)
);

-- Review comments a human has drafted but not yet submitted to the forge (P3-5 posts them).
CREATE TABLE comments_pending (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  pull_request_id  uuid        NOT NULL,
  revision_id      uuid        NOT NULL,
  author_id        uuid        NOT NULL,
  finding_id       text,
  path             text,
  line             integer     CHECK (line > 0),
  body             text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_pending_line_needs_path CHECK (line IS NULL OR path IS NOT NULL),
  CONSTRAINT comments_pending_pull_request_fk FOREIGN KEY (org_id, pull_request_id) REFERENCES pull_requests (org_id, id) ON DELETE CASCADE,
  CONSTRAINT comments_pending_revision_fk FOREIGN KEY (org_id, revision_id) REFERENCES pr_revisions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT comments_pending_author_fk FOREIGN KEY (org_id, author_id) REFERENCES members (org_id, id) ON DELETE CASCADE
);

-- Project memory: conventions and decisions the AI should remember (P8). Org-wide when repo_id is null.
CREATE TABLE memory_entries (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  repo_id     uuid,
  kind        text        NOT NULL,
  content     text        NOT NULL,
  source      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_entries_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT memory_entries_repo_fk FOREIGN KEY (org_id, repo_id) REFERENCES repos (org_id, id) ON DELETE CASCADE,
  CONSTRAINT memory_entries_created_by_fk FOREIGN KEY (org_id, created_by) REFERENCES members (org_id, id) ON DELETE SET NULL (created_by)
);

-- Vectors for memory and repo indexing (P8, P9). Dimension and index are settled in P9-1.
CREATE TABLE embeddings (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid          NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  repo_id          uuid,
  memory_entry_id  uuid,
  source_kind      text          NOT NULL,
  source_ref       text          NOT NULL,
  model            text          NOT NULL,
  embedding        vector(1536)  NOT NULL,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT embeddings_repo_fk FOREIGN KEY (org_id, repo_id) REFERENCES repos (org_id, id) ON DELETE CASCADE,
  CONSTRAINT embeddings_memory_entry_fk FOREIGN KEY (org_id, memory_entry_id) REFERENCES memory_entries (org_id, id) ON DELETE CASCADE
);

-- Append-only (trigger in 0004). Identifiers only: never code, diffs, tokens or emails.
CREATE TABLE audit_events (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  actor_type   text        NOT NULL CHECK (actor_type IN ('user', 'system', 'forge')),
  actor_id     text        NOT NULL,
  action       text        NOT NULL,
  target_type  text        NOT NULL,
  target_id    text        NOT NULL,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Metering (P4-5). Survives the purge of its analysis so billing can always be reconciled.
CREATE TABLE llm_usage (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  analysis_id        uuid,
  role               text        NOT NULL,
  provider           text        NOT NULL,
  model              text        NOT NULL,
  input_tokens       integer     NOT NULL CHECK (input_tokens >= 0),
  output_tokens      integer     NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens  integer     NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens integer     NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cost_micro_usd     bigint      NOT NULL CHECK (cost_micro_usd >= 0),
  price_version      text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_usage_analysis_fk FOREIGN KEY (org_id, analysis_id) REFERENCES analyses (org_id, id) ON DELETE SET NULL (analysis_id)
);

-- Rocky's own job ledger (idempotency, status, attempts). pg-boss keeps its queue in its own
-- schema; this is the tenant-scoped record. `payload` and `error` hold identifiers, never
-- secrets, code or diffs. Finished rows are "logs" for retention purposes.
CREATE TABLE jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  kind             text        NOT NULL,
  idempotency_key  text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  CONSTRAINT jobs_org_kind_key_unique UNIQUE (org_id, kind, idempotency_key),
  CONSTRAINT jobs_finished_when_terminal CHECK ((status IN ('done', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

-- Tenant indexes for tables whose unique constraints do not already lead with org_id.
CREATE INDEX comments_pending_org_pr_idx ON comments_pending (org_id, pull_request_id);
CREATE INDEX embeddings_org_repo_idx ON embeddings (org_id, repo_id);
CREATE INDEX audit_events_org_created_idx ON audit_events (org_id, created_at);
CREATE INDEX audit_events_created_idx ON audit_events (created_at);
CREATE INDEX llm_usage_org_created_idx ON llm_usage (org_id, created_at);
CREATE INDEX analyses_created_idx ON analyses (created_at);
CREATE INDEX jobs_finished_idx ON jobs (finished_at) WHERE finished_at IS NOT NULL;
