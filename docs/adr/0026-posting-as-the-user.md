# ADR 0026: Posting a review as the user

- **Status:** Accepted
- **Date:** 2026-10-30
- **Task:** P3-5
- **Revised:** review round 1 (S1–S4, N1–N7): reconciliation matches state, time, body and
  comment count and never decides when ambiguous; a full review listing throws instead of
  answering a partial list; ages by the database clock; a late posted answer overrides a
  `lost` row; the preview reports the attempt in flight and the latest attempt; no DELETE on
  the attempt tables; an ESLint rule keeps the poster out of the worker and the LLM package.
- **Amends:** [ADR 0007](0007-webhook-inbox.md) §1 (the outbound forge port gains
  `ReviewPoster`, held by the server only), [ADR 0011](0011-repository-access-check.md) §6
  (the P3-5 rule made concrete), [ADR 0024](0024-org-roles-and-access-policy.md) §5 (two
  routes under `pull_requests.review`)
- **Relies on:** [ADR 0020](0020-github-login-and-sessions.md) (the member's stored token,
  CSRF), [ADR 0004](0004-schema-first-llm.md) (LLM output never triggers side effects)

## Context

Rocky drafts review comments; a person accepts, edits or dismisses them, writes their own, and
decides. Everything the person decided must reach GitHub as **their** review, under their name,
as one review (not a trickle of comments), and nothing else must. Three things make this risky:
LLM output must never post itself; a stale browser tab, a double click, a retry after a timeout
or a crash mid-call must never post twice or post something the person did not see; and the
credential used is the person's own GitHub token, stored encrypted since P7-1.

P6-4 (drafts) and P6-6 (the finish modal) are built in parallel and after this. This ADR defines
the posting service they plug into: a port that takes the exact list to post, and a contract
between "what was shown" and "what is posted".

## Decision

### 1. Shape

- `packages/core/src/review-posting.ts`: the port `ReviewPoster` (`postReview`,
  `listOwnReviews`), the types (`ReviewSubmission`, `ReviewPlanItem`, verdicts), and the pure
  parts: `canonicalReviewPlan`, `validateReviewSubmission`, `findingCommentBody`.
- `packages/forge-github/src/reviews.ts`: `createGitHubReviewPoster`, one `POST
/repos/{owner}/{repo}/pulls/{number}/reviews` with the user's token, and the list of the
  user's own reviews for reconciliation. The installation-token `Forge` (what the worker holds)
  has no posting method; the poster is a separate object the worker never constructs.
- `packages/db/src/reviews.ts` and migration `0016_review_submissions` (after P6-4's
  `0015_review_drafts`): `loadReviewPlan`,
  `beginReviewSubmission`, `finishReviewSubmission`.
- `apps/server/src/reviews/post-review.ts`: the service (`preview`, `submit`);
  `apps/server/src/reviews/post-routes.ts`: `GET` and `POST /api/pull-requests/:pullRequestId/review`,
  policy `pull_requests.review`; `apps/server/src/member-token.ts`: the member's credential for
  one call.

### 2. The plan: what is shown is what is posted

The server, not the client, decides what can be posted. `loadReviewPlan` builds, for one member
and one pull request, the list of:

- drafts the member accepted (`findings_state.state = 'accepted'`, `decided_by` = the member) on
  the latest finished analysis of the head revision, in document order, rendered by
  `findingCommentBody` (title, body, a `suggestion` block; never severity, confidence or the
  agent prompt);
- the member's own pending comments (`comments_pending`, `author_id` = the member) on the head
  revision that have a path and a line (a comment on an earlier revision drops out of the plan
  after a push: its line may no longer exist; product decision, veto at review);

minus every item carried by a submission that is `posting` or `posted`. The plan also reports
the member's attempt in flight and their latest attempt (ids, status, counts, times; never
content), so the finish modal can block or explain instead of offering a second verdict. The
plan's canonical JSON (`canonicalReviewPlan`: head, every field of every item, in order) is hashed; `GET` returns
the items with their final bodies and the hex digest. `POST` carries the digest and the head
back; `beginReviewSubmission` rebuilds the plan under a per (pull request, member) advisory lock
and refuses with `stale` or `head_moved` when they differ. The forge is called with exactly the
rebuilt list. The P6-6 criterion "what's shown == what's posted" is this test:
`post-review.db.test.ts` "posts exactly the previewed items…" and "refuses a list that
changed…".

