# ADR 0011: Repository access check (GitHub read access, cached for at most 5 minutes)

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P3-6
- **Amends:** [ADR 0007](0007-webhook-inbox.md) §1 (the outbound forge port gains
  `UserAccessReader`)

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
- `packages/core/src/forge.ts`: `UserAccessReader.readUserRepositoryAccess(credential,
repository)` is the forge-neutral question "can the holder of this credential read this
  repository?". It returns `{ access: "read" }` or `{ access: "none", reason }`, where `reason`
  is one of `not_found`, `no_read_permission`, `token_rejected`, `forbidden` or
  `repository_mismatch`, and throws `ForgeReadError` for anything else.
- `packages/forge-github/src/user-access.ts`: the GitHub reader (§2).
- `packages/db/src/access.ts`: `loadRepositoryAccessContext(tx, { memberId, forgeRepoId })`
  reads, inside `withOrg`, whether the member exists, the repository's `full_name`, the member's
  token ciphertext and the org's wrapped data key. It returns no plaintext.
- `apps/server/src/repository-access.ts`: `memberAccessSource` composes those three pieces, and
  `createRepositoryAccess` wraps it in the core service and logs each decision. The server is the
  composition root, so it is the only package that depends on `@rocky-reviews/crypto` for this.

The request names the repository by its forge id (`repos.forge_repo_id`), which never changes.
The name is read from the org's own mirror row, so another tenant's repository looks absent
(RLS), and only the mirror's name is ever put in a URL.

### 2. The GitHub call: `GET /repos/{owner}/{repo}` with the user's own token

Read access is `permissions.pull === true` in the answer, and only when the answer's `id` is the
repository asked about. Otherwise:

| Answer                                                                      | Result                                      |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| 200, `permissions.pull` true, same `id`                                     | read                                        |
| 200, `permissions.pull` false                                               | `no_read_permission`                        |
| 200, another `id` (a name reused after a delete, rename or transfer)        | `repository_mismatch`                       |
| GitHub's JSON 404 `{"message": "Not Found"}`                                | `not_found` (no access, or gone)            |
| 401                                                                         | `token_rejected` (expired, revoked)         |
| 403                                                                         | `forbidden` (SAML SSO, IP allow list, rate) |
| any other status, non-JSON or oversized (256 KiB) body, missing permissions | `ForgeReadError` → deny                     |
| redirect (renamed repository), timeout (10 s), network error                | `ForgeReadError` → deny                     |

The token must be printable ASCII, 16 to 512 characters. Anything else is `token_rejected`
without a request, so a stored value cannot inject a header. The repository name must have the
`owner/name` shape and its segments are URL-encoded, so it cannot inject a path.

Why this endpoint:

- **It asks as the user.** With the user's token, GitHub decides whether _this user_ can see the
  repository. For a GitHub App user token, the installation must also be able to see it, so the
  answer is the intersection Rocky cares about. One call answers both questions. No app-level
  credential is involved, and no new App permission is needed (ADR 0008 stays as it is).
- **It is the narrowest documented read that carries the user's permission.** The answer includes
  `permissions` for the authenticated user. Nothing is written, and only `id` and `permissions.pull`
  are read.
- **Rejected alternatives.**
  - `GET /repos/{owner}/{repo}/collaborators/{username}/permission` checks someone by _login_.
    Logins can be renamed and reused, so Rocky would have to trust its stored login. The endpoint
    also needs an installation token, and it answers about the user without the user's consent
    (a revoked token would not stop the access).
  - `GET /user/repos` and `GET /user/installations/{id}/repositories` page through every
    repository, which costs more and answers the wrong question.
  - `GET /repositories/{id}` would avoid the rename problem (§ Residual risks) but is not
    documented as an endpoint.

### 3. Policy: Rocky membership and GitHub read access, both checked

A request is allowed only if all of these hold:

- the member exists in the org (`not_member`);
- the org has the repository (`unknown_repository`);
- the member has a stored token (`no_token`);
- the token decrypts for that member (`token_unreadable`);
- GitHub says the user can read the repository.

For a **public** repository, GitHub reports `pull: true` for every user, so the check reduces to
Rocky membership plus a valid token. Rocky follows GitHub here, because GitHub is the source of
truth. Whether Rocky should require a collaborator role on public repositories is a product
decision, recorded under Residual risks.

### 4. The cache

- **Key:** the org id, member id (both lower-cased uuids) and repository id (a positive safe
  integer), validated before use. None of them can contain the separator. One member's entry can
  never answer for another member, another org or another repository. A request with malformed
  ids is denied (`invalid_request`) and is neither cached nor sent to GitHub.
