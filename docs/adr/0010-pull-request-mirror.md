# ADR 0010 — Pull request mirror: scoped tokens, diff readings, rebuild from GitHub

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P3-4
- **Amends:** [ADR 0007](0007-webhook-inbox.md) §1 (the outbound `Forge` port takes its P3-4
  shape), [ADR 0009](0009-installation-lifecycle.md) §3 (claims cover whole lanes; the pull
  request lane gets its consumer)
- **Revised:** review round 1: a lagging pull request read and a compare 404 are retried as
  strikes before they are believed; an `unavailable` diff reading can be replaced; diff size and
  digest are those of the raw bytes read; explicit `org_id` filters next to RLS (M11–M13)
- **Amended by:** [ADR 0034](0034-pull-request-diff-endpoint.md) (H4-3: the server reads a
  revision's diff on demand for the file view, through the same session and cap; §3 and §4
  notes below)

## Context

GitHub sends `pull_request` webhooks (opened, synchronize, closed, reopened); since P3-2 they wait
in the inbox's `pull_request` lane, unprocessed, and since P3-3 the purge keeps unprocessed rows,
so they pile up. The mirror (`repos`, `pull_requests`, `pr_revisions`, migration 0002) is derived
data: GitHub is the source of truth, and the mirror must be rebuildable from GitHub alone. Reading
a pull request and its diff needs an installation token, which can do whatever the installation
was granted (`pull_requests: write` among them) for an hour on every repository it can see; diffs
can be arbitrarily large; and the pull request's title, body and diff are attacker-controlled.

## Decision

### 1. Consuming the pull request lane

The worker drains the `pull_request` lane in its own job (`pull_requests`, batches of 5, after the
same app check as the installation lane). A row is a hint (ADR 0007 §4); for each one, in order:

1. `GET /app/installations/{id}` (app JWT): gone → finished `installation_not_found`; suspended
   → `installation_suspended` (GitHub refuses its tokens; the next event or the rebuild catches
   up after unsuspension); an unmodelled account → `unsupported_account_type`.
2. The live org bound to the installation (`worker.installation_orgs`). None yet (the
   installation lane runs separately, so its `created` row may still be ahead): a strike
   (`org_not_ready`), retried with backoff; the third time (`CONTRADICTION_ATTEMPTS`) the row is
   finished `no_org` (the rebuild recovers what it would have written).
3. A repository session (§2). GitHub refusing a token for the repository (422) means it is not
   this installation's → `repository_inaccessible`.
4. `GET /repos/{owner}/{repo}/pulls/{number}` with the token: 404 → `pull_request_not_found`.
   The answer must be about the number and repository asked for (`base.repo.id`). For `opened`
   and `synchronize`, a head that differs from the event's is a **lagging read** (review round 1:
   GitHub's API can lag the webhook, and believing it would complete the row with the old head
   and lose the push): a strike (`forge_head_mismatch`), retried with backoff; the third time
   (`CONTRADICTION_ATTEMPTS`) GitHub's answer is believed. For `closed` and `reopened` the head
   need not change, so the answer is taken as it is.
5. The head revision's diff is read (§4) only when the mirror has no reading for that head (an
   `unavailable` reading does not count). GitHub having no diff for it yet (a compare 404 or 422
   right after a push) is a strike (`forge_diff_unavailable`) for the first attempts; the third
   time it is recorded as `unavailable`, which a later event or the rebuild replaces.
6. One `withOrg` transaction upserts the repository, the pull request and the revision, and marks
   the inbox row processed (`pr_mirrored`, `pr_unchanged` or `pr_stale_snapshot`). A lost lease
   rolls all of it back.

The event's own fields (head sha, `merged`) are never written: the four actions are handled alike,
so a replayed, reordered or planted row costs at most a redundant read. The session is closed
(token revoked) in a `finally`, whatever happened. Failures follow ADR 0009: outages (timeouts,
5xx, 429, 401/403) are transient and never strike; malformed answers strike; a row that does not
decode, or decodes to a type the lane does not handle (`unhandled_event_type`), is parked at once.

