# ADR 0011: Repository access check (GitHub read access, cached for at most 5 minutes)

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P3-6
- **Amends:** [ADR 0007](0007-webhook-inbox.md) §1 (the outbound forge port gains
  `UserAccessReader`)
- **Revised:** review round 1:
  - public and internal repositories require collaborator status (the user's decision);
  - the token is bound to the member's GitHub user id;
  - invalidation hooks validate their input;
  - generations are per org;
  - every caller gets a decision event;
  - `.`/`..` are refused as repository names;
  - §6 integration rules made concrete, with `resolveRepositoryForAccess`;
  - A15–A19.

## Context

Rocky stores derived data per repository: the pull request mirror (ADR 0010) and, later, analyses,
drafts, comments and project memory. Being a member of a Rocky org (one GitHub App installation,
ADR 0003) does not mean being able to read every repository of that installation on GitHub. People
leave teams, are removed as collaborators, or lose access when a repository is made private or
moved. GitHub is the source of truth for that access, so Rocky has to ask GitHub, as the user,
before it shows a repository's data. Asking on every request would be slow and would spend the
user's rate limit, so answers are cached. The cache needs a hard bound: a user removed on GitHub
must lose access within 5 minutes.

Login, sessions and CSRF (P7-1) and per-route role checks (P7-2) do not exist yet, so no route can
call the check today. This task builds the check and its wiring, and records where those tasks
must call it. P3-5 (posting as the user) has been deferred until after P7-1 (the user's decision)
and is not part of this task.

## Decision

### 1. Shape: a core service, a port, two adapters

- `packages/core/src/access.ts`: `createRepositoryAccessCheck({ source, clock, ... })` returns a
  `RepositoryAccessCheck` with `check({ orgId, memberId, repositoryId })` and invalidation hooks.
  It holds the cache and the fail-closed policy. It never sees a credential, because its port
  `RepositoryAccessSource.readAccess(request)` takes ids only.
- `packages/core/src/forge.ts`: `UserAccessReader.readUserRepositoryAccess({ token, userId },
repository)` is the forge-neutral question "is this credential `userId`'s, and can that user read
  this repository?". It returns `{ access: "read" }` or `{ access: "none", reason }`, where
  `reason` is one of `not_found`, `no_read_permission`, `token_rejected`, `forbidden`,
  `repository_mismatch`, `token_user_mismatch` or `not_collaborator`. It throws `ForgeReadError`
  for anything else.
- `packages/forge-github/src/user-access.ts`: the GitHub reader (§2).
- `packages/db/src/access.ts`:
  - `loadRepositoryAccessContext(tx, { memberId, forgeRepoId })` reads, inside `withOrg`, the
    member (existence and `forge_user_id`), the repository's `full_name`, the member's token
    ciphertext and the org's wrapped data key. It returns no plaintext.
  - `resolveRepositoryForAccess(tx, { repoId } | { pullRequestId })` is a route's first, narrow
    query (§6).
- `apps/server/src/repository-access.ts`: `memberAccessSource` composes those pieces, and
  `createRepositoryAccess` wraps them in the core service and logs each decision. The server is
  the composition root, so it is the only package that depends on `@rocky-reviews/crypto` for this.

The request names the repository by its forge id (`repos.forge_repo_id`), which never changes.
The name is read from the org's own mirror row, so another tenant's repository looks absent
(RLS), and only the mirror's name is ever put in a URL.

### 2. The GitHub calls, all made with the user's own token

1. **`GET /user`: whose token is this?** The answer's `id` must equal the member's
   `forge_user_id`; otherwise the result is `token_user_mismatch`. A valid token of someone else
   that ends up on a member's row (a bug in login, a database write) therefore grants nothing.
   The answer's `login` is the one used in step 3. It always comes from GitHub, for this token,
   and never from the request or the database.
2. **`GET /repos/{owner}/{repo}`: can this user read the repository?** Read access is
   `permissions.pull === true`, and only when the answer's `id` is the repository asked about.
   The answer must also carry `private` (a boolean) and `visibility` (a string).
3. **Only when the repository is not private:
   `GET /repos/{owner}/{repo}/collaborators/{login}/permission`.** "Not private" means
   `private !== true` or `visibility !== "private"`: public, internal, or anything unexpected.
   - For these repositories `pull` proves nothing: every GitHub user can read a public
     repository, and every enterprise member an internal one. The user's decision is that this
     does not count.
   - The user must be a collaborator with any role. The answer must say `permission` `admin`,
     `write` or `read` (`maintain` is reported as `write`, `triage` as `read`), with a `role_name`,
     for a `user.id` equal to the token's.
   - `none`, or GitHub's JSON 404, is `not_collaborator`.

A private repository costs two calls (identity and repository). Any other repository costs three.

| Answer (any call)                                                                                                                                                   | Result                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/user` id ≠ `forge_user_id`                                                                                                                                        | `token_user_mismatch`                                                                   |
| repository 200, `pull` true, same `id`, private                                                                                                                     | read                                                                                    |
| repository 200, `pull` true, same `id`, not private, collaborator `admin/write/read`                                                                                | read                                                                                    |
| collaborator `none`, or collaborator JSON 404                                                                                                                       | `not_collaborator`                                                                      |
| repository 200, `pull` false                                                                                                                                        | `no_read_permission`                                                                    |
| repository 200, another `id` (a name reused after a delete, rename or transfer)                                                                                     | `repository_mismatch`                                                                   |
| repository JSON 404 `{"message": "Not Found"}`                                                                                                                      | `not_found` (no access, or gone)                                                        |
| 401                                                                                                                                                                 | `token_rejected` (expired, revoked)                                                     |
| 403                                                                                                                                                                 | `forbidden` (SAML SSO, IP allow list, rate limit, an endpoint refusing app user tokens) |
| any other status, non-JSON or oversized (256 KiB) body, a missing or mistyped field (`visibility`, `permissions`, `role_name`, `user`), another `user.id` in step 3 | `ForgeReadError` → deny                                                                 |
| redirect (renamed repository), timeout (10 s per call), network error                                                                                               | `ForgeReadError` → deny                                                                 |

Input checks:

- The token must be printable ASCII, 16 to 512 characters. Anything else is `token_rejected`
  without a request, so a stored value cannot inject a header.
- The repository name must have the `owner/name` shape, and `.` and `..` are refused as names.
  Its segments, and the login, are URL-encoded, so neither can inject a path.
- The API base must be https and end with `/`.

Why these endpoints:

- **They ask as the user.** With the user's token, GitHub decides whether _this user_ can see the
  repository. For a GitHub App user token, the installation must also be able to see it, so the
  answer is the intersection Rocky cares about. No app-level credential is involved, and no new
  App permission is needed (ADR 0008 stays as it is).
- **`GET /repos/{owner}/{repo}` is the narrowest documented read that carries the user's
  permission and the repository's visibility.** Only `id`, `private`, `visibility` and
  `permissions.pull` are read.
- **For collaborator status, the permission endpoint and not the 204/404 check.**
  `GET /repos/{owner}/{repo}/collaborators/{username}` answers exactly "is a collaborator", but
  GitHub documents that "the authenticated user must have push access to the repository to use
  this endpoint". Read and triage collaborators would therefore be refused, and could not check
  themselves. The permission endpoint documents no such requirement, answers 404 for a
  non-collaborator, and returns the `user.id` it answered about, which is bound to the token's.
- **The login is GitHub's, never Rocky's.** It is taken from `GET /user` for this token, so a
  renamed or reused login cannot point the question at someone else. The id in the answer must
  match as well.
- **Rejected alternatives:**
  - `GET /user/repos` and `GET /user/installations/{id}/repositories` page through every
    repository, which costs more and answers the wrong question.
  - `GET /repositories/{id}` would avoid the rename problem (Residual risks) but is not
    documented as an endpoint.

### 3. Policy: Rocky membership, the member's own token, and GitHub access

A request is allowed only if all of these hold:

- the member exists in the org (`not_member`);
- the org has the repository (`unknown_repository`);
- the member has a stored token (`no_token`);
- the token decrypts for that member (`token_unreadable`);
- GitHub says the token is the member's GitHub user (`token_user_mismatch`);
- GitHub says the user can read the repository;
- for a repository that is not private, the user is a collaborator (`not_collaborator`).

So the 5-minute criterion holds for every visibility: removing a collaborator from a public or
internal repository ends access exactly like removing them from a private one.

Org state (`repos.enabled`, `orgs.delete_after`, `orgs.erasing_at`) is not part of this check.
Gating on it belongs to P7-1/P7-2, at the session and route level.

### 4. The cache

- **Key:** the org id, member id (both lower-cased uuids) and repository id (a positive safe
  integer), validated before use. None of them can contain the separator. One member's entry can
  never answer for another member, another org or another repository. A request with malformed
  ids is denied (`invalid_request`) and is neither cached nor sent to GitHub.
- **Allow lifetime:** `ACCESS_MAX_TTL_MS` = 5 minutes, configurable down to 1 ms and never up.
  The constructor refuses a larger value.
  - The lifetime is counted **from the moment before GitHub was asked**, not from when the answer
    arrived. GitHub's answer describes its state at that moment or later. So if a user is removed
    at time _r_ (as GitHub's API reports it), any allow still cached was asked at some _t_ < _r_
    and expires by _t_ + 5 min < _r_ + 5 min.
  - An entry is fresh only when `checkedAt ≤ now < expiresAt`, so a clock that moves backwards
    does not keep an entry alive.
  - An allow that arrives after its own expiry (a very slow answer) is a deny and is not stored.
  - A clock that cannot be read is a deny.
- **What a cached allow means during an outage:** "GitHub said yes less than 5 minutes ago",
  and nothing more. It is served until its fixed expiry and **never extended**: there is no
  stale-while-error and no refresh-ahead based on an older answer. Once it expires, the next
  check asks GitHub, and if GitHub is down that check is a deny. An outage can keep an existing
  allow for at most the rest of its 5 minutes, which is the bound the plan accepts for any change
  on GitHub. It never creates an allow, and never stretches one past 5 minutes.
- **Denies are cached briefly.** A cached deny can only delay a re-grant, never let anyone in.
  - 30 s (`DENY_TTL_MS`) for definitive answers: `not_found`, `no_read_permission`,
    `repository_mismatch`, `token_rejected`, `token_user_mismatch`, `not_collaborator`,
    `not_member`, `unknown_repository`, `no_token`.
  - 5 s (`TRANSIENT_DENY_TTL_MS`) for `forbidden`, `forge_unavailable`, `invalid_response`,
    `token_unreadable` and `error`.
  - The short lifetime stops a denied user's requests, or every request during an outage, from
    each costing GitHub calls and a decryption. The invalidation hooks clear a deny as soon as
    Rocky knows something changed, for example after a login.
- **Bounded:** at most `maxEntries` (default 10 000, configurable from 1 to 1 000 000). Eviction is
  least recently used: a hit moves the entry to the end. Expired entries are dropped when they
  are next looked up.
- **One question per key at a time:** concurrent checks for the same key share one GitHub
  question. Different keys never share. Every caller gets its own decision event; a caller that
  waited for another's question is reported with `joined: true`.
- **Invalidation hooks:**
  - `invalidateMember(org, member)`: login, logout, token refresh, role change, removal.
  - `invalidateRepository(org, repo)`: a repository leaving the installation, transferred,
    renamed or made private.
  - `invalidateOrg(org)`: uninstall, suspension, erasure.
  - `clear()`.

  They must be called **after** the transaction that changed the token, membership or repository
  has committed. Called before it, a concurrent check could read the old row and cache it again.

- **Hook input:** validated with the same rules as the key. Each hook returns `true` for valid
  ids. Invalid ids fail closed and return `false`: an invalid member or repository id (a string,
  a bigint, a float) drops every entry of that org, and an invalid org id clears the whole cache.
- **Generations, per org.** An invalidation bumps its org's generation; `clear()` and an invalid
  org id bump the global one. A check writes its answer only if neither changed since it
  started. So within an org, a check that started before an invalidation never caches its
  answer, and a check that starts after it never joins an older in-flight question. An
  invalidation in org A never stops org B's checks from caching. The per-org table is bounded
  like the cache: past `maxEntries` orgs it is reset with a global bump, which only prevents
  caching.
- **Per process:** each server instance has its own cache. The bound holds per instance, so it
  holds overall. Invalidation is local, so a hook that must reach every instance needs a
  broadcast (follow-up). Until then the 5-minute bound is the guarantee.

### 5. Tokens

The member's token is stored encrypted (`members.forge_token_ciphertext`, ADR 0006, purpose
`github_token`, record id = member id). For each GitHub question, `memberAccessSource`:

1. reads the ciphertexts and `forge_user_id` in one short `withOrg` transaction;
2. leaves the transaction, so none is held open across an HTTP call;
3. opens the org keyring, decrypts the token, and destroys the keyring in `finally`;
4. passes `{ token, userId: forge_user_id }` to the reader, which puts the token only in the
   `authorization` header of its requests.

The token is never returned, cached, logged, stored in plaintext, or put in an error. Errors are
`ForgeReadError` with a fixed reason and at most a status. A cache hit decrypts nothing.

Three bindings stop a token from being used for anyone else:

- the AAD binds the member's id, so a ciphertext copied to another member's row does not decrypt;
- the org's own data key is used, so a ciphertext moved to another org does not decrypt either;
- `GET /user` binds the plaintext to the member's GitHub user id.

Each caller's decision is logged (`event: "repository_access"`) with `orgId`, `memberId`,
`repositoryId`, `allowed`, `reason`, `cached` and `joined` only. Fresh decisions are logged at
`info` and cache hits at `debug`. An observer error never changes a decision.

No migration and no new grants: `rocky_app` already reads `members`, `repos`, `pull_requests` and
`orgs` under RLS (migration 0003). P3-3's role split and the server's login allow-list are
unchanged.

### 6. Where P7-1 and P7-2 must call it

The server will build one `createRepositoryAccess({ db, keys, reader, log })` at start-up, with
`reader = createGitHubUserAccessReader({ api })` and `keys` from `localKeyWrapperFromEnv()` or KMS.

**P7-2 (route authorization).** Every route that reads or writes a repository's data follows
these steps, in this order:

1. Take `orgId` and `memberId` from the authenticated session, **never** from the request (no
   path, query, body or header).
2. Run the session, CSRF and role checks.
3. Resolve only the repository's forge id from the route parameter:
   `resolveRepositoryForAccess(tx, { repoId } | { pullRequestId })`. This is one narrow query in
   its own short `withOrg`, and `null` answers like a deny.
4. Call `access.check({ orgId, memberId, repositoryId })` **outside any transaction**.
5. Only on an allow, load the repository's data.

This covers the pull request list and page, revisions, analyses, findings and drafts, pending
comments, project memory and embeddings of a repository, the change map, and ask/explain.

P7-2 route tests must show that a deny causes **zero** data queries: only the resolve query
runs, which can be checked by counting statements or with a `withOrg` spy.

**One answer for every deny.** Every deny answers the client the same way, **404**, the same as
an unknown repository, whatever the reason. The reason goes to the log only.

Transient reasons (`forge_unavailable`, `forbidden`, `invalid_response`, `error`) also answer 404,
not 503. A 503 would be returned only for repositories that exist in the org (unknown ones are
`unknown_repository` without a GitHub call), so it would tell a member who cannot read a
repository that it exists. Clients can tell "GitHub is down" from a separate, non-repository
status signal. A transient deny is cached for 5 s only, so a retry soon succeeds.

**Lists and errors.** Lists that span repositories (inbox, search) must filter by `check` per
repository. Showing an item first and checking later is not acceptable. A route must never turn a
denied or failed check into an allow, for example in a `catch`.

**P3-5 (posting, after P7-1).** Before submitting a review, call `check` and refuse on deny.
GitHub enforces access again when the review is posted with the user's token.

**P7-1 (login and sessions).**

- Before storing a token, verify that `GET /user`'s `id` equals the member's `forge_user_id`, and
  refuse to store it otherwise. The check also verifies this on every question; storing a wrong
  token must still not happen.
- After the transaction that stores or refreshes a member's token has committed, call
  `access.invalidateMember(orgId, memberId)` so an earlier `no_token` or `token_rejected` deny is
  dropped.
- On logout, delete the stored token, commit, then call `invalidateMember`.
- When a member is removed or their role changes, call `invalidateMember` after the commit.

**Lifecycle and mirror.** After the transaction that schedules deletion, suspends or erases an
org commits, call `invalidateOrg`. After a repository is removed from the installation, call
`invalidateRepository`. These hooks only shorten the bound; correctness does not depend on them.

**Org state** (`repos.enabled`, `orgs.delete_after`/`erasing_at`) is gated by P7-1/P7-2, not here.

## Threat model

**Assets:** what a user may see of a repository in Rocky (tenant data per repository), users'
GitHub tokens, tenant boundaries, and log hygiene.

**Attackers:**

- a former collaborator who still has a Rocky session;
- a member of one org probing another org's repositories;
- a PR author or repository owner who controls names and GitHub-side state;
- a GitHub outage, or a lying or broken network path;
- a database reader or writer looking for, or moving, tokens;
- concurrent requests racing an invalidation.

| #   | What can go wrong                                                                                                            | Prevention                                                                                                                                                                                                                                                                 | Test                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | A user removed on GitHub keeps access through the cache                                                                      | Allow lifetime ≤ 5 min, counted from before the question; never extended; a stale answer is a deny                                                                                                                                                                         | `access.test.ts` "allows until exactly 5 minutes…", "counts the 5 minutes from before the question…", "an allow that arrives after its own expiry…", "a clock that goes backwards…"; `repository-access.db.test.ts` "a user removed from the repository on GitHub loses access within 5 minutes"                                                                                                          |
| A2  | A GitHub outage turns into an allow, or extends one                                                                          | Every throw or unexpected answer is a deny; a cached allow is served only until its fixed expiry                                                                                                                                                                           | `access.test.ts` "serves the allow until its expiry during an outage, then denies", "fail closed" (16 error and answer shapes); `user-access.test.ts` status, body, timeout and network cases for all three calls; e2e "a GitHub outage is a deny, never an allow", "every error of the collaborator call denies"                                                                                         |
| A3  | One tenant's or member's cached allow answers for another                                                                    | Key = validated org uuid + member uuid + repository id; uuids normalised; invalid ids are never cached                                                                                                                                                                     | `access.test.ts` "one member's allow never answers for another member, org or repository", "upper- and lower-case uuids are one entry…", "denies malformed requests…"; e2e "an allow cached for org A does not answer for org B, even for a name GitHub resolves"                                                                                                                                         |
| A4  | A member asks about another org's repository, or uses another org's member id                                                | The context and the route resolve are read inside `withOrg` (RLS): another org's rows are absent; the name used in the URL comes from the org's own row                                                                                                                    | e2e "org B's member id under org A is not a member there (RLS)", "a repository of org A is unknown to org B…"; `access.db.test.ts` "another org's repository or pull request, or an unknown id, is null (RLS)"                                                                                                                                                                                            |
| A5  | Rocky membership alone grants access, or GitHub access alone does                                                            | All conditions of §3 are required                                                                                                                                                                                                                                          | e2e "a member without a stored token is denied…", "a GitHub reader who is not a member of the org is denied"                                                                                                                                                                                                                                                                                              |
| A6  | A repository name reused by someone else (delete, recreate, rename onto) grants access                                       | The answer's `id` must equal the requested forge id (`repository_mismatch`); redirects are refused                                                                                                                                                                         | `user-access.test.ts` "an answer for another repository id is repository_mismatch", "a refused redirect"                                                                                                                                                                                                                                                                                                  |
| A7  | The token leaks through logs, errors, the cache or the database                                                              | Decrypted for one call; only in the authorization header; core never receives it; fixed-code errors; ids-only log fields; stored only as `rk1:` ciphertext (ADR 0006)                                                                                                      | e2e "logs carry ids and fixed codes only; no token or ciphertext anywhere" (log capture, cache dump), "a database failure is a deny, and its text is never logged"; `user-access.test.ts` "throws a fixed ForgeReadError on … without the token", "asks as the user, with the token only in the authorization header"; `access.test.ts` "reports ids and fixed codes only"; P2-3 dump test for the column |
| A8  | A token copied to another member's row, or to another org's member row, is used for that member                              | AAD binds the record id (member id), and each org has its own data key: neither decrypts (`token_unreadable`)                                                                                                                                                              | e2e "a token copied to another member's row does not decrypt…", "a ciphertext moved to another org's member row does not decrypt…"                                                                                                                                                                                                                                                                        |
| A9  | A stored value injects a header, or a name injects a path                                                                    | Token shape check (no request); `owner/name` shape without `.`/`..`; encoded segments and login; API base ends with `/`                                                                                                                                                    | `user-access.test.ts` "a malformed token is rejected without a request…", "refuses an invalid repository or user id before any request…", "F: `.` and `..` are not repository names…", "refuses a non-https API base, and one that does not end with /"                                                                                                                                                   |
| A10 | Expired, revoked, SSO-blocked or rate-limited tokens are read as access                                                      | 401 → `token_rejected`, 403 → `forbidden` on every call; both deny                                                                                                                                                                                                         | `user-access.test.ts` "a revoked or expired token…", "denies on 401", "denies on 403…", "GET /user 401/403…", "collaborator call: 401/403…"; e2e "a revoked token is denied", "SSO enforcement or rate limiting (403) is a deny"                                                                                                                                                                          |
| A11 | Memory grows without bound (many members and repositories, or a flood of distinct requests)                                  | LRU with `maxEntries` (default 10 000); invalid requests are never stored; the per-org generation table is bounded too                                                                                                                                                     | `access.test.ts` "never holds more than maxEntries…", "evicts in recency order", "refuses an unbounded or empty cache", "the per-org generation table stays bounded"                                                                                                                                                                                                                                      |
| A12 | An invalidation (logout, removal) is undone by a check that was already in flight                                            | Per-org generation: a check started before an invalidation of its org does not write its answer, and callers arriving after it do not join it. Callers that were already waiting on that question when the invalidation landed get its (pre-invalidation) answer, uncached | `access.test.ts` "a check in flight during an invalidation does not write its answer", "invalidateOrg(A) and clear() keep their guarantees", "invalidateMember drops one member of one org only", "invalidateRepository drops…", "invalidateOrg and clear"                                                                                                                                                |
| A13 | Decryption or key failures are read as "no restriction"                                                                      | Wrong KEK, undecodable data key, missing data key, tampered ciphertext → `token_unreadable`                                                                                                                                                                                | e2e "the wrong key-encryption key is a deny", "an org without a data key is a deny", "a stored data key that does not decode is a deny"                                                                                                                                                                                                                                                                   |
| A14 | Each request costs a decryption and GitHub calls (load, rate limit)                                                          | Allow cached for 5 min, denies for 30 s or 5 s; one in-flight question per key; decryption only on a GitHub question                                                                                                                                                       | e2e "asks GitHub as the member, decrypting the token per question and never on a cache hit"; `access.test.ts` "concurrent checks for one key share one forge call…"                                                                                                                                                                                                                                       |
| A15 | A removed collaborator keeps access to a public or internal repository, because every user (or enterprise member) has `pull` | For a repository that is not private, collaborator status is required (§2 step 3); unknown or inconsistent visibility is treated as not private; a missing `visibility` is a deny                                                                                          | e2e "public/internal: a removed collaborator loses access within exactly 5 minutes", "…a non-collaborator is denied although GitHub says pull: true"; `user-access.test.ts` "A: public and internal repositories require collaborator status" (roles, removal, visibility shapes, every error of the call)                                                                                                |
| A16 | A valid token of another GitHub user on a member's row grants that member access                                             | `GET /user` id must equal `forge_user_id` (`token_user_mismatch`, a definitive deny); P7-1 checks the same before storing                                                                                                                                                  | e2e "a valid token of another GitHub user stored on the member's row is denied"; `user-access.test.ts` "a token of another GitHub user is token_user_mismatch, before the repository is read", "GET /user … denies without reading the repository"                                                                                                                                                        |
| A17 | A buggy caller passes a malformed id to a hook and silently invalidates nothing                                              | Hooks validate input like the key; invalid ids drop the whole org (or the whole cache) and return `false`                                                                                                                                                                  | `access.test.ts` "C: invalidation hooks validate their input and fail closed"                                                                                                                                                                                                                                                                                                                             |
| A18 | A route loads data before the check, or takes the org or member from the request                                             | §6: session ids only; resolve only `forge_repo_id`; check outside any transaction; P7-2 tests prove zero data queries on a deny                                                                                                                                            | `access.db.test.ts` "resolveRepositoryForAccess" (narrow resolve, RLS, input refusal); P7-2 route tests (required)                                                                                                                                                                                                                                                                                        |
| A19 | The client learns why a check denied (repository exists, GitHub down)                                                        | Every deny answers 404; the reason goes to the log only                                                                                                                                                                                                                    | P7-2 route tests (required)                                                                                                                                                                                                                                                                                                                                                                               |

## Consequences

- The check exists, but nothing calls it until P7-2. Until then the server has no route that
  shows repository data, so nothing is exposed in the meantime.
- `@rocky-reviews/server` depends on `@rocky-reviews/crypto`.
- A check that asks GitHub costs two calls for a private repository and three for a public or
  internal one.
- The fake GitHub (`packages/forge-github/src/testing.ts`) serves, for user tokens, `GET /user`,
  `GET /repos/{owner}/{repo}` and the collaborator permission endpoint. Its controls are
  `addUser`, `setPermission`, `revokeUserToken`, `setVisibility` (public, internal, private) and
  `failRoute("user" | "repository" | "collaborator")`.
- New documentation-shaped fixtures: `get-repository.json`, `get-repository.unauthorized.json`,
  `get-authenticated-user.json` and `get-collaborator-permission.json`.

## Residual risks

- **Up to 5 minutes of access after removal.** This is by design: the plan's bound. The
  `member`, `membership` and `repository` webhooks could shorten it through the invalidation
  hooks, but the app subscribes to `pull_request` only (ADR 0008). Subscribing to more events is
  a manifest change and needs a human decision.
- **GitHub-side lag.** The bound runs from when GitHub's API reports the change. If GitHub takes a
  while between a permission removal and its API answers reflecting it (caches, replication),
  that delay is added on top of the 5 minutes, and Rocky cannot observe it.
- **Per-process cache.** Invalidation is local to one server instance, so other instances keep
  their entries until the 5-minute bound. A broadcast (Postgres `LISTEN/NOTIFY`) is a follow-up
  for when the server runs more than one instance.
- **Renamed repositories are denied** (GitHub answers with a redirect, which is refused) until the
  mirror's `full_name` is updated by the next pull request event or a rebuild. This fails closed.
  Follow-up: follow one redirect, only to `{api}/repositories/{id}` on the API host and with the
  same id.
- **The collaborator endpoint is not verified against a live installation for GitHub App user
  tokens.**
  - If GitHub refuses it for app user tokens (403), or requires more than documented, every
    public and internal repository is denied (`forbidden`). This fails closed, but would lock
    out legitimate collaborators.
  - If GitHub reported a role other than `none` for a non-collaborator on a public repository,
    which is not documented, the check would allow them. Both behaviours need a live
    confirmation (needs a human with a test installation).
- **Org-level base permissions:** GitHub's collaborator answer counts members who have access
  through the organisation's default (base) permission. For an organisation-owned public
  repository with base permission `read`, every org member counts as a collaborator. That is
  GitHub's definition and is accepted.
- **Token expiry and refresh:** a GitHub App user token expires (8 hours by default). Until P7-1
  stores and refreshes tokens, an expired token is denied (`token_rejected`) and is not
  refreshed.
- **Fixtures are documentation-shaped, not recorded.** The `permissions` and `visibility` fields
  for GitHub App user tokens should be confirmed on a real installation, together with the P3-3
  recording follow-up. If a field is missing, the check denies (`invalid_response`); it does not
  allow.
- **The token is a JavaScript string,** so it cannot be zeroed after use. It lives only in one
  call's frame and is collected afterwards.