Drafts are the member's own decisions on purpose: nobody can make someone else post a draft they
did not accept (product decision; veto at review).

### 3. Idempotency: a click posts at most once

- The client sends an `idempotencyKey` (a uuid per click). `review_submissions` is unique on
  (org, key): the same key answers with the earlier attempt (posted → the same 200, failed →
  the same 502), and the same key with other content is `key_reused`.
- One attempt in flight per (pull request, member): a partial unique index and the lock.
- The attempt is written as `posting`, with its items, **before** the forge is called, and the
  plan excludes carried items from then on. Two clicks with different keys on the same list
  resolve as one `posted` and one `stale`.
- A lost answer (timeout, network, a malformed body: the review may exist) leaves the attempt
  `posting` and answers `post_unknown`. The next click after `REVIEW_POSTING_TIMEOUT_MS` (60 s,
  measured by the **database's** clock: `ageMs` is read with the row, so server and database
  clocks are never compared) reconciles it from the person's own reviews on GitHub. A review
  is the attempt's only when all of these hold: its id is not one Rocky already recorded, its
  commit is the attempt's head, its state is the attempt's verdict, its summary digest is the
  attempt's, GitHub submitted it no earlier than `RECONCILE_CLOCK_MARGIN_MS` (5 min) before the
  attempt was recorded, and `GET …/reviews/{id}/comments` counts as many inline comments as the
  attempt carried (asked only when it carried any). Exactly one such review → `posted` (audited
  as `system`); none → `failed` (`lost`, items released); two or more, or no usable answer from
  GitHub (including a listing with more reviews than the adapter reads) → it stays `posting`.
  A hand-made empty approval therefore never stands in for an attempt that carried comments.
- A `posted` answer applies to a `posting` **or** `failed` attempt (GitHub is authoritative: a
  late answer after a reconciliation called it lost marks the items carried again); a `failed`
  answer applies to a `posting` attempt only. A finish that applies to nothing is logged
  (`finish_not_applied`); the client is still told what GitHub did.
- A poster that refuses before any request (a caller bug, not a `ForgeReadError`) is a definite
  `failed` (`invalid`), never a stuck attempt.
- A refusal GitHub documents (401, 403, 404, 422) fails the attempt with that code and releases
  its items; the client is told (`post_failed`) and retries with a fresh key once the cause is
  fixed. A `post_failed` answer is final for its key.

### 4. Only a human posts, with their own token

- The only caller of `ReviewPoster` is the `POST` route: behind the access policy (a live
  session, an active member whose role holds `pull_requests.review`, re-read per request) and
  the global CSRF guard. `beginReviewSubmission` re-checks the actor `FOR SHARE` in its own
  transaction. `submitted_by` is NOT NULL and comes from the session only; body fields such as
  `orgId`, `memberId` or `submittedBy` are ignored.
- Before anything is written, the P3-6 check runs (ADR 0011 §6): the repository's forge id is
  resolved under the caller's RLS, `check` is asked outside any transaction, and a deny answers
  404 like an unknown pull request. Without the check the routes answer 503.
- The credential is the member's stored GitHub token, decrypted for this call (purpose
  `github_token`, record id = member id; another member's or org's ciphertext does not decrypt)
  and dropped; an expired, missing or unreadable token answers `token_unavailable` before any
  attempt is recorded. GitHub enforces access again with that token.
- The worker, the analysis pipeline and the LLM package name nothing of this; a source scan test
  pins it ("there is no code path from the worker…").

### 5. Content handling

Everything in a plan is PR-shaped, untrusted text. The forge request is JSON-encoded, never
concatenated; paths are validated (repository-relative POSIX, no `.`/`..`), lines bounded, the
summary and each comment at most 65 536 characters, at most 100 comments, the pull request
locator validated, the token checked against a bearer shape before any request. The database
holds digests and counts only (`content_sha256`, `body_sha256`, per-item `body_sha256`); the
content is on GitHub, the source of truth. Logs carry ids, counts, digests and fixed codes.