A row's worst case is five forge reads (installation, mint, pull request, diff at its own 30 s
timeout, revocation) plus slack: `PR_ROW_BUDGET_SECONDS` = 80, lease `(5 + 1) × 80` s.

### 2. Installation tokens: one repository, read-only, revoked after use

`createGitHubForge` (`packages/forge-github/src/repositories.ts`) opens a `RepositorySession` per
inbox row (or per rebuild) by minting `POST /app/installations/{id}/access_tokens` with
`{"repository_ids": [id], "permissions": {"contents": "read", "pull_requests": "read"}}`: narrower
than the app's grant (`pull_requests: write`, ADR 0008), and only the one repository. The answer
is checked before the token is used: exactly one repository, the one asked for, and no permission
other than `read` on those two (plus `metadata: read`, which GitHub always adds). Anything else is
**revoked** (`DELETE /installation/token`) and refused (`invalid_response`); the token is parsed
first so that it can still be revoked when the rest of the answer is wrong.

The token lives in the session's closure only: never returned by the port, never logged, never in
an error (`ForgeReadError` carries a reason and a status), never stored. `close()` revokes it, so
its useful life is one row, not GitHub's hour; a session that comes within 5 minutes of the
token's expiry mints a new one and revokes the old. Revocation is best effort: a token that cannot
be revoked still expires within the hour. Requests go to the configured https API base only, with
`redirect: "error"`, timeouts (10 s; 30 s for diffs) and byte caps (256 KiB token answers, 1 MiB
pull requests, 16 MiB list pages).

The rebuild command needs the reverse lookup: `locateRepository(owner/name)` asks
`GET /repos/{owner}/{repo}/installation` (app JWT), refuses a suspended installation
(`installation_suspended`), and mints a token for that repository by name only to learn its id,
revoking it at once.

### 3. Mirror schema (migration 0008)

The tables exist since 0002; 0008 adds only:

- `pull_requests.forge_updated_at`: the forge's `updated_at` of the stored snapshot. The upsert
  applies a snapshot only when it is not older (`<=`), so a slower writer (the worker and the
  rebuild at once) never replaces a newer one, and only when something differs (no churn).
- `pr_revisions.diff_bytes`, `diff_sha256`, `diff_truncation`: what was read of the revision's
  diff. CHECKs: bytes and digest come together; `diff_truncated` (0002) is true exactly when a
  reason is recorded; a reason only for a diff that was read.

Shapes: one `repos` row per (org, forge repository id), display fields refreshed from GitHub;
one `pull_requests` row per (repository, number) holding GitHub's current state (`merged` when
`merged_at` is set); one `pr_revisions` row per head the mirror has seen, with the base it was
diffed against and the forge's known fields (`files`, `additions`, `deletions`, P1-4) in `stats`.
A revision's diff reading is written once: its commits fix its diff. The one exception is
`unavailable` (GitHub had no diff then): a real reading replaces it, never the reverse.

**The diff text is not stored.** It is code; the mirror needs to know how big it was, whether it
was complete and which bytes were read (`diff_bytes` and `diff_sha256` are those of the raw bytes
the adapter read, before any decoding, so a non-UTF-8 diff keeps its size, which never exceeds the
cap, and its digest; `ForgeDiff` carries the bytes and their sha256), and the analysis (P4) reads it from the forge
when it needs it, verifying it against the digest. Storing it (in Postgres or R2) is P4's
decision. No grant changes: the worker writes these tables through `rocky_app`'s existing
privileges, inside `withOrg`, under the 0003 tenant policies.

