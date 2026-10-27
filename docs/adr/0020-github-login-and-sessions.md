# ADR 0020: GitHub login and sessions (PKCE, database sessions, CSRF)

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P7-1
- **Amends:** [ADR 0005](0005-migrations-and-roles.md) (four more non-tenant tables in `app`, a
  role `rocky_auth` and a schema `auth` with one SECURITY DEFINER function),
  [ADR 0011](0011-repository-access-check.md) §6 (what P7-1 does with the token, done here)

## Context

Rocky needs to know who is using it before P7-2 (roles), P3-5 (posting as the user) and the web
app (P6) can do anything for a person. GitHub is the source of truth for identity and for which
installations (Rocky orgs) a person belongs to. The GitHub App created by the manifest flow
(ADR 0008) is already the OAuth client: it has `callback_urls: [<ROCKY_PUBLIC_URL>/auth/github/callback]`
and issues expiring user-to-server tokens, which P3-6's access check uses.

Sessions are user-level (one person, several orgs), while every tenant table is behind RLS and
`withOrg` (ADR 0003). Login therefore needs one narrow cross-tenant read: "which orgs are these
installations?".

## Decision

### 1. The flow (GitHub App user authorization, PKCE S256)

1. `GET /auth/github/login?returnTo=/path`: the server makes a 256-bit `state` and a 256-bit PKCE
   verifier, stores `sha256(state)` with the validated `returnTo` in `app.login_attempts`
   (10 minutes; the database caps it at 15), sets the **login cookie**
   (`__Host-rocky_login = v1.<state>.<verifier>.<exp>.<HMAC>`, 10 minutes) and redirects to
   `https://github.com/login/oauth/authorize` with `client_id`, the exact `redirect_uri`, `state`
   and `code_challenge` (S256).
2. `GET /auth/github/callback?code&state`: the login cookie is cleared in every answer. The state
   must equal the cookie's (constant time) and the cookie's HMAC and expiry must hold; then the
   attempt row is **deleted** (`DELETE … RETURNING`), which is how a state is spent: once, even
   by concurrent requests. Only then is GitHub asked:
   - `POST /login/oauth/access_token` (server side, client secret and verifier in the body,
     `Accept: application/json`, no redirects, 10 s, 256 KiB cap). GitHub answers OAuth errors
     with a 200 and an `error` field; each becomes a fixed reason. The refresh token is dropped
     unread (§4).
   - `GET /user` with the new token: the identity is the numeric `id`. The `login` is display
     data, refreshed on the member row.
   - `GET /user/installations` (paged, at most 1000): installations of this app the user can
     access. Other apps' (when `GITHUB_APP_ID` is set) and suspended ones are ignored.
3. `auth.login_orgs(forge, installation_ids, account_ids)` returns the live orgs bound to those
   pairs (both ids must match, as orgs bind by both: ADR 0009). An org scheduled for deletion or
   being erased is not offered.