- **Allow lifetime:** `ACCESS_MAX_TTL_MS` = 5 minutes, configurable down to 1 ms and never up.
  The constructor refuses a larger value. The lifetime is counted **from the moment before GitHub
  was asked**, not from when the answer arrived. GitHub's answer describes its state at that
  moment or later, so if a user is removed at time _r_, any allow still cached was asked at some
  _t_ < _r_ and expires by _t_ + 5 min < _r_ + 5 min. An entry is fresh only when `checkedAt ≤ now <
expiresAt`, so a clock that moves backwards does not keep an entry alive. An allow that
  arrives after its own expiry (a very slow answer) is a deny and is not stored. A clock that
  cannot be read is a deny.
- **What a cached allow means during an outage:** "GitHub said yes less than 5 minutes ago",
  and nothing more. It is served until its fixed expiry and **never extended**: there is no
  stale-while-error and no refresh-ahead based on an older answer. Once it expires, the next
  check asks GitHub, and if GitHub is down that check is a deny. An outage can therefore keep an
  existing allow for at most the rest of its 5 minutes, and that is exactly the bound the plan
  accepts for any change on GitHub. It never creates an allow, and never stretches one past
  5 minutes.
- **Denies are cached briefly:** 30 s (`DENY_TTL_MS`) for definitive answers (`not_found`,
  `no_read_permission`, `repository_mismatch`, `token_rejected`, `not_member`,
  `unknown_repository`, `no_token`), and 5 s (`TRANSIENT_DENY_TTL_MS`) for `forbidden`,
  `forge_unavailable`, `invalid_response`, `token_unreadable` and `error`. A cached deny can
  only delay a re-grant, never let anyone in. The short lifetime stops a denied user's requests,
  or every request during an outage, from each costing a GitHub call and a decryption. The
  invalidation hooks (below) clear a deny as soon as Rocky knows something changed, for example
  after a login.
- **Bounded:** at most `maxEntries` (default 10 000, configurable from 1 to 1 000 000). Eviction is
  least recently used: a hit moves the entry to the end. Expired entries are dropped when they
  are next looked up.
- **One question per key at a time:** concurrent checks for the same key share one GitHub call.
  Different keys never share.
- **Invalidation hooks:** `invalidateMember(org, member)` for login, logout, token refresh, role
  change or removal; `invalidateRepository(org, repo)` for a repository leaving the
  installation, being transferred, renamed or made private; `invalidateOrg(org)` for uninstall,
  suspension or erasure; and `clear()`. Each one bumps a generation counter. A check that started
  before an invalidation never writes its answer, and a check that starts after it never joins an
  older in-flight question.
- **Per process:** each server instance has its own cache. The bound holds per instance, so it
  holds overall. Invalidation is local, so a hook that must reach every instance needs a broadcast
  (follow-up). Until then the 5-minute bound is the guarantee.

### 5. Tokens

The member's token is stored encrypted (`members.forge_token_ciphertext`, ADR 0006, purpose
`github_token`, record id = member id). For each GitHub question, `memberAccessSource`:

1. reads the ciphertexts in one short `withOrg` transaction;
2. leaves the transaction, so none is held open across an HTTP call;
3. opens the org keyring, decrypts the token, and destroys the keyring in `finally`;
4. passes the token to the reader, which puts it in the `authorization` header of that one
   request.

The token is never returned, cached, logged, stored in plaintext, or put in an error. Errors are
`ForgeReadError` with a fixed reason and at most a status. A cache hit decrypts nothing. Because
the AAD binds the member's id, a ciphertext copied to another member's row does not decrypt.

Each decision is logged once (`event: "repository_access"`) with `orgId`, `memberId`,
`repositoryId`, `allowed`, `reason` and `cached` only. Fresh decisions are logged at `info` and
cache hits at `debug`. An observer error never changes a decision.

No migration and no new grants: `rocky_app` already reads `members`, `repos` and `orgs` under RLS
(migration 0003). P3-3's role split and the server's login allow-list are unchanged.

### 6. Where P7-1 and P7-2 must call it

The server will build one `createRepositoryAccess({ db, keys, reader, log })` at start-up, with
`reader = createGitHubUserAccessReader({ api })` and `keys` from `localKeyWrapperFromEnv()` or KMS.

