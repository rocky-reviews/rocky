# ADR 0045: Token mode, a personal access token instead of the GitHub App

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-11
- **Task:** P10-4
- **Builds on:** [ADR 0006](0006-envelope-encryption.md) (envelope encryption),
  [ADR 0020](0020-github-login-and-sessions.md) (sessions, cookies, CSRF),
  [ADR 0026](0026-posting-as-the-user.md) (posting as the member, with their token),
  [ADR 0034](0034-pull-request-diff-endpoint.md) (the diff read on demand),
  [ADR 0044](0044-setup-wizard.md) (the setup wizard and its one-time link)

## Context

Some self-hosters cannot install a GitHub App: their organization forbids third-party apps, or
the server has no public URL GitHub could deliver webhooks to (a laptop, a VM behind NAT, an
air-gapped network with GitHub Enterprise Server). For them Rocky offers a second way in: one
person connects Rocky with their own personal access token. There is one user, no OAuth, no
webhooks and no public URL. The App stays the recommended path.

The rest of Rocky (analysis, memory, posting, the mirror and its rebuild) assumes an org that
came from an App installation. The change must leave that path untouched, keep the token-mode
org isolated by RLS exactly like an App org, and make token mode impossible on Rocky Cloud.

## Decision

### 1. One switch, refused where Rocky Cloud runs

`ROCKY_GITHUB_CONNECTION=app|token` (default `app`), read by the server and the worker.

- `token` is refused when `FLY_APP_NAME` is set (Rocky Cloud runs on Fly.io), and when any
  GitHub App variable is set (`GITHUB_APP_ID`, `…_PRIVATE_KEY`, `…_CLIENT_ID`,
  `…_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`): a server connects one way, never both.
- The KEK (`ROCKY_KEK_KEYS`) is required in token mode, in every environment: the token is
  stored encrypted and there is no fallback.
- `ROCKY_PUBLIC_URL` may be `http://127.0.0.1:<port>` (or `localhost`) even in production: nothing
  outside needs to reach Rocky, and the browser reaches it through the loopback (or an SSH
  forward). Any other http URL is refused.
- **Database backstop.** `auth.create_token_org` (migration 0024) creates the token org only
  when no App org exists and no other live token org does; a partial unique index
  (`orgs_one_live_token`) settles two saves at once. A Cloud database, which has App orgs, can
  never gain one, even if the configuration check were bypassed.
- **Boot warnings** (never refusals): plain http with a `HOST` that is not a loopback address
  (bare metal with `HOST=0.0.0.0` would serve the session and the sign-in link in clear to the
  network), and token mode with no token connected and the wizard off (the sign-in link would
  sign nobody in).

### 2. Schema (migration 0024)

- `orgs.connection` (`app` | `token`), immutable (the identity trigger). CHECKs: an App org has
  an `installation_id`, a token org has none and is a `user` account.
- `worker.installation_orgs` and `auth.login_orgs` only see App orgs: no webhook or GitHub login
  can resolve to the token org.
- `auth.create_token_org` and `auth.token_org` (SECURITY DEFINER, owned by `rocky_auth`): the
  only ways to create and find the token org before a session exists. Create runs inside
  `withOrg` for the new id, so RLS on `orgs` (FORCE) still applies.
