# ADR 0034: The pull request's diff, read from GitHub on demand for the file view

- **Status:** Accepted
- **Date:** 2026-10-30
- **Task:** H4-3 (dogfooding wiring; not a plan row)
- **Amends:** [ADR 0010](0010-pull-request-mirror.md) §3–§4 (a second reader of the diff, with
  the mirror's token shape and cap), [ADR 0019](0019-web-app-shell.md) (H4-2 amendment: the
  diff is served now), [ADR 0023](0023-diff-viewer.md) §3 (the server-backed `DiffDataSource`),
  [ADR 0025](0025-security-headers-and-rate-limits.md) §3 (a `diff` rate-limit scope)

## Context

H4-2 made a real pull request's page read the server, but the server served no diff: the file
view said "The diff could not be loaded.", and the drafts' Accept, Edit and Dismiss buttons and
the reviewer's own comments live in the file view, so nothing could be decided on a real PR. The
mirror deliberately stores no diff text (ADR 0010 §3: it is code; the mirror keeps size, digest
and truncation only, and the analysis reads the diff from GitHub when it runs). The page needs
the diff of the mirrored head, the one the analysis read and the drafts are anchored to, and
must get it without storing it, without a broader credential than the mirror uses, and without
letting one signed-in member drain the installation's rate limit (the H4-1 security review's
concern about token-mint amplification).

## Decision

### 1. One endpoint, under the PR page's address

`GET /api/repos/:owner/:repo/pulls/:number/diff` (`apps/server/src/pulls/diff-routes.ts`), next
to H4-2's `GET /api/repos/:owner/:repo/pulls/:number`: the page already names the PR by
repository and number, the web's `DiffDataSource.load(ref)` takes that same `PullRef`, and the
route shares the page route's address rules (`RepoOwner`, `RepoName`, no `.`/`..`, the number's
bounds). Policy `pull_requests.review` (every role), then:

1. the per-member `diff` rate limit (30 per minute, `ROCKY_RATE_LIMIT_DIFF`; §4), before any
   query, so a flood costs nothing;
2. the address (400 `invalid_pull_request`);
3. the two things that must exist: the P3-6 repository access check (503
   `access_check_unavailable`) and the diff reader (503 `diffs_unavailable`, when the server has
   no app key; both fail closed before anything is read);
4. `loadPullRequestDiffTarget` inside `withOrg` (`packages/db/src/pull-request-page.ts`): ids
   only (the PR's id, its repository's forge id, the org's installation, the mirror's head and
   the base its head revision was diffed against); an unknown PR, a disabled repository and
   another org's (RLS plus the explicit org filter) are `null` → 404 `not_found`;
5. `repositoryAccess.check({ orgId, memberId, repositoryId })`, ids from the session and the row
   (ADR 0011 §6); a deny is the same 404, whatever the reason;
6. the reader (§2), which may answer from its cache (§4): the check in step 5 ran either way.
   The org's aggregate limit `diff.org` is spent inside the reader, only when it is about to
   open a session (`beforeForge`), so cache hits and joined reads cost the org nothing; a
   refusal is 429 like the member's.

Answers, all `Cache-Control: no-store`, JSON, nothing stored:

| Status | Body                                  | When                                                                   |
| ------ | ------------------------------------- | ---------------------------------------------------------------------- |
| 200    | `{ headSha, diff, truncation }`       | the mirror's head; `truncation` is `null` or `"max_bytes"` (§3)        |
| 404    | `not_found`                           | unknown, disabled, another org's, access denied, the installation lost |
|        |                                       | the repository, GitHub has no such PR: one answer for all of them      |
| 409    | `head_moved`                          | GitHub's head is no longer the mirror's (§2); nothing served           |
| 409    | `commits_unavailable`                 | GitHub has no diff for the mirror's commits (force-pushed away)        |
| 413    | `diff_too_large`                      | GitHub refuses to render it (ADR 0010 §4 `forge_limit`)                |
| 429    | `rate_limited`                        | over the member's limit, or the org's for reads that reach GitHub      |
| 502    | `forge_unavailable`                   | GitHub did not answer, or not as asked (`ForgeReadError`)              |
| 503    | `access_check_unavailable`, `diffs_…` | the check or the reader is not built (fail closed)                     |