H4-3 ([ADR 0034](0034-pull-request-diff-endpoint.md)): the server reads the head revision's
diff the same way, on demand, when a reviewer opens a file (`openRepository` → the pull request's
head verified against the mirror's → `getDiff` pinned to the revision → `close`), keeps it in
memory for at most a minute and stores nothing. The rule stands: no diff text in Postgres or
anywhere durable.

### 4. Diffs and truncation limits

Diffs come from `GET /repos/{owner}/{repo}/compare/{base}...{head}` (`application/vnd.github.diff`):
the merge-base diff GitHub shows for a pull request, pinned to the revision's two commits, so a
push between the pull request read and the diff read cannot mix revisions. The reader stops at
`maxBytes`:

| `diff_truncation` | When                                                                           | Text read                     |
| ----------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| `null`            | the whole diff fit in `MIRROR_DIFF_MAX_BYTES` (1 MiB)                          | all of it                     |
| `max_bytes`       | longer than 1 MiB                                                              | a prefix cut at its last `\n` |
| `forge_limit`     | GitHub refuses to render it (406 with `errors[].code == too_large`)            | none                          |
| `unavailable`     | GitHub has no diff for the commits (its JSON 404, or a 422), after the retries | none                          |

1 MiB is well above what one analysis can take in (P4-6 sets the per-PR budget), so the cap does
not cut a diff the analysis could have used whole. The file view (H4-3, ADR 0034 §3) reads with
the same cap and trims a `max_bytes` prefix further, to the last complete file, so the page shows
whole files only. Any other answer (a 406 without `too_large`, an HTML 404, a
5xx) is a read failure, never truncation. The prefix is cut at a line end, so no hunk line or UTF-8
sequence is split. Truncated diffs are flagged in the revision (`diff_truncated`) and counted by
the rebuild (`truncatedDiffs`); the UI and the analysis must say so (P4/P6).

### 5. Rebuild from GitHub

`pnpm mirror:rebuild <owner/name> [--limit N]` (`apps/worker/src/rebuild-mirror.ts`, worker
configuration and login; [runbook](../runbooks/mirror-rebuild.md)) recreates one repository's mirror from GitHub's answers alone, after the
same checks as the worker: the app check, the repository's installation (not suspended), a live
org bound to it, a scoped token. Semantics:

- It lists every pull request of the repository (`state=all`, newest **created** first: a stable
  order while pull requests are updated during the listing; one opened meanwhile only repeats an
  entry, deduplicated), up to `--limit` (default 1000, at most 10 000), and writes each through
  the same path as a webhook (§1 steps 4–6, without an inbox row).
- A pull request whose stored snapshot matches the listing (same head, same `updated_at`, head
  diff read; an `unavailable` reading is not read) is not read again: a second run reads only the
  listing and changes nothing, and a run after GitHub has the diff again repairs `unavailable`.
- **What "mirror state" means:** the repository row, every pull request row, and the revision of
  each pull request's current head with its diff reading (an `unavailable` reading is replaced
  once GitHub has the diff). That is exactly what a rebuild
  recreates (the e2e test compares the two field by field). **Earlier revisions** (one per push a
  webhook reported) cannot be recreated: GitHub keeps no list of past heads. Existing ones are
  kept.
- **Nothing is deleted.** Mirrored pull requests GitHub did not list are counted (`notListed`;
  `null` when the limit cut the listing short) and kept: they may carry a reviewer's drafts and
  decisions, and deleting tenant data is not a rebuild's call.