### 6. API

| Route                                           | Policy                 | Answers                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/pull-requests/:pullRequestId/review`  | `pull_requests.review` | 200 `{ pullRequestId, number, headSha, revisionKnown, contentSha256, items[], inFlight, latestSubmission }` (the last two: `{ submissionId, status, verdict, draftCount, commentCount, reviewId, errorCode, createdAt, finishedAt }` or null); 404; 503 without the access check                                             |
| `POST /api/pull-requests/:pullRequestId/review` | `pull_requests.review` | body `{ idempotencyKey, contentSha256, headSha, verdict, body }`; 200 `{ status: "posted", submissionId, reviewId, repeated }`; 400 `invalid_request` (+`reason`); 404; 409 `stale` / `head_moved` / `in_progress` / `key_reused` / `no_revision` / `token_unavailable`; 502 `post_failed` (+`reason`) / `post_unknown`; 503 |

Verdicts: `approve`, `request_changes`, `comment` (GitHub `APPROVE`, `REQUEST_CHANGES`,
`COMMENT`). A `comment` or `request_changes` review with an empty summary and no items is
refused (`empty_review`); an approval may be bare.

## Threat model

**Assets:** the member's GitHub token (decrypted for one call), what is published under the
member's name, the pull request's review state on GitHub, tenant boundaries, the audit trail.
**Attackers:** a hostile PR author (content in findings and comments), another tenant, another
member of the same org, a cross-site page, the LLM, a buggy or compromised worker, a stale
browser tab, a double click or retry or a crash mid-call, a forge outage, the logs.

| #   | What can go wrong                                                         | Prevention                                                                                                                                                                                            | Test                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Something posts without a human (worker, LLM output, a job)               | Poster built only in the server, held by the review routes; policy + global CSRF; `submitted_by` from the session, NOT NULL; the worker has no import; the installation `Forge` has no posting method | `post-review.db.test.ts` "no session, no CSRF token…", "there is no code path from the worker…"; `policy.db.test.ts` matrix rows                                       |
| P2  | Posted ≠ shown (edited or dismissed item, new item, head moved)           | Plan rebuilt under the lock in the begin transaction; digest and head compared; preview returns the final bodies                                                                                      | "posts exactly the previewed items…", "refuses a list that changed…"; `reviews.test.ts` (db) "refuses a list that changed…"                                            |
| P3  | Double post (double click, retry, concurrency, crash mid-call)            | Idempotency key unique per org; advisory lock; one in-flight attempt per (PR, member) (partial unique index); items bound at begin; reconciliation from GitHub, never a blind re-post                 | "concurrent clicks with one key post exactly once…", "a lost answer is reconciled…", "…never reached GitHub…", "…stays in flight"; db "serialises concurrent attempts" |
| P4  | The wrong token (another member's, the installation's)                    | Token from the member's own row under RLS, AAD = member id, the org's data key; `listOwnReviews` filters by the token's user id                                                                       | `reviews.test.ts` (forge) "sends the token only in the authorization header…"; "the preview is the member's own: bob… posts under his own name"                        |
| P5  | Posting on a repository the member can no longer read                     | P3-6 `check` before anything is written; deny → 404; 503 without the check; GitHub enforces again                                                                                                     | "a deny answers 404 like an unknown pull request…; without the check, 503"                                                                                             |
| P6  | Another tenant's pull request id                                          | Resolved under the caller's RLS → 404                                                                                                                                                                 | matrix `otherOrg`; "a removed member, or a member of another org, cannot post or preview"                                                                              |
| P7  | Posting other people's drafts or comments under my name                   | Plan = drafts `decided_by` = me, comments `author_id` = me                                                                                                                                            | db "leaves out other people's drafts and comments…"                                                                                                                    |
| P8  | Hostile content in the payload (JSON or header injection, size, path)     | JSON-encoded body; validated paths, lines, full name and number; bounded sizes; bearer-shape token check; a fence longer than any backtick run in a suggestion                                        | `review-posting.test.ts` (core); forge "encodes the path segments… JSON-encodes hostile content", "refuses a malformed pull request, user or review…"                  |
| P9  | Leaks in logs, errors or the database                                     | Ids, counts, digests and fixed codes only; `ForgeReadError` carries a reason and a status; tables hold digests                                                                                        | "logs carry ids, counts and codes only…"; db "No body text anywhere in the new tables"                                                                                 |
| P10 | A crash after `posting` leaves items stuck for good                       | Reconciliation after the timeout (see §3); `lost` releases the items                                                                                                                                  | "a lost answer that never reached GitHub is released…"                                                                                                                 |
| P11 | An empty review, an own-PR approval, a line outside the diff (GitHub 422) | `validateReviewSubmission`; 422 → `rejected`, the attempt fails and releases its items                                                                                                                | forge "answers GitHub's refusals as outcomes…"; "GitHub's refusal fails the attempt, releases the items…"                                                              |
| P12 | A removed member or a role without the permission posts                   | Policy per request; actor re-checked `FOR SHARE` in the begin transaction                                                                                                                             | db "re-checks the actor…"; matrix `removed`                                                                                                                            |
| P13 | A replayed POST                                                           | CSRF token bound to the session; the same key answers idempotently                                                                                                                                    | "the same click again, later: the same answer, still one review"                                                                                                       |
| P14 | The body smuggles the org, the member or the submitter                    | Ids from `request.access.member` only; extra fields ignored                                                                                                                                           | "the body cannot choose who posts or where…"                                                                                                                           |

## Consequences

- Two new tenant tables (`review_submissions`, `review_submission_items`), RLS forced, grants
  SELECT/INSERT/UPDATE and **no DELETE** for the app role (an attempt is a record; the isolation
  matrix pins it); one fixture row each in `seedOrg`.
- ESLint: `apps/worker` and `packages/llm` cannot import `createGitHubReviewPoster`, the posting
  service or `@rocky-reviews/server` (`scripts/lint-rules.test.ts`), alongside the source-scan
  test.
- P6-6 must show the **exact markdown** GitHub will render for every item, as the preview
  returns it: LLM text can carry mentions, links and images, and GitHub renders them under the
  person's name.
- Wiring `repositoryAccess` in `startServer` is a prerequisite for P6-6 and the H4 gate: until
  then these routes answer 503.
- Three audit actions: `review.submission_started`, `review.posted`, `review.post_failed`.
- The web app (P6-6) renders `GET …/review` as the exact list, and sends back `contentSha256`,
  `headSha` and a fresh `idempotencyKey` per click; on `stale` or `head_moved` it reloads the
  preview; on `post_failed` it shows the reason and lets the person retry with a new key.
- `comments_pending` rows and `findings_state` rows are not changed by posting; "already
  posted" is derived from `review_submission_items`. P6-4 can add an edited body to a draft by
  changing `loadReviewPlan` only.

## Residual risks

- **The routes answer 503 in a running server** until the repository access check is built in
  `startServer` (P7-2 follow-up), like "Analyze anyway".
- The mirror's head may lag GitHub's: a review is posted against the mirrored `commit_id`;
  GitHub accepts it (comments show as outdated when the head moved). A line not in the diff is a
  GitHub 422 (`rejected`), not pre-checked here (follow-up: validate lines against the hunks).
- Reconciliation compares GitHub's `submitted_at` with the database's `created_at` with a 5 min
  margin: a clock skew larger than that between GitHub and the database would make a real
  review look too early (then `lost`, and the person sees the duplicate on GitHub). The 60 s age
  itself uses one clock (the database's).
- `listOwnReviews` reads up to 1000 reviews (10 pages, oldest first) and throws when every page
  is full, so a pull request with more reviews keeps its lost attempts `posting` (fail closed)
  instead of guessing; such a pull request is an operator case.
- Comments without a line (`comments_pending.path`/`line` null) are not posted; the schema
  allows them but the UI does not create them. A product decision is needed if it ever does.
- `listOwnReviews` reads up to 500 reviews; a pull request with more has its older ones unseen
  by reconciliation (then `lost`, and the person sees the duplicate on GitHub).