4. Per org, in its own `withOrg`: upsert the member by `(org_id, forge_user_id)` (new members get
   the default role `member`; roles are P7-2's), provision the org's data key on first use,
   encrypt the token outside any transaction and store it (§4). A failure in one org leaves that
   org out of the session and is logged; the others still work.
5. Any session cookie this browser presented is revoked (`superseded`, audited): **fixation**.
   A new 256-bit session token is issued; only its sha256 is stored. The session links the orgs
   bound in step 4 (`app.session_orgs`). With exactly one org it is active; with several the
   person chooses (`POST /api/session/active-org`).
6. `auth.login` is audited in every bound org (actor: the member, target: the session row). If
   that fails, the session is revoked and the login fails: there is no unaudited session.
7. `303` to `returnTo`, rebuilt as an absolute URL on the public origin after a second validation.

### 2. Sessions in the database

`app.sessions` (migration 0013) holds `token_sha256`, the user, the active org, `created_at`,
`last_seen_at`, `idle_timeout_seconds`, `expires_at` and the revocation. Times come from the
server's clock (testable), bounded by the database:

- **Absolute expiry:** `min(login + 24 h, the GitHub token's expiry)` (8 h with GitHub's default
  expiring tokens). `expires_at ≤ created_at + 7 days` is a CHECK, and the application role has no
  UPDATE on `expires_at`, `idle_timeout_seconds`, `created_at`, `user_id` or `token_sha256`
  (column grants): it cannot extend or move a session.
- **Idle expiry:** 8 hours without a request. `last_seen_at` is moved at most once a minute.
- **Lookup:** a session is live only when not revoked, `created_at ≤ now < expires_at` and
  `now < last_seen_at + idle`. The active org counts only while `session_orgs` links it.
- **Revocation:** logout and re-login set `revoked_at`. The UPDATE policy matches live rows only,
  so a revoked session cannot be revived; DELETE matches only ended rows (housekeeping,
  `purgeEnded`). Revocation is server-side: a stolen cookie stops working at once.
- `app.session_orgs (session_id, org_id, member_id)` references `members (org_id, id)` with
  `ON DELETE CASCADE`: removing a member in Rocky removes that org from all their sessions at
  once, and erasing an org (ADR 0009) cascades through members. `sessions.active_org_id`
  references `orgs` with `ON DELETE SET NULL`. The deletion suite now seeds a session.
- `app.users` binds a forge identity by `(forge, forge_user_id)`; no login, name or email.

### 3. Cookies

| Cookie                 | Value                                  | Flags                                                        |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `__Host-rocky_session` | 256-bit random (base64url), hash in DB | `Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=<lifetime>` |
| `__Host-rocky_login`   | state, verifier, expiry, HMAC-SHA256   | `Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`        |

- `__Host-` makes the browser refuse the cookie unless it is Secure, host-only (no `Domain`) and
  `Path=/`, so a sibling subdomain cannot plant or overwrite it. Only the prefixed name is read;
  an unprefixed or duplicated cookie counts as none.
- SameSite=Lax (not Strict) because GitHub's redirect back to the callback is a cross-site
  top-level navigation that must carry the login cookie.
- **Dev-only exception:** with `ROCKY_PUBLIC_URL` on `http://127.0.0.1` / `localhost` / `[::1]`
  outside production, cookies have no `Secure` and no `__Host-` prefix (browsers drop Secure
  cookies on plain http). Production (`NODE_ENV=production` or Fly.io) refuses a non-https public
  URL at boot, and the server warns at boot whenever the exception is in use.

### 4. The GitHub token

Kept, because P3-6's access check (and P3-5 later) asks GitHub as the user. Per org the person
is a member of, it is stored in `members.forge_token_ciphertext`, envelope-encrypted with the
org's data key (ADR 0006, purpose `github_token`, record id = member id), with its expiry in
`members.forge_access_expires_at`. The token never reaches a log, an error, a response or the
database in plaintext; the dump test proves the last.

- **The refresh token is not stored.** Sessions are capped at the access token's lifetime, so
  Rocky never needs to refresh; storing an unused six-month credential would only add risk. The
  person signs in again after at most 8 hours (one redirect when GitHub already knows them).
  P3-5 may revisit this if longer sessions are needed; then refresh rotates the token in every
  org's row and must be serialised.
- ADR 0011 §6: the member row is created from `GET /user` for this very token, so the token is
  `forge_user_id`'s by construction; `onMemberTokenChanged` (the access check's
  `invalidateMember`) runs after each commit that stores or clears it.
- **Logout** deletes the stored token in the session's orgs when the user has no other live
  session (another browser keeps working), then calls `invalidateMember`.
- A user with no Rocky org gets a session with no orgs and no stored token.

### 5. CSRF

One global `onRequest` hook in `buildApp` covers every route whose method is not GET, HEAD or
OPTIONS, so P7-2's routes are protected without opting in. It runs before the body is read. A
request passes only when:

1. `Sec-Fetch-Site`, if sent, is `same-origin` (`same-site` is refused: a sibling subdomain is
   another site for Rocky);
2. `Origin` equals the public origin, or, without `Origin`, the `Referer`'s origin does; with
   neither it is refused;