- **P7-2 (route authorization).** Every route that reads or writes a repository's data must call
  `access.check({ orgId, memberId, repositoryId })` with the session's org and member, **after**
  the session, CSRF and role checks and **before** any tenant query for that repository's data.
  This covers the pull request list and page, revisions, analyses, findings and drafts, pending
  comments, project memory and embeddings of a repository, the change map, and ask/explain. A
  deny answers 404, the same as an unknown repository, so the answer does not reveal whether the
  repository exists. Lists that span repositories (inbox, search) must filter by `check` per
  repository; showing an item first and checking later is not acceptable. A route must never
  turn a denied or failed check into an allow, for example in a `catch`.
- **P3-5 (posting, after P7-1).** Before submitting a review, call `check` and refuse on deny.
  GitHub enforces access again when the review is posted with the user's token.
- **P7-1 (login and sessions).** After storing or refreshing a member's token, call
  `access.invalidateMember(orgId, memberId)` so an earlier `no_token` or `token_rejected` deny is
  dropped. On logout, delete the stored token and call `invalidateMember`. When a member is
  removed or their role changes, call `invalidateMember`.
- **Lifecycle and mirror.** When an org is scheduled for deletion, suspended or erased, call
  `invalidateOrg`. When a repository is removed from the installation, call
  `invalidateRepository`. These hooks only shorten the bound; correctness does not depend on them.

## Threat model

**Assets:** what a user may see of a repository in Rocky (tenant data per repository), users'
GitHub tokens, tenant boundaries, and log hygiene.

**Attackers:**

- a former collaborator who still has a Rocky session;
- a member of one org probing another org's repositories;
- a PR author or repository owner who controls names and GitHub-side state;
- a GitHub outage, or a lying or broken network path;
- a database reader looking for tokens;
- concurrent requests racing an invalidation.

| #   | What can go wrong                                                                           | Prevention                                                                                                                                                            | Test                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | A user removed on GitHub keeps access through the cache                                     | Allow lifetime ≤ 5 min, counted from before the question; never extended; a stale answer is a deny                                                                    | `access.test.ts` "allows until exactly 5 minutes…", "counts the 5 minutes from before the question…", "an allow that arrives after its own expiry…", "a clock that goes backwards…"; `repository-access.db.test.ts` "a user removed from the repository on GitHub loses access within 5 minutes"                                                                                                          |
| A2  | A GitHub outage turns into an allow, or extends one                                         | Every throw or unexpected answer is a deny; a cached allow is served only until its fixed expiry                                                                      | `access.test.ts` "serves the allow until its expiry during an outage, then denies", "fail closed" (16 error and answer shapes); `user-access.test.ts` status, body, timeout and network cases; e2e "a GitHub outage is a deny, never an allow"                                                                                                                                                            |
| A3  | One tenant's or member's cached allow answers for another                                   | Key = validated org uuid + member uuid + repository id; uuids normalised; invalid ids are never cached                                                                | `access.test.ts` "one member's allow never answers for another member, org or repository", "upper- and lower-case uuids are one entry…", "denies malformed requests…"; e2e "an allow cached for org A does not answer for org B"                                                                                                                                                                          |
| A4  | A member asks about another org's repository, or uses another org's member id               | The context is read inside `withOrg` (RLS): another org's rows are absent (`not_member`, `unknown_repository`); the name used in the URL comes from the org's own row | e2e "org B's member id under org A is not a member there (RLS)", "a repository of org A is unknown to org B…"                                                                                                                                                                                                                                                                                             |
| A5  | Rocky membership alone grants access, or GitHub access alone does                           | Both are required (§3)                                                                                                                                                | e2e "a member without a stored token is denied…", "a GitHub reader who is not a member of the org is denied"                                                                                                                                                                                                                                                                                              |
| A6  | A repository name reused by someone else (delete, recreate, rename onto) grants access      | The answer's `id` must equal the requested forge id (`repository_mismatch`); redirects are refused                                                                    | `user-access.test.ts` "an answer for another repository id is repository_mismatch", "a refused redirect"                                                                                                                                                                                                                                                                                                  |
| A7  | The token leaks through logs, errors, the cache or the database                             | Decrypted for one call; only in the authorization header; core never receives it; fixed-code errors; ids-only log fields; stored only as `rk1:` ciphertext (ADR 0006) | e2e "logs carry ids and fixed codes only; no token or ciphertext anywhere" (log capture, cache dump), "a database failure is a deny, and its text is never logged"; `user-access.test.ts` "throws a fixed ForgeReadError on … without the token", "asks as the user, with the token only in the authorization header"; `access.test.ts` "reports ids and fixed codes only"; P2-3 dump test for the column |
| A8  | A token copied to another member's row (database write access) is used for that member      | AAD binds the record id (member id): it does not decrypt (`token_unreadable`)                                                                                         | e2e "a token copied to another member's row does not decrypt…"                                                                                                                                                                                                                                                                                                                                            |
| A9  | A stored value injects a header, or a name injects a path                                   | Token shape check (no request); `owner/name` shape and encoded segments                                                                                               | `user-access.test.ts` "a malformed token is rejected without a request…", "refuses an invalid repository before any request…"                                                                                                                                                                                                                                                                             |
| A10 | Expired, revoked, SSO-blocked or rate-limited tokens are read as access                     | 401 → `token_rejected`, 403 → `forbidden`; both deny                                                                                                                  | `user-access.test.ts` "a revoked or expired token…", "denies on 401", "denies on 403…"; e2e "a revoked token is denied", "SSO enforcement or rate limiting (403) is a deny"                                                                                                                                                                                                                               |
| A11 | Memory grows without bound (many members and repositories, or a flood of distinct requests) | LRU with `maxEntries` (default 10 000); invalid requests are never stored                                                                                             | `access.test.ts` "never holds more than maxEntries…", "evicts in recency order", "refuses an unbounded or empty cache"                                                                                                                                                                                                                                                                                    |
| A12 | An invalidation (logout, removal) is undone by a check that was already in flight           | Generation counter: a check started before an invalidation does not write, and later callers do not join it                                                           | `access.test.ts` "a check in flight during an invalidation does not write its answer", "invalidateMember drops one member of one org only", "invalidateRepository drops…", "invalidateOrg and clear"                                                                                                                                                                                                      |
| A13 | Decryption or key failures are read as "no restriction"                                     | Wrong KEK, undecodable data key, missing data key, tampered ciphertext → `token_unreadable`                                                                           | e2e "the wrong key-encryption key is a deny", "an org without a data key is a deny", "a stored data key that does not decode is a deny"                                                                                                                                                                                                                                                                   |
| A14 | Each request costs a decryption and a GitHub call (load, rate limit)                        | Allow cached for 5 min, denies for 30 s or 5 s; one in-flight question per key; decryption only on a GitHub question                                                  | e2e "asks GitHub as the member, decrypting the token per question and never on a cache hit"; `access.test.ts` "concurrent checks for one key share one forge call…"                                                                                                                                                                                                                                       |

