# ADR 0033: The repository access check runs in the server

- **Status:** Accepted
- **Date:** 2026-10-30
- **Task:** H4-1 (dogfooding readiness; not a plan row)
- **Amends:** [ADR 0011](0011-repository-access-check.md) §6 (the composition root now exists),
  [ADR 0024](0024-org-roles-and-access-policy.md) (its first residual risk is closed),
  [ADR 0026](0026-posting-as-the-user.md), [ADR 0027](0027-review-drafts.md) and
  [ADR 0029](0029-review-inbox-and-bulk-approval.md) (their routes no longer answer 503 for want
  of the check)

## Context

P3-6 built the repository access check and P7-1/P7-2 made every route that reads a repository's
data call it, but `startServer` never built one: `AppDeps.repositoryAccess` stayed undefined, so
on a running server the drafts API (P6-4), the review preview and posting (P3-5), the inbox (P6-7)
and "Analyze anyway" (P7-2) answered 503. Building it needs two things the server did not hold
together: the members' stored GitHub user tokens (login, ADR 0020, already there) and the app's
private key, for the membership step of ADR 0011 §2 (an installation token with `metadata: read`
is minted to ask whether a user is a collaborator of a public or internal repository).

## Decision

### 1. The server holds the app's key, like the worker

`githubAppAuthFromEnv` (`apps/server/src/config.ts`) parses `GITHUB_APP_ID` with
`GITHUB_APP_PRIVATE_KEY` into a `KeyObject` through `parseGitHubAppAuth`, exactly as the worker
does (ADR 0009). The PEM text is not kept; `main.ts` deletes the variable from `process.env` once
the server is up (ADR 0009 L24). It is required in production (`NODE_ENV=production` or
`FLY_APP_NAME`), like the other secrets the server needs there. Outside production an unset key
means no check. A key that is set but malformed, or set without the id, refuses to boot anywhere.

### 2. One check per process, built in `startServer`

When login is configured (client id and secret, a KEK) and the key is present, `startServer`
builds:

```
createRepositoryAccess({
  db, keys, log,
  reader: createGitHubUserAccessReader({
    api,
    collaborators: cacheMembershipDenials(
      createGitHubForge({ auth: appAuth, api, clock }), { clock }),
  }),
})
```

`cacheMembershipDenials` (`apps/server/src/repository-access.ts`, review round 1, W11) remembers
"not a collaborator" answers for at most the core's deny lifetime (30 s), keyed by installation,
repository and the login GitHub gave for the token. Only `false` is remembered: a remembered
`true` would stretch ADR 0011's 5-minute bound by the cache's lifetime (the check dates its allow
from its own question, not from the older membership answer), while a remembered `false` can only
delay a re-grant, like the core's deny cache. Errors are never remembered.

and passes it as `AppDeps.repositoryAccess`. `buildApp` already hands it to the drafts, inbox,
posting and role routes; no route changed. The member's own token asks GitHub (steps 1 and 2 of
ADR 0011 §2); the app's key mints the installation token for step 3.

Its `invalidateMember` is passed as `AuthDeps.onMemberTokenChanged`, which P7-1 and P7-2 already
call after every commit that stores a token (sign-in), clears it (sign-out with the last session,
a superseded session, "not a member" at sign-in), changes a role, removes, restores, or transfers
ownership. The observer never changes an outcome (callers catch), and the 5-minute bound holds
without it.

### 3. Fail closed when it cannot be built

- No key outside production: one boot line, `GITHUB_APP_PRIVATE_KEY is not set: repository access
check disabled; routes that read a repository's data answer 503 (development only)`, the
  `server listening` line carries `repositoryAccess: false`, and `AppDeps.repositoryAccess` stays
  undefined, so every such route keeps answering 503 (`access_check_unavailable`,
  `posting_unavailable`). Nothing is ever allowed in its place.
- No login (no client id, or no KEK): no session can exist, so no such route is reachable; the
  check is not built and `repositoryAccess` is `false`.