### 2. The reader: the mirror's session, the head verified first

`createPullRequestDiffReader({ forge, clock })` (`apps/server/src/pulls/diff-reader.ts`) is
built in `startServer` from the same `createGitHubForge` the access check's membership step
uses (ADR 0033 §2), so it exists exactly when the app's key does. Per uncached read:

1. `forge.openRepository({ installationId, repositoryId })`: the mirror's mint (ADR 0010 §2),
   `repository_ids: [id]` with `contents: read` and `pull_requests: read` only, narrower than the
   app's grant; the answer is checked (that one repository, nothing wider) or the token is
   revoked and refused; the token never leaves the adapter's closure. The two permissions are the
   narrowest that work: `contents: read` for the compare diff, `pull_requests: read` for the head
   check below. A `null` (the installation is gone or cannot access the repository) is
   `not_found`.
2. `GET /repos/{owner}/{repo}/pulls/{number}` must still name the mirror's head. A head that
   moved is `head_moved` and **no diff is read**: a diff of another head than the page shows (and
   the drafts are anchored to) is never served, silently or otherwise. The page says the PR
   changed; the mirror catches up through its own webhook (ADR 0010 §1).
3. `compare/{base}...{head}` pinned to the mirror's revision: the base recorded for the head
   revision (the head revision's base, what the analysis read; else the pull request's own
   `base_sha`, written by the same mirror read; never GitHub's live base, review round 1 SF1),
   with the mirror's cap (§3).
4. `close()` in `finally`, whatever happened: the token is revoked, its useful life is one read.

Outages (`ForgeReadError`: timeouts, 5xx, 429, 401/403, a malformed answer) are `forge_failed`
with the error's fixed code; anything else propagates (a bug, answered 500 with a fixed body).
The worker's mirror and the analysis read diffs exactly this way; nothing new talks to GitHub.

### 3. Limits: the mirror's cap, trimmed to whole files

`PULL_REQUEST_DIFF_MAX_BYTES` = 1 MiB (`MIRROR_DIFF_MAX_BYTES`, ADR 0010 §4; pinned by a test),
30 s timeout, read through the adapter's `getDiff`, which cuts a longer diff at its last line
end and flags `max_bytes`. That prefix usually ends inside a hunk, which the web app's strict
`parseUnifiedDiff` refuses whole, so the reader trims it further to the **last complete file**
(`wholeFiles`: the prefix up to the last `diff --git ` line at a line start; no hunk line can
start that way). Every file served is complete; files past the cut are absent, and the page says
so on every file and on a file it cannot find ("past the part of the diff Rocky read"). A cut
inside the first file leaves an empty, flagged diff. The answer's `truncation: "max_bytes"` is
read by `parseDiffData` into `DiffData.truncated`; the log line carries the bytes and sha256 of
what was served. GitHub's own refusal (`forge_limit`) is 413; the page offers the whole diff on
GitHub (a link built from the validated names, `/pull/<n>/files`).

The bytes are decoded as UTF-8 for display, lossily (replacement characters): the analysis
refuses a non-UTF-8 diff (`diff_not_utf8`, ADR 0014), so no drafts exist for one, and showing it
is more useful than refusing it.

### 4. Rate limits and a short cache (token-mint amplification, quota drain)

Each uncached read mints and revokes an installation token (about four GitHub calls: mint,
pull request, compare, revoke), and the installation's hourly quota (5,000 calls at the floor)
is shared with the worker's mirror and the analysis. Three bounds, all documented here:

- **Per-member rate limit** `diff`: 10 per minute, keyed by member id (HMAC'd like every key,
  ADR 0025 §3), consumed before any query or GitHub call, cache hits included. A page loads the
  diff once per PR; ten a minute is a human reloading, not a script.
- **Per-org rate limit** `diff.org`: 15 per minute, keyed by org id, spent only by reads that
  go to GitHub (the reader asks `beforeForge` right before opening a session; hits and joined
  reads never spend it). This is the bound on the installation's quota: at most 15 × 4 = 60
  calls a minute, 3,600 an hour, whatever the number of members, tabs or pull requests, leaving
  the rest of the floor to the worker (D14). A refused read is 429 like the member's.
- **In-memory cache** in the reader, keyed by org + repository id + pull request number + base
  - head (every part of what was asked, review round 1 SF1: two pull requests from one head
    against different bases, or a retargeted one, never share an entry), bounded to 64 entries
    and 16 MiB (oldest out; a diff over the bound is served but not kept), concurrent reads of
    one key sharing one session. A served diff (whole or cut) is kept for `DIFF_CACHE_TTL_MS` =
    60 s. A **failure is kept briefly too** (`FAILURE_CACHE_TTL_MS`; review round 1 SF2): 30 s for
    `head_moved`, `commits_unavailable` and `too_large`, 10 s for `not_found`, 5 s for
    `forge_failed`; these are fixed, content-free results, and remembering them means a page or
    a script that keeps asking the same question costs the installation one read per lifetime,
    not one per request. **A hit is served only after the member's fresh access check** (step 5
    of §1 runs before the reader, hit or not): the cache saves GitHub calls, never a decision, so
    a member whose access GitHub revoked (ADR 0011's 5-minute bound) gets 404 from a warm cache
    like from a cold one. The constructor refuses a TTL over a minute or an unbounded cache. Per
    process, like the access cache.

The cached text is the same content the member was just allowed to read; it lives in memory for
at most a minute and is never written anywhere. ADR 0010 §3's "the diff text is not stored"
stands: nothing in Postgres, R2 or on disk.

### 5. The web app

`createHttpDiffSource()` (`apps/web/src/data/diff-http-source.ts`) implements the P6-3
`DiffDataSource` against the endpoint, same origin, with the session cookie; the real PR page
(`main.tsx`) uses it, the fixture source stays behind H4-2's dev-and-test-only switches. A
refusal becomes a `DiffLoadError` with a fixed reason (401 `signed_out`, 404/400 `not_found`,
409 `head_moved` or `commits_unavailable`, 413 `too_large`, 429 `rate_limited`, 502
`forge_failed`, 503 `unavailable`,
anything else `failed`); the body is never read into an error. `DiffProvider` keeps the reason;
`FileView` shows fixed text per reason (`role="alert"`), a link to the whole diff on GitHub for
`too_large` (and in the truncated note), to the pull request for `commits_unavailable`, "Sign
in with GitHub" (back to this page) for `signed_out`, nothing from the answer. A 409 is told
apart by its body's `error`, matched against the two fixed codes only (SF3). `parseDiffData` stays the one validator (strict reader, 20 M character bound), now
also of `truncation`. ADR 0023 §3's head rule is unchanged: drafts and own comments are shown
only when the diff's head is the analysis's.

## Threat model

**Assets:** the diff (code of a possibly private repository); the app's key and the installation
tokens it mints; tenant boundaries; the integrity of what the reviewer sees (the diff must be the
mirrored head's, the one the drafts are anchored to); server memory and the installation's
GitHub rate limit; log hygiene.

**Attackers:** a member of org B probing org A's pull requests by name or number; a member whose
GitHub read access was revoked but who keeps a Rocky session; a PR author who controls the diff
(markup, bidi controls, a huge or non-UTF-8 diff); a GitHub outage or a lying network path; a
signed-in member hammering the endpoint; whoever reads the logs.

| #   | What can go wrong                                                                                                                                                                                                              | Prevention                                                                                                                                                                                                         | Test (`apps/server/src/pulls/diff-routes.db.test.ts` unless noted)                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Cross-org read: org B's member reads org A's diff by the repository's name and number                                                                                                                                          | Ids from the session only; the PR resolved inside `withOrg` (RLS, plus the explicit org filter); an unknown PR is 404 before any GitHub call                                                                       | "unknown PR, unknown repository and another org's PR: the same 404, nothing asked of GitHub"; `packages/db/src/pull-request-page.test.ts` "…another org's PR (RLS)"; `auth/policy.db.test.ts` matrix rows (`otherOrg` → not found)                |
| D2  | A member whose GitHub access was revoked still reads the diff, from GitHub or from the cache                                                                                                                                   | The P3-6 check runs on every request before the reader; a deny is 404; a cache hit is served only after that check                                                                                                 | "GitHub access denied: the same 404 as an unknown PR, and no token is minted"; "serves a second read from the short cache, after a fresh access check for that member" (a denied member gets 404 from the warm cache)                             |
| D3  | The access check or the reader is not built and the diff is served anyway                                                                                                                                                      | 503 before anything is read; `startServer` builds the reader only with the app's key, next to the check                                                                                                            | "without the repository access check: 503, before reading anything"; "without a diff reader (no app key): 503…"                                                                                                                                   |
| D4  | A token broader than needed, for another repository, or leaked                                                                                                                                                                 | The mirror's `openRepository`: `repository_ids: [id]`, `contents`/`pull_requests: read`, the answer checked or the token revoked and refused (ADR 0010 M2); revoked in `finally`; never logged, stored or answered | "reads the diff from GitHub on a token for that one repository, read-only, revoked after" (the mint body, `revoked`, every request authorized); "logs carry ids…never…a token" (every issued token absent from logs and answers)                  |
| D5  | Diff content, names or titles reach the logs                                                                                                                                                                                   | The route logs ids, bytes, sha256, truncation and fixed outcomes; `ForgeReadError` carries a code; the log package's key redaction stays a net (it caught the first field name, `pull_diff`)                       | "logs carry ids, sizes, digests and outcomes: never diff content, a token or a name" (every line checked against the diff's lines, the names and the tokens)                                                                                      |
| D6  | A diff of another head than the page shows (and the drafts anchor to) is served silently                                                                                                                                       | GitHub's PR head is read first and must equal the mirror's; otherwise 409 and no compare read; the compare is pinned to the two shas                                                                               | "GitHub's head moved since the mirror's: 409 head_moved, no diff read, token revoked"; `diff-reader.test.ts` "a head that moved on GitHub…"                                                                                                       |
| D7  | An oversized diff exhausts memory or time, or a cut diff breaks the page                                                                                                                                                       | 1 MiB cap cut at a line (adapter), trimmed to whole files (reader), flagged; GitHub's refusal is 413; 30 s timeout; the web bounds characters and parses strictly                                                  | "a diff longer than the mirror's cap is cut to whole files and flagged; GitHub's refusal is 413"; `diff-reader.test.ts` "truncation…", "wholeFiles…"; `apps/web/src/data/diff-data.test.ts`                                                       |
| D8  | A member mints a token per request (mint amplification)                                                                                                                                                                        | Per-member limit before any work; the cache per org + repository + PR + revision for a minute; in-flight reads of one key share a session                                                                          | "rate-limits each member: 429 with Retry-After past the limit; another member is unaffected"; "serves a second read from the short cache…" (one mint for two members); `diff-reader.test.ts` cache suite                                          |
| D9  | The cache serves across tenants, across pull requests, after a revocation, or grows unbounded                                                                                                                                  | Key = org + repository + number + base + head; a hit still needs the member's fresh check; TTL ≤ 60 s; bounded by entries and bytes                                                                                | `diff-reader.test.ts` "keys by org, repository, number, base and head…", "SF1: two pull requests from one head against different bases never share a diff", "is bounded…", "refuses a TTL over a minute…"; D2's warm-cache deny                   |
| D10 | Content injection into the UI (markup, bidi, look-alike paths)                                                                                                                                                                 | Text-only React rendering and invisible-character markers (ADR 0023 §4), the lint ban on HTML sinks (ADR 0019 §4), the strict reader; JSON answers under `no-store` and `nosniff`                                  | `FileView.test.tsx` "untrusted content" suite (unchanged), "…fixed text per reason" (nothing from the answer on the page); e2e "every state…with fixed text and no content"; the a11y sweep                                                       |
| D11 | A client learns whether a PR exists in a repository it cannot read                                                                                                                                                             | A deny, an unknown PR, a lost repository and a missing PR on GitHub are the same 404                                                                                                                               | "unknown PR…the same 404"; "GitHub access denied: the same 404…"; "the installation can no longer read the repository, or GitHub has no such PR: 404"                                                                                             |
| D12 | A GitHub outage is read as a diff, as "not found", or outlives the outage in the cache                                                                                                                                         | `ForgeReadError` → 502, remembered 5 s at most; only GitHub's JSON 404 is "not there" (ADR 0010); the next request after that asks again                                                                           | "a GitHub outage: 502 forge_unavailable, remembered 5 s, the token revoked when one was minted"; `diff-reader.test.ts` "a forge failure…a retry asks again after 5 s"                                                                             |
| D13 | The session ends while the page is open and the diff request reveals or breaks something                                                                                                                                       | 401 → a fixed "sign in again" state with the login link; nothing else                                                                                                                                              | `diff-http-source.test.ts`; `FileView.test.tsx` "…offer a way out"; e2e state table                                                                                                                                                               |
| D14 | **Quota drain (review round 1, SF2):** failed reads were never cached, so one member at the old 30/min could cost about 5,400 installation calls an hour (above the 5,000 floor the worker shares), and N members N times that | Failures remembered 5–30 s under the same key; the per-org `diff.org` limit of 15 reads that reach GitHub a minute (≤ 60 calls/min, ≤ 3,600/h per org, whatever N); the per-member limit lowered to 10/min         | `diff-reader.test.ts` "SF2: remembers a fixed failure for its own short lifetime…", "SF2: asks beforeForge only when a session is about to open…"; db "SF2: the org's budget counts reads that reach GitHub only…"; `rate-limit.test.ts` defaults |
| D15 | The web shows "head moved" for commits GitHub no longer has (review round 1, SF3)                                                                                                                                              | The 409 body's `error` is matched against the two fixed codes and nothing else (never shown or logged); each has its own text and link                                                                             | `diff-http-source.test.ts` "tells the two 409s apart…"; `FileView.test.tsx`; e2e state table; visual `real-pr-diff-commits-unavailable-*`; the a11y sweep                                                                                         |

## Consequences

- Drafts (Accept, Edit, Dismiss, Undo, Send to agent), own comments and Finish review work end to
  end on a real pull request (e2e `real-pr.e2e.spec.ts`, against a mock server in the server's
  shapes).
- Each first open of a PR's file view costs four GitHub calls on the installation's budget (mint,
  pull request, compare, revoke), at most once a minute per org, pull request and revision
  across members and tabs for a diff (once per 5–30 s for a failure, §4), at most 10 requests a
  minute per member, and at most 15 reads that reach GitHub a minute per org (about 3,600
  installation calls an hour, D14).
- `AppDeps.pullRequestDiffs`; `RATE_LIMIT_SCOPES` gains `diff`; `RawDiffData.truncation` and
  `DiffData.truncated`; `DiffLoad` failures carry a reason and the diff context carries the PR.
- The access check's `createGitHubForge` instance is shared with the reader (one adapter, one
  clock); the H4-1 "token reuse per (installation, repository)" follow-up would now benefit both.