3. `x-rocky-csrf` equals HMAC(session secret, the session cookie's token): a synchronizer token
   bound to that session, served by `GET /api/session` (same-origin only, no CORS) and never
   stored.

The only exemption is a route that declares `config: { csrfExempt: "hmac_signature" }`: the
GitHub webhook receiver, authenticated by its body signature and reading no cookie. Without login
configured, every non-exempt state-changing request is refused. Logout is `POST /auth/logout`
only; a GET is a 404 and changes nothing. SameSite=Lax is an extra layer, not the control.

### 6. Open redirect

`returnTo` is validated when the login starts and again before the redirect
(`apps/server/src/auth/return-to.ts`): RFC 3986 path/query/fragment characters only (no
backslash, whitespace, control or non-ASCII character, so no look-alike slashes), exactly one
leading `/`, no encoded `/`, `\`, `%`, space or control character, no malformed escape, then the
WHATWG URL parser must resolve it to Rocky's own origin and the normalised path must not start
with `//` (`/.//evil.com`) or point back at `/auth`. Anything else becomes `/`. The database
CHECK on `login_attempts.return_to` is a backstop. The redirect target is rebuilt as an absolute
URL on the public origin.

### 7. The cross-tenant read

`auth.login_orgs` is `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog`, owned
by the new NOLOGIN role `rocky_auth`, which holds column SELECT on six columns of `orgs` (`id`,
`forge`, `installation_id`, `account_id`, `delete_after`, `erasing_at`) through a `USING (true)`
policy, and nothing else. It returns ids only, for pairs the caller names, at most 1000. The app
role executes it; PUBLIC does not. The installation ids come from GitHub for the user's own
token, never from the request.

### 8. Configuration

`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` (both or neither), `ROCKY_PUBLIC_URL`,
`ROCKY_SESSION_SECRET` (≥ 32 printable characters; the HMAC key for the login cookie and the
CSRF token) and `ROCKY_KEK_KEYS`. All required in production; in development, without client
credentials login is off (warned) and without a session secret one is generated per process.
`GITHUB_APP_ID`, when set, filters installations by app id. Values are never logged or echoed.

### 9. API for the web app

| Route                          | Answer                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/session`             | 200 `{ authenticated, user: {id, forgeUserId}, orgs: [{id, login, memberId, memberLogin, role}], activeOrgId, csrfToken, expiresAt, idleExpiresAt }`, or 401 |
| `POST /api/session/active-org` | `{ orgId }` → 200 (the session), 404 if not one of the session's orgs or no longer a member, 400 malformed                                                   |
| `POST /auth/logout`            | 204 and a cleared cookie                                                                                                                                     |
| `GET /auth/github/login`       | 302 to GitHub                                                                                                                                                |

`apps/web/src/session.ts` wraps them. Every answer is `Cache-Control: no-store`. In development
the Vite server must proxy `/auth` and `/api` so the browser sees one origin, and
`ROCKY_PUBLIC_URL` must be that origin.

For P7-2, `app.sessionAuth.activeMember(request)` returns `{ sessionId, userId, orgId, memberId,
role }` only after the member row was re-read inside `withOrg` (same GitHub user, org not being
deleted). Org data is touched only after that, in `withOrg(orgId)`; the ids never come from the
request (ADR 0011 §6).

### 10. Rate limits

Not in this task (P7-3). `AuthDeps.rateLimit(scope)` registers a limiter on the auth routes'
encapsulated scope; P7-3 passes `@fastify/rate-limit` there.

## Threat model

**Assets:** sessions (the right to act as a person), users' GitHub tokens, tenant boundaries,
the session secret and the client secret, log hygiene.

**Attackers:** a malicious site the victim visits (CSRF, login CSRF, open redirect); a network
or a sibling subdomain trying to plant or read cookies; someone with a copied cookie or callback
URL (history, Referer, logs); a member of one org probing another; someone with a database dump;
a GitHub answer that is wrong or hostile; a person removed from an org.

| #   | What can go wrong                                                                          | Prevention                                                                                                                                                                                 | Test                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **Session fixation:** an attacker plants a session id, the victim logs in under it         | Any presented session is revoked at login; a new random id is issued every login; only hashes are looked up                                                                                | `auth.db.test.ts` "session fixation (acceptance criterion)": "a session id planted in the browser before login is never the session after login", "an attacker-chosen value that is not a session is ignored, and the new id is fresh every login", "re-login revokes the previous session and audits it"                  |
| L2  | **CSRF:** a cross-site page makes the victim's browser change something                    | Global guard: Sec-Fetch-Site, exact Origin (or Referer), session-bound synchronizer token; refused before the body is read; webhooks the only declared exemption                           | `auth.db.test.ts` "CSRF (acceptance criterion)": "a cross-site POST with the victim's cookie is refused and changes nothing" (10 variants), "every state-changing route is guarded by default, including routes added later", "without login configured, every non-exempt state-changing route is refused"; `csrf.test.ts` |
| L3  | **Open redirect** after login                                                              | §6 allow-list + structural checks + URL-parser origin check, twice; DB CHECK backstop; absolute target on the public origin                                                                | `auth.db.test.ts` "open redirect (acceptance criterion)" (every vector, end to end); `return-to.test.ts` (vectors, accepted paths, a 2000-run property that anything accepted stays on origin)                                                                                                                             |
| L4  | **Login CSRF:** the victim is logged in as the attacker (attacker's code in their browser) | State bound to this browser by the HMAC'd login cookie and compared in constant time; GitHub is not asked otherwise                                                                        | "a callback without this browser's login cookie is refused (attacker's code in the victim's browser)"                                                                                                                                                                                                                      |
| L5  | **Replay** of a callback URL, a state or a code                                            | State consumed by `DELETE … RETURNING` (atomic, once); code single-use at GitHub; PKCE verifier only in the cookie                                                                         | "a state works once: replaying the callback URL is refused"; `sessions.test.ts` "two concurrent consumptions of one state: exactly one wins"; `oauth.test.ts` "a code works once"                                                                                                                                          |
| L6  | An intercepted code is redeemed by someone else                                            | PKCE S256: the verifier never leaves the server and the browser's HttpOnly cookie; client secret on the server                                                                             | "logs in: S256 PKCE, server-side exchange…"; `oauth.test.ts` "PKCE: a wrong verifier is bad_verification_code, and the code is spent", "S256 matches RFC 7636 appendix B"                                                                                                                                                  |
| L7  | A forged or stretched login cookie                                                         | HMAC-SHA256 over state, verifier and expiry under the session secret; expiry checked                                                                                                       | "a forged or expired login cookie is refused"; `csrf.test.ts` "the login cookie verifies only with the secret, unchanged and unexpired"                                                                                                                                                                                    |
| L8  | **Session replay** with a stolen or old cookie                                             | Server-side revocation, idle (8 h) and absolute (≤ 24 h, ≤ token) expiry enforced at lookup; the app role cannot extend or revive                                                          | "idle: unused for 8 hours ends the session…", "absolute: a session never outlives the GitHub token…", logout "Replaying the old cookie after logout gets nothing"; `sessions.test.ts` "idle expiry…", "absolute expiry…", "the application role cannot extend, move or revive a session"                                   |
| L9  | **Cookie scope:** a subdomain or the network plants or reads cookies                       | `__Host-` + Secure + HttpOnly + host-only + Path=/; unprefixed and duplicated names ignored; dev exception only on loopback http outside production                                        | "only the __Host- cookie counts…", cookie flag assertions in "logs in…", "cookie scope in development (documented exception)"; `config.test.ts` (production refuses http)                                                                                                                                                  |
| L10 | **Token theft** from the database, logs or errors                                          | Token envelope-encrypted per org, AAD bound to the member; session and state stored as sha256 only; refresh token never stored; errors are fixed codes                                     | "stores the user token envelope-encrypted per org, bound to the member; only hashes of cookie and state" (pg_dump grep); `sessions.test.ts` "stores only sha256(token)…", "stores only sha256(state)…"; `oauth.test.ts` "sends the secret only in the token request body…"                                                 |
| L11 | **Mixing up users across orgs:** a session reaches an org the person is not a member of    | Orgs come from GitHub for the user's own token, both ids must match, dying orgs excluded; member re-read in `withOrg` on use; member removal cascades to sessions; composite FK member↔org | "a user who can access one installation gets that org only…", "removing the member in Rocky ends that org for the session at once", "switching the active org: only to an org of the session…", "activeMember resolves ids from the session only…"; `sessions.test.ts` "auth.login_orgs…" (3), composite FK case           |
| L12 | Identity confused by a renamed or reused GitHub login                                      | Bound by the numeric id only (users, members)                                                                                                                                              | "identity is the numeric GitHub id: a renamed login is the same member, a reused login is not"                                                                                                                                                                                                                             |
| L13 | **Logout** that does not log out (GET, client-only, token left behind)                     | POST-only, CSRF-checked, server-side revocation, cookie cleared, token deleted with the last session, `invalidateMember`, audited                                                          | "logout: is POST-only: GET does nothing", "revokes the session server-side, clears the cookie, audits, and drops the token with the last session"                                                                                                                                                                          |
| L14 | Secrets or personal data in logs                                                           | Only fixed outcomes, ids and counts; namespaced `signin` (not a redacted key); request logs carry the path only (P2-4)                                                                     | "logs (no codes, tokens, cookies, state values, emails or logins)"                                                                                                                                                                                                                                                         |
| L15 | A broken or hostile GitHub answer creates a session                                        | Every answer schema-checked, capped, no redirects, timeouts; any failure is a fixed error page and no session                                                                              | "GitHub refusing the code, cancelling, or failing: no session"; `oauth.test.ts` "fails closed on a non-JSON, oversized, mistyped or redirecting answer…", "401 is token_rejected…", "refuses an endless installation list"                                                                                                 |
| L16 | The cross-tenant lookup becomes a way to read other tenants                                | One function, ids only, six columns, a dedicated NOLOGIN owner; the isolation suite pins its owner, grants and the allow-list                                                              | `isolation.test.ts` (allow-lists, column grants, owner); `sessions.test.ts` "is the only cross-tenant read of orgs the app role has…"                                                                                                                                                                                      |
| L17 | Misconfiguration in production (http, no secret, no KEK)                                   | Boot refuses (ConfigError) without https, client credentials, session secret or KEK                                                                                                        | `config.test.ts`; `server.test.ts` "GitHub login at boot (P7-1, ADR 0020)"                                                                                                                                                                                                                                                 |

## Consequences

- Three acceptance suites (fixation, CSRF, open redirect) run against a real Postgres and the
  fake GitHub on every `pnpm verify`.
- The isolation suite allow-lists four more `app` tables and `auth.login_orgs`, and pins the
  column grants on `app.sessions`, `app.users` and `orgs` for `rocky_auth`.
- People sign in again after at most 8 hours (24 hours with non-expiring tokens).
- P7-2 builds on `sessionAuth.activeMember` and gets CSRF protection for free; P7-3 plugs rate
  limits into `AuthDeps.rateLimit`; P6 calls `apps/web/src/session.ts`.

## Residual risks

- **Not verified against a live GitHub App.** The fixtures are documentation-shaped. A human must
  sign in once on a real app (needs-human): the token answer with PKCE, `GET /user/installations`
  for a person whose access is through a team, and the callback URL in the app's settings.
- **Org membership is read at login only.** An installation removed from a person on GitHub stays
  in their session until it ends (at most 8 hours); repository data is still guarded by P3-6
  within 5 minutes. Removing the member in Rocky ends it at once. Follow-up for P7-2: re-read
  `/user/installations` periodically, or subscribe to `installation_repositories` / `member`
  webhooks (a manifest change, ADR 0008).
- **Several server instances share sessions** (database), but `onMemberTokenChanged` is local
  (ADR 0011's broadcast follow-up).
- **The session secret rotates by restart only.** Changing `ROCKY_SESSION_SECRET` invalidates all
  CSRF tokens and pending logins (sessions survive; the SPA re-reads its token). Key versioning
  is a follow-up if rotation without disruption is needed.
- **No GitHub-side revocation on logout.** The stored token is deleted, but the token stays valid
  at GitHub until it expires (≤ 8 h). Follow-up: `DELETE /applications/{client_id}/token`.
- **The token is a JavaScript string** and cannot be zeroed (as in ADR 0011).
- **Rate limits** on login, callback and session routes arrive with P7-3.
