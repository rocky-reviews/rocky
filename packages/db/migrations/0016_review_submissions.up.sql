-- 0016 review submissions (P3-5, ADR 0026).
--
-- A person posts accepted drafts, their own pending comments and a verdict to the forge as one
-- review, with their own token. These tables make that idempotent and auditable without storing
-- a second copy of the content (the forge is the source of truth):
--
--   * review_submissions: one row per attempt, written **before** the forge is called
--     (`posting`) and finished after (`posted` with the forge's review id, `failed` with a fixed
--     code). `submitted_by` is the member who clicked: NOT NULL, so no row can exist without a
--     person. `idempotency_key` is the client's key for one click: a retry finds the row instead
--     of posting again. One attempt in flight per (pull request, member). The content is kept as
--     sha256 digests and counts only.
--   * review_submission_items: what the attempt carried (the draft state or pending comment id
--     and the sha256 of the body as posted), in order. An item in a `posting` or `posted`
--     submission is never offered for posting again; a `failed` one releases its items.
--
-- Both are tenant tables: RLS forced, the app's policy (as 0003), SELECT/INSERT/UPDATE and no
-- DELETE (the isolation matrix pins the grants). No new roles, no new functions. Retention: a
-- submission lives with its pull request (cascade).

CREATE TABLE review_submissions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  pull_request_id  uuid        NOT NULL,
  revision_id      uuid        NOT NULL,
  submitted_by     uuid        NOT NULL,
  idempotency_key  uuid        NOT NULL,
  head_sha         text        NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  verdict          text        NOT NULL CHECK (verdict IN ('approve', 'request_changes', 'comment')),
  content_sha256   bytea       NOT NULL CHECK (octet_length(content_sha256) = 32),
  body_sha256      bytea       NOT NULL CHECK (octet_length(body_sha256) = 32),
  draft_count      integer     NOT NULL CHECK (draft_count >= 0),
  comment_count    integer     NOT NULL CHECK (comment_count >= 0),
  status           text        NOT NULL DEFAULT 'posting' CHECK (status IN ('posting', 'posted', 'failed')),
  forge_review_id  bigint      CHECK (forge_review_id > 0),
  error_code       text        CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CONSTRAINT review_submissions_idempotency_unique UNIQUE (org_id, idempotency_key),
  CONSTRAINT review_submissions_org_id_unique UNIQUE (org_id, id),
  CONSTRAINT review_submissions_posted_has_review
    CHECK ((status = 'posted') = (forge_review_id IS NOT NULL)),
  CONSTRAINT review_submissions_failed_has_code
    CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT review_submissions_finished_when_not_posting
    CHECK ((status = 'posting') = (finished_at IS NULL)),
  CONSTRAINT review_submissions_pull_request_fk
    FOREIGN KEY (org_id, pull_request_id) REFERENCES pull_requests (org_id, id) ON DELETE CASCADE,
  CONSTRAINT review_submissions_revision_fk
    FOREIGN KEY (org_id, revision_id) REFERENCES pr_revisions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT review_submissions_submitted_by_fk
    FOREIGN KEY (org_id, submitted_by) REFERENCES members (org_id, id) ON DELETE CASCADE
);

-- One attempt in flight per person and pull request: a second click while the first is still
-- being posted is refused by the database, whatever the server's own checks saw.
CREATE UNIQUE INDEX review_submissions_in_flight_unique
  ON review_submissions (org_id, pull_request_id, submitted_by) WHERE status = 'posting';
CREATE INDEX review_submissions_org_pr_idx ON review_submissions (org_id, pull_request_id);

CREATE TABLE review_submission_items (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid    NOT NULL DEFAULT app.current_org_id() REFERENCES orgs (id) ON DELETE CASCADE,
  submission_id  uuid    NOT NULL,
  seq            integer NOT NULL CHECK (seq >= 0),
  kind           text    NOT NULL CHECK (kind IN ('draft', 'comment')),
  item_id        uuid    NOT NULL,
  body_sha256    bytea   NOT NULL CHECK (octet_length(body_sha256) = 32),
  CONSTRAINT review_submission_items_seq_unique UNIQUE (org_id, submission_id, seq),
  CONSTRAINT review_submission_items_submission_fk
    FOREIGN KEY (org_id, submission_id) REFERENCES review_submissions (org_id, id) ON DELETE CASCADE
);

CREATE INDEX review_submission_items_org_item_idx ON review_submission_items (org_id, kind, item_id);

-- Tenant isolation, as 0003: RLS forced, one policy for the application role.
ALTER TABLE review_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY review_submissions_tenant ON review_submissions FOR ALL TO rocky_app
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
ALTER TABLE review_submission_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_submission_items FORCE ROW LEVEL SECURITY;
CREATE POLICY review_submission_items_tenant ON review_submission_items FOR ALL TO rocky_app
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

-- No DELETE: an attempt is a record (review round 1, N6). Rows go with their pull request or org.
GRANT SELECT, INSERT, UPDATE ON review_submissions, review_submission_items TO rocky_app;