- It is idempotent and safe while the worker runs (§3's snapshot guard, upserts only). Its output
  is one log line of ids and counts: no repository name, title or token.

### 6. Whole-lane claims (the P3-3 follow-up)

The claim hands out only the oldest pending row of each (installation, lane) and skips it when its
type is not in `p_event_types`, which would stop that lane forever behind a type nobody claims.
`claimSql` now refuses a claim that does not cover whole lanes (`laneEventTypes`: every type of
`FORGE_EVENT_TYPES` with that prefix), and a test pins the inbox's `event_type` CHECK to exactly
`FORGE_EVENT_TYPES`. So every head a claim meets is one it asked for; adding a type means adding it
to both (ADR 0007, Consequences), and a drain whose handler does not know a type parks the row
(`unhandled_event_type`) instead of leaving it in front of the rest.

### 7. Not in this task: the installation reconciler

The P3-3 follow-up "periodic installation reconciler" (re-checking live orgs against
`GET /app/installations` and scheduling deletion on GitHub's 404) decides org deletion, which the
plan labels RISKY (data deletion) and P3-3 owns; folding it into this NORMAL task would skip the
risky-implementer and security-review process. It stays a follow-up (docs/progress.md). The
rebuild command recovers the **mirror** for webhooks lost while the server was down; it does not
touch installations.

## Threat model

Assets: tenant boundaries, the installation's GitHub credentials and their scope, the integrity of
the mirror (what reviewers and the analysis will see), log and database hygiene.
Attackers: PR authors (titles, bodies, diffs, huge diffs); whoever holds the server's database
credential (planted inbox rows); other tenants; a slow or lying network path; a concurrent worker.

| #   | What can go wrong                                                                                  | Prevention                                                                                                                                                                                     | Test                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | A planted or replayed row writes a pull request GitHub does not have, or an old state              | The row is a hint: installation, repository and pull request re-read from GitHub; event fields never written; snapshot guard on `forge_updated_at`                                             | `mirror.e2e.test.ts` "planted rows for things GitHub does not have write nothing", "a stale or replayed event changes nothing"; `mirror.test.ts` "never applies an older snapshot"                                    |
| M2  | A token broader than needed (write, all repositories) is used or leaks                             | Minted per row for one repository id, `contents`/`pull_requests: read`; answer checked (one repository, read-only) or revoked and refused; revoked on close; never logged, stored or in errors | `repositories.test.ts` "mints a token for exactly the repository…", "refuses and revokes a token whose permissions exceed the ask", "…for another repository", "revokes the token on close"; e2e "re-reads … revoked" |
| M3  | A row names a repository of another installation (cross-tenant read)                               | GitHub scopes the token to the installation's repositories (422 → `repository_inaccessible`); writes only in the installation's own org                                                        | e2e "planted rows…" (`repository_inaccessible`), "keeps tenants apart"; `repositories.test.ts` "a token for one repository cannot read another"                                                                       |
| M4  | A huge diff exhausts memory or time                                                                | Read stops at 1 MiB (cut at a line), 30 s timeout; GitHub's own refusal is `forge_limit`; other answers are failures, not truncation                                                           | `repositories.test.ts` "cuts a diff longer than maxBytes…", "flags forge_limit…", "does not read other failures as truncation"; e2e acceptance (#4, #5)                                                               |
| M5  | Diff text, titles or tokens reach logs or the database                                             | Diff text never stored (bytes + sha256 only); logs carry ids and codes; tokens in the closure only                                                                                             | e2e "logs and the database never hold an installation token, a diff, a title or a login" (log capture + `pg_dump`)                                                                                                    |
| M6  | Two writers (worker, rebuild) interleave and leave an older snapshot                               | `forge_updated_at` guard; revision reading written once; one transaction per write                                                                                                             | `mirror.test.ts` "creates, leaves unchanged, updates, and never applies an older snapshot"                                                                                                                            |
| M7  | A lane stalls behind a type nobody claims                                                          | Whole-lane claims only; CHECK pinned to `FORGE_EVENT_TYPES`; unknown types parked                                                                                                              | `inbox.test.ts` "P3-4: claims whole lanes only…"; `mirror-rebuild.test.ts` "parks a decodable row of a type the lane does not handle…"                                                                                |
| M8  | An outage or a suspended installation parks good rows, or is read as "gone"                        | Outages transient (no strike); suspension checked first and finished without effect; only GitHub's JSON 404 is "not found"                                                                     | e2e "a GitHub outage while reading retries…", "a suspended installation is not read on behalf of"; `repositories.test.ts` "treats a suspended installation's 403 as a (transient) read failure"                       |
| M9  | The pull request lane runs before the org exists and the event is lost                             | `org_not_ready` strike and retry; after the window `no_org` (the rebuild recovers it)                                                                                                          | e2e "waits for the org…", "gives up waiting…"                                                                                                                                                                         |
| M10 | The rebuild deletes reviewers' work or acts for an unverified repository                           | Nothing deleted (`notListed` counted); app check, installation, org and token checks first                                                                                                     | e2e "repairs drift … keeps rows GitHub no longer lists", "refuses to rebuild what it cannot verify"                                                                                                                   |
| M11 | A lagging GitHub read completes a push's row with the old head, losing the update (review round 1) | For `opened`/`synchronize`, a head that differs from the event's is a strike, retried before GitHub's answer is believed                                                                       | e2e "a lagging read of a push is retried…", "a stale or replayed event changes nothing" (`forge_head_mismatch`, strikes 2)                                                                                            |
| M12 | A temporary compare 404 is recorded as `unavailable` for good (review round 1)                     | A strike for the first attempts; `unavailable` is not a read (`headDiffRead`) and a real reading replaces it                                                                                   | e2e "a compare 404 for a just-pushed head is retried…", "an `unavailable` reading is repaired by the next event and by the rebuild"; `mirror.test.ts` "an `unavailable` reading is not final"                         |
| M13 | The recorded size or digest is not that of the bytes read (non-UTF-8 diff), or exceeds the cap     | The adapter measures and hashes the raw cut bytes; nothing is decoded before that                                                                                                              | `repositories.test.ts` "size and sha256 describe the raw bytes read…"; e2e "diff size and sha256 are those of the raw bytes, never above the cap"                                                                     |

## Consequences

- `pull_request.*` rows are consumed and purged like any processed row; the P3-3 pile-up ends.
- One token mint and revocation per pull request event (GitHub's rate limit for installations is
  per installation and hour; the mirror spends five calls per event at most).
- `Forge` grows `openRepository` and `locateRepository`; `InstallationReader` is now its own
  interface that `Forge` extends. `ForgeReadFailure` gains `installation_suspended`.
- Fixtures: `post-installation-access-token*.json`, `get-pull-request.json`,
  `list-pull-requests.json`, `compare-diff.too-large.json`, `compare.diff`, documentation-shaped
  with synthetic ids (`packages/forge-github/fixtures/README.md`).

## Residual risks

- **Fixtures are documentation-shaped, not recorded.** In particular the 406 `too_large` body of
  the compare endpoint and the exact permissions GitHub requires for `compare` diffs on private
  repositories (`contents: read` is requested for it) are not verified against a live
  installation. Follow-up with the P3-3 recording task (needs a human with a test installation).
- **Every event costs a GitHub read.** Same-PR duplicates are not collapsed (the 0007 collapse is
  for installation rows only); a flood of planted rows for one installation delays that
  installation's lane, as in ADR 0009. A per-PR collapse on completion is a follow-up.
- **Earlier revisions are not rebuildable** (§5), and their analyses (P4) survive only as long as
  the rows do.
- **Repositories leaving an installation** (removed from a selected-repositories installation, or
  transferred) keep their mirror rows until the org is erased; the next event for them is
  `repository_inaccessible`. A transferred repository is mirrored again under its new
  installation's org.
- **`updated_at` has second granularity**: two changes within one second may both be applied in
  arrival order (`<=`), so the later writer wins even if it read first. Each write is still a
  complete GitHub snapshot, and the next event or rebuild corrects it; `<` would instead drop a
  genuine second change within that second (commented at the upsert).
- **A lagging read that outlasts the retries** (three strikes, about 1.5 minutes of backoff) is
  believed, and the mirror keeps the old head until the next event or rebuild.
- **Truncation GitHub does not report**: a diff that GitHub silently shortens is recorded as
  complete (follow-up: compare `diff --git` headers with `changed_files`).
- **Pagination by page number**: a pull request opened during a long listing repeats an entry
  (deduplicated); none is skipped. The listing stops with an error past 100 pages.
- **Suspended installations** are not mirrored while suspended; there is no unsuspend event
  decoded (ADR 0009 §5), so catching up after unsuspension needs the next event or the rebuild.
- **Revocation is best effort**: if `DELETE /installation/token` fails, the token stays valid until
  GitHub's expiry (at most an hour), still read-only and scoped to one repository.
- **`no_org`**: a pull request event whose org never appears within the strike window is dropped
  (no effect); the rebuild recovers the pull request once the org exists.