## Consequences

- The check exists, but nothing calls it until P7-2. Until then the server has no route that
  shows repository data, so nothing is exposed in the meantime.
- `@rocky-reviews/server` depends on `@rocky-reviews/crypto`.
- The fake GitHub (`packages/forge-github/src/testing.ts`) serves `GET /repos/{owner}/{repo}` for
  user tokens (`addUser`, `setPermission`, `revokeUserToken`, `setVisibility`,
  `failRoute("repository")`). New documentation-shaped fixtures: `get-repository.json` and
  `get-repository.unauthorized.json`.

## Residual risks

- **Up to 5 minutes of access after removal.** This is by design: the plan's bound. The
  `member`, `membership` and `repository` webhooks could shorten it through the invalidation
  hooks, but the app subscribes to `pull_request` only (ADR 0008). Subscribing to more events is
  a manifest change and needs a human decision.
- **Per-process cache.** Invalidation is local to one server instance, so other instances keep
  their entries until the 5-minute bound. A broadcast (Postgres `LISTEN/NOTIFY`) is a follow-up
  for when the server runs more than one instance.
- **Renamed repositories are denied** (GitHub answers with a redirect, which is refused) until the
  mirror's `full_name` is updated by the next pull request event or a rebuild. This fails closed.
  Follow-ups: follow only a redirect to `/repositories/{id}` on the API host, or update the name
  from the mirror.
- **Public repositories:** GitHub read access is universal, so any member of the org with a
  token is allowed (§3). Whether to require a collaborator role is a product decision for a
  human.
- **Token expiry and refresh:** a GitHub App user token expires (8 hours by default). Until P7-1
  stores and refreshes tokens, an expired token is denied (`token_rejected`) and is not
  refreshed.
- **Not verified against live GitHub:** the fixtures are documentation-shaped, not recorded. In
  particular, the `permissions` object returned to GitHub App user tokens should be confirmed on
  a real installation, together with the P3-3 recording follow-up. If GitHub omits
  `permissions`, the check denies (`invalid_response`); it does not allow.
- **The token is a JavaScript string,** so it cannot be zeroed after use. It lives only in one
  call's frame and is collected afterwards.