- A wrong key (another app's, rotated away) does not open anything: the mint answers 401, the
  membership step throws, and ADR 0011's reader denies. Private repositories need no mint, so a
  wrong key shows as every public and internal repository being denied.

### 4. What was wired, and what deliberately was not

| `AppDeps` field       | Before                 | Now                                             |
| --------------------- | ---------------------- | ----------------------------------------------- |
| `repositoryAccess`    | never passed (503)     | built here when login and the key are present   |
| `reviewPosting`       | passed (poster + keys) | unchanged; its routes now get the check too     |
| `pullRequestApprover` | never passed (503)     | **still not passed**: P6-7's approver is a P3-5 |
|                       |                        | follow-up that is not approved; bulk approval   |
|                       |                        | keeps answering 503 `approve_unavailable`       |

### 5. Removal from another process

The worker's `org_member` lane (ADR 0024 §6) cannot reach the server's in-process cache. It does
not need to for membership: it deletes the person's token and their `session_orgs` links, and the
access policy resolves the member from the session **on every request**, so a removed person
answers 409 `no_active_org` (link cut) or 403 `not_a_member` (row removed) before any route reaches
the cache. The same holds for a removal through the role routes, which is tested here. What the
cache can still hold is an allow for a member who lost **repository** access on GitHub while
keeping their org membership and session: that is ADR 0011's 5-minute bound, unchanged. A
cross-instance broadcast stays a follow-up for when more than one server process runs.

## Threat model

**Assets:** a repository's derived data (drafts, review plans, inbox items, analyses); the
members' GitHub user tokens; the app's private key; tenant boundaries; log hygiene.

**Attackers:** a member whose GitHub access was removed, with a live session; a member of one org
reaching another org's repository of the same GitHub id; a GitHub outage or a lying network path;
an operator who deploys without the key or with the wrong one; anyone reading logs or the process
environment; PR content (titles, names) is untrusted but never reaches this path except as the
mirror's repository name, which ADR 0011 validates.

| #   | What can go wrong                                                                                                                                                                                                                                                                                    | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Test (`apps/server/src/server.access.db.test.ts` unless noted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | The check cannot be built (no key, no KEK, no login) and a route answers as if allowed                                                                                                                                                                                                               | `AppDeps.repositoryAccess` stays undefined → every route keeps its 503; one boot line; production refuses to boot without the key                                                                                                                                                                                                                                                                                                                                              | "keeps every route that needs the check at 503 and says so once at boot"; `server.test.ts` "without GITHUB_APP_PRIVATE_KEY…", "refuses to start in production…"; `config.test.ts`                                                                                                                                                                                                                                                                                                                                             |
| W2  | A stale allow outlives a change Rocky knows about (role change, removal, restore, sign-out, sign-in)                                                                                                                                                                                                 | `invalidateMember` wired as `onMemberTokenChanged`, called after each such commit (P7-1/P7-2); the allow's 5-minute bound holds regardless                                                                                                                                                                                                                                                                                                                                     | Observable through the routes: "a role change drops the target's cached allow…". Sign-out, restore and sign-in all call the same hook, so through the routes only "the allow is gone after sign-out + sign-in" and "after removal + restore + sign-in" are observable, not which call dropped it; that sign-in, sign-out (last session) and "not a member" each call the hook is asserted with a spy in `auth.db.test.ts`. The sign-out and restore calls are defence in depth over the sign-in call that always follows them |
| W3  | A member removed in Rocky (route or worker webhook) keeps using a cached allow                                                                                                                                                                                                                       | The policy resolves the member from the session on every request; removal cuts the session link and marks the row: 409/403 before the cache                                                                                                                                                                                                                                                                                                                                    | "a removal in Rocky is refused before the cache"; ADR 0024 R4, R8                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| W4  | A GitHub outage is read as an allow                                                                                                                                                                                                                                                                  | Every throw or unexpected answer denies (ADR 0011); a transient deny is cached 5 s and never turns into an allow                                                                                                                                                                                                                                                                                                                                                               | "a GitHub outage is a deny (404), never an allow"                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| W5  | One org's cached allow answers for another org's repository with the same GitHub id                                                                                                                                                                                                                  | Cache key = org + member + repository (ADR 0011 §4); org B asks GitHub with its own mirror name and member                                                                                                                                                                                                                                                                                                                                                                     | That the key includes the org (same member uuid, two orgs): `packages/core/src/access.test.ts` "one member's allow never answers for another member, org or repository". End to end, where member ids differ per org: "an allow cached in org A does not answer for org B" shows org B asks GitHub itself and is denied                                                                                                                                                                                                       |
| W6  | A member's question is asked with another member's token                                                                                                                                                                                                                                             | Each question decrypts the row's own ciphertext under the org's key with the member id as AAD, and `GET /user` must answer the member's `forge_user_id` (ADR 0011 A8, A16)                                                                                                                                                                                                                                                                                                     | `repository-access.db.test.ts` "a token copied to another member's row…", "a valid token of another GitHub user…"; here: "answers 200 … asking GitHub as that member once"                                                                                                                                                                                                                                                                                                                                                    |
| W7  | The app's key, a user token, an installation token or a ciphertext reaches the log or the environment                                                                                                                                                                                                | Key parsed to a `KeyObject`, PEM dropped from `process.env` after boot; decisions log ids and fixed codes only (ADR 0011 §5); tokens live in one call's frame                                                                                                                                                                                                                                                                                                                  | "logs carry ids and fixed reasons only…"; `server.test.ts` "the key never reaches the log"; `config.test.ts` "without echoing it"                                                                                                                                                                                                                                                                                                                                                                                             |
| W8  | A wrong or rotated key lets the membership step pass                                                                                                                                                                                                                                                 | Only a 204 on a token the fake (and GitHub) verified allows; a bad mint is a throw → deny (ADR 0011 A2, A21)                                                                                                                                                                                                                                                                                                                                                                   | "a public repository: membership is asked on an installation token the server mints with its key" (a non-collaborator with `pull: true` is denied)                                                                                                                                                                                                                                                                                                                                                                            |
| W9  | A client learns whether a repository exists, or that GitHub is down, from a deny                                                                                                                                                                                                                     | Every deny is the same 404 `not_found` as an unknown id; the reason goes to the log only (ADR 0011 §6)                                                                                                                                                                                                                                                                                                                                                                         | "answers 404 … the same as an unknown id, and no data"                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| W10 | Bulk approval starts posting because the check now exists                                                                                                                                                                                                                                            | `pullRequestApprover` is still not passed; the approvals route answers 503 `approve_unavailable` first                                                                                                                                                                                                                                                                                                                                                                         | "bulk approval stays 503 even with the check"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| W11 | One signed-in member drains the installation's rate limit (shared with the worker): `GET /api/inbox` checks up to 100 repositories, each public or internal one mints and revokes a token, and the member can drop their own 30 s deny entries at will (every sign-in and sign-out invalidates them) | `cacheMembershipDenials` below the member's cache: "not a collaborator" is remembered per installation + repository + login for the core's deny lifetime (30 s), which no invalidation reaches; one such answer costs at most one mint per 30 s. `true` is not remembered (the 5-minute bound), so a collaborator's fresh question still mints; that path is bounded by the member's own allow cache (5 min) and by the login rate limit (30 per 10 min per address, ADR 0025) | `membership-cache.test.ts` (false remembered for exactly the deny lifetime, true and errors never, keyed per installation/repository/login, malformed input uncached, clock backwards, LRU bound, lifetime capped at `DENY_TTL_MS`); e2e "a public repository…" (after sign-out + sign-in the non-collaborator's question asks GitHub as the user again but mints no token; the collaborator's does)                                                                                                                          |

## Consequences

- The server now needs `GITHUB_APP_PRIVATE_KEY` (and `GITHUB_APP_ID`) in production, like the
  worker; `.env.example` and the H3 runbook say so. Whoever holds the key is the app, so the
  server's environment is as sensitive as the worker's was already.
- `RunningServer.repositoryAccess` and the `server listening` line report whether the check is on.
- Every public or internal repository question by a collaborator now mints and revokes an
  installation token from the server, at most once per 5 minutes per member and repository
  (ADR 0011 A14's token-reuse follow-up applies to the server too); a non-collaborator's costs at
  most one mint per 30 s per repository and login (W11).
- The drafts, posting, inbox and "Analyze anyway" routes answer per GitHub access on a running
  server; bulk approval does not (by decision).

## Residual risks

- **Up to 5 minutes of access after a repository-level removal on GitHub** (ADR 0011's bound),
  for a member who keeps their org membership and session.
- **The cache is per process.** A worker-side removal cannot clear it, but cannot need to (§5). A
  second server instance would keep its own entries up to the bound; a broadcast is still a
  follow-up.
- **The membership step is still not confirmed against a live installation** (ADR 0011's blocker
  for public and internal repositories). Dogfooding on a private repository does not exercise it;
  the first public repository will, and a wrong assumption shows as denies, never allows.
- **The PEM is in `process.env` until the server is up** (then deleted), the same window the
  worker accepts (ADR 0009 L24).
- **Collaborators' membership answers are not cached** (W11), so a member who is a collaborator
  of many public repositories and signs in repeatedly still costs one mint per repository per
  sign-in; the login rate limit bounds it. Reusing one `metadata: read` installation token per
  (installation, repository) for a few minutes (ADR 0011 A14) would remove the mint entirely.