- `auth.refresh_token_org_login`: the token org's display login follows its owner's GitHub login
  (read again on every token save); that one column, of the current tenant's token org, for its
  own account only (column grant, policy, and the identity trigger's exception for `rocky_auth`).
- `repos.synced_at`: when Rocky last read a repository's pull requests.
- The down migration drops the column only when no token org is left: a migration never deletes
  tenant data; remove the org first (erasure) to roll back.

Every other tenant table and policy is unchanged; the token org is a tenant like any other
(RLS by `org_id`, `withOrg`).

### 3. The token: stored like a member's GitHub token

The token is the owner's member token: `members.forge_token_ciphertext`, encrypted with the
org's data key (purpose `github_token`, record id the member id) under the KEK, exactly as App
logins store theirs. The repository access check, posting (ADR 0026) and the diff reader then
work unchanged; reviews post as the token's owner.

- **On save** (wizard or the connection page): `GET /user` (who, which kind, the expiry header,
  a classic token's scopes) and a listing probe (`GET /user/repos`). Refused with a fixed code:
  wrong shape, rejected, expired, a classic token without `repo`/`public_repo`
  (`missing_permissions`; only when GitHub listed the scopes, read leniently), rate limited
  (with when to retry), GitHub unavailable. Replacing a token must keep the same GitHub user
  (`token_user_mismatch`), and is bound to the caller's org: another org is refused before GitHub
  is asked or anything is written.
- **Kinds.** A fine-grained token is recommended (Contents read, Pull requests read and write,
  Metadata read). A classic token is accepted with a warning (it reaches every repository of the
  user). An expiry within 14 days is warned about.
- The token is never returned (answers describe it: kind, login, expiry, warnings), never logged
  (ids, codes and sizes only), never in an error message, and removable: removing it clears the
  ciphertext; Rocky stops reading GitHub until a new one is saved.

### 4. Sign-in: one user, a one-time link on stderr

There is no OAuth App, so no GitHub login. At boot the server prints a one-time sign-in link
(`/auth/token/start?token=…`, 256 bits, compared by hash in constant time, single use, 20 wrong
tries per client before a lockout) on stderr, the same primitive as the setup link (ADR 0044),
extracted to `auth/one-time-link.ts`. Opening it creates a normal session for the token's owner
(the org's owner member) and redirects to `/inbox`. The link is spent only when a session was
issued: opened before a token is saved (or on a failure), it stays usable. A lost or used link:
restart the server for a new one. Saving the token in the wizard signs the operator in directly.

Sessions are those of ADR 0020 (cookies, CSRF), with a 1-day idle and 7-day absolute lifetime.
A 401 answer carries `signIn: "token_link"` so the web app says where the link is instead of
offering "Sign in with GitHub".

### 5. Pull requests: on demand, no webhooks, no polling

The owner adds repositories on `/connection` (from those the token can see). Rocky reads pull
requests when someone looks:

- **Sync** on the connection page and the inbox (`POST /api/connection/sync`); at most once every
  5 s per org.
- **Adding a repository** syncs it.
- **Opening the inbox** syncs when the last sync is older than 60 s.
- **Opening a pull request** re-reads that one pull request (at most once a minute).

No request waits for GitHub longer than 4 s (`REQUEST_WAIT_MS`): the work goes on in the
background and the answer says so (`outcome: "running"`, `sync.state: "running"`,
`syncing: true` on the connection page; the pull request page shows the mirror's row). The web
app asks again a few times. A proxy or tunnel timeout therefore never cuts a sync half-way.

A sync lists the open pull requests (up to 200 per repository) and re-reads only those Rocky
still shows open that the listing did not return (to see them closed or merged): old closed pull
requests are never read. One GitHub no longer has (404) is closed in the mirror, so it is not
read again. New heads are queued for analysis when `ROCKY_ANALYSIS_AUTO=on`,
through the same queue as the App's webhook path. The mirror code (`mirrorPullRequest`, the
rebuild loop) moved from the worker to `packages/mirror` so both paths share it.

GitHub's rate limit (a 403/429 with `x-ratelimit-remaining: 0`, or a secondary limit: 403/429
with `retry-after`, or a bare 429), on every read including the streamed diff, becomes
`rate_limited` with the time to retry; the sync stops, keeps what it has, and the answer says when to retry. Nothing runs in
the background on a timer.

### 6. Pipeline reuse

- `forge-github`: `createGitHubTokenClient` beside the App client, on the same HTTP core
  (`client.ts`, extracted from `repositories.ts`). `RepositoryLocator.installationId` and
  `PullRequestRef.installationId` are nullable; the App path still passes one.
- The worker's analysis opens a token org's repository through a token opener (decrypts the
  owner's token with the KEK; refuses `no_token`, `token_expired`, `token_unreadable`); App orgs
  keep the installation token. Nothing else in the worker changes, and no App lane runs.
- A new permission, `connection.manage` (owner), guards the connection API; the sync needs
  `pull_requests.review`.
- **Ask is off** in token mode for now: it reads code through the App's installation. A
  follow-up.

## Threat model

| What can go wrong                                         | Prevention                                                                                       | Test                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| The token leaks from the database or a backup             | Envelope encryption under the KEK; plaintext never stored                                        | `token-mode.db.test.ts`: the dump has no plaintext          |
| The token leaks through an answer, log or error           | Answers validated against strict schemas; fixed refusal codes; logs carry ids and codes only     | `token-mode.db.test.ts`, worker `token-mode.e2e.test.ts`    |
| Another tenant reads the token org's data (or vice versa) | RLS by `org_id` on every table; `withOrg`; definer functions scoped to the current org           | `token-connection.test.ts`, `token-mode.db.test.ts` tenancy |
| Token mode switched on in Rocky Cloud                     | Refused with `FLY_APP_NAME`; the database refuses a token org where App orgs exist               | `config.test.ts` (both apps), `token-connection.test.ts`    |
| A webhook or GitHub login lands in the token org          | `installation_orgs` and `login_orgs` filter `connection = 'app'`; no App variables in token mode | `token-connection.test.ts`                                  |
| Someone on the network signs in                           | One-time 256-bit link on stderr, single use, lockout; loopback http only, https otherwise        | `one-time-link.test.ts`, `token-mode.db.test.ts`            |
| Cross-site requests use the session                       | The CSRF guard (ADR 0020 §5) on every write, including the token save                            | `token-mode.db.test.ts` (CSRF refusal)                      |
| A replaced token belongs to someone else                  | Same GitHub user required (`token_user_mismatch`)                                                | `token-mode.db.test.ts`                                     |
| A repository the token cannot see is added                | Read through the token before it is followed; refused otherwise                                  | `token-mode.db.test.ts` (hidden repository)                 |
| Rate limits exhausted by Rocky                            | Syncs on demand only, throttled; open listing only; stop on `rate_limited` and say when          | `token-mode.db.test.ts` (rate limit)                        |
| PR content steers the model into side effects             | Unchanged: schema-validated output, only a person posts (ADRs 0012, 0026)                        | existing analysis tests                                     |

## Consequences

- Reviews post as the token's owner, not as a bot; GitHub shows them as that person's.
- No automatic updates: Rocky is as fresh as the last sync. An analysis starts only after a sync
  sees the new head.
- One user per server. Others who need Rocky need the App.
- A fine-grained token's pull-request write permission is only proven at the first post (GitHub
  has no read-only probe for it); a missing one fails that post with GitHub's refusal.
- The in-process sync lock assumes one server process (the compose file runs one).