## Residual risks

- **The diff served can differ from the one the analysis read.** Both commits are pinned, so
  GitHub's answer for them is stable; the two can still diverge when (a) the head revision is
  not recorded yet and the pull request's own `base_sha` stands in (the mirror writes both from
  one GitHub read, so this needs a revision row to be missing while the pull request row
  exists, which the worker's single transaction never leaves behind), or (b) an `unavailable`
  reading was later replaced by a real one for the same commits (ADR 0010 §3; the text is the
  same, only the digest changed). Review round 1 (SF1) removed the third case, GitHub's live
  base, from the reader: the base is always the mirror's. The mirror's digest
  (`pr_revisions.diff_sha256`) is not compared, since a truncated reading's digest describes
  the raw cut, not the trimmed text. Follow-up: compare it for whole readings and show a note
  when it differs.
- **A cached diff outlives a `head_moved` by up to a minute.** A push changes the mirror's head,
  which is in the key, so a cached diff can never be served for the new head; but until the
  mirror catches up, the page keeps showing the mirrored head's diff, which is what it says it
  shows; the top bar's head and the next reload follow the mirror.
- **The limits and the cache are per process**, like every rate limit and cache (ADR 0025 R1);
  with n server instances the installation bound of §4 is n times larger.
- **A non-UTF-8 diff is shown lossily**, flagged by nothing; the analysis refused it, so no
  drafts can be wrong about it.
- **The timing oracle of H4-2** stands: an unknown PR answers before the access check, a known
  one after it.
- **The whole-files trim can drop one complete file** when the adapter's cut fell exactly on a
  file boundary (the trim cannot tell a complete last file from a cut one without parsing). It
  is flagged and on GitHub; nothing is shown that is incomplete.
