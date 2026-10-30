# ADR 0025: Security headers, CSP and rate limits

- **Status:** Accepted
- **Date:** 2026-10-28
- **Task:** P7-3
- **Amends:** [ADR 0020](0020-github-login-and-sessions.md) §10 (rate limits and headers, done
  here), [ADR 0007](0007-webhook-inbox.md) (the receiver's flood residual risk),
  [ADR 0019](0019-web-app-shell.md) (how the SPA is served in production)

## Context

Rocky's server answers four kinds of clients: browsers running the web app (ADR 0019), browsers
on the fixed auth and setup pages (ADR 0020, ADR 0008), the web app's JSON API, and GitHub's
webhook deliveries (ADR 0007). Each page and route set some headers of its own; nothing covered
JSON answers, 404s or errors, and the built SPA had no host at all. Login starts are
unauthenticated and write a `login_attempts` row each; the webhook receiver verifies an HMAC over
up to 25 MB before it knows who is sending. Neither had a rate limit. The acceptance criterion is
an OWASP ZAP baseline scan with no High or Medium alert.

## Decision

### 1. One header module (`apps/server/src/security/headers.ts`)

A root `onSend` hook adds every header the route did not set itself, on every answer (routes,
the 404 handler, error handlers, 429s):

| Header                                    | Value                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Content-Security-Policy` (HTML)          | `APP_CSP`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` |
| `Content-Security-Policy` (anything else) | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`                                                                                                                                              |
| `X-Content-Type-Options`                  | `nosniff`                                                                                                                                                                                                                      |
| `X-Frame-Options`                         | `DENY` (legacy browsers; `frame-ancestors` is the control)                                                                                                                                                                     |
| `Referrer-Policy`                         | `same-origin`                                                                                                                                                                                                                  |
| `Permissions-Policy`                      | camera, microphone, geolocation, payment, USB, serial, sensors, … all `()`                                                                                                                                                     |
| `Cross-Origin-Opener-Policy`              | `same-origin`                                                                                                                                                                                                                  |
| `Cross-Origin-Resource-Policy`            | `same-origin`                                                                                                                                                                                                                  |
| `Cross-Origin-Embedder-Policy`            | `require-corp`                                                                                                                                                                                                                 |
| `Cache-Control`                           | `no-store` unless the route chose (only static files do)                                                                                                                                                                       |
| `Strict-Transport-Security`               | `max-age=31536000`, production only                                                                                                                                                                                            |

`X-Powered-By` and `Server` are removed if anything set them (Fastify and Node send neither).

The loop is `applySecurityHeaders(reply, options)`; the hook calls it, and so does the
`frameworkErrors` handler (`security/errors.ts`, review round 1): Fastify refuses a malformed URL
(`GET /%`, `GET /api/%zz`) before routing and runs no hook for it, so its default answer went out
without any of these headers and echoed the path. That answer is now `400 {"error":"bad_request"}`
with every header. A root `setErrorHandler` answers anything a route or hook throws with a fixed
body per status (`bad_request`, `not_found`, `payload_too_large`, …, `internal` for 5xx) and logs
the status and at most Fastify's own error code, never `error.message`; scopes with their own
handler (the auth routes) keep theirs.

- **One source of truth, no duplicates.** The fixed HTML pages (auth, setup) build their
  stricter CSP with `pageCsp({ style, formAction })` from the same module (`default-src 'none'`,
  their one `<style>` by hash, `form-action 'none'`, or GitHub for the setup form) and set
  `Referrer-Policy: no-referrer`; the hook keeps a header a route set and never appends a second
  value. They no longer set `X-Frame-Options`, `nosniff` or COOP themselves.
- **Referrer-Policy `same-origin`**, not `no-referrer`, by default: with `no-referrer` browsers
  send `Origin: null` on same-origin POSTs, which the CSRF guard (ADR 0020 §5) refuses. Nothing
  leaves the origin, which is stricter than `strict-origin-when-cross-origin`. The auth pages
  keep `no-referrer` (the callback URL carries the code and state).
- **No inline script or style, no hashes or nonces.** `public/theme-init.js` is external
  (ADR 0019 §5); the change-map renderer emits no inline style (P5-2). React's `style={…}` is
  applied through the CSSOM, which CSP does not block. Sign-in is a link, so `form-action 'self'`
  does not block the redirect to GitHub (a form that posts to GitHub must use `pageCsp`).
- **HSTS** has no `includeSubDomains` or `preload`: a self-hosted Rocky on a company domain
  must not force HTTPS onto that company's other hosts. Fly.io terminates TLS; the header still
  reaches the browser.
- A helper over a dependency (`@fastify/helmet`): ten fixed headers do not need one, and the
  module is the reviewable list.

### 2. The SPA in production (`apps/server/src/web-app.ts`)

The server serves the Vite build when `ROCKY_WEB_DIR` (absolute path) is set; in development
Vite serves it (its dev server injects scripts, so its headers are not these; development only).
The P10-1 image will copy `apps/web/dist` and set the variable.

- **No filesystem access per request.** At boot every file is read into a fixed route table:
  regular files only, symlinks refused, dotfiles skipped, extensions from an allow-list (html,
  js, css, svg, png, ico, woff2, webmanifest) with explicit types, URL paths
  `[A-Za-z0-9._-]` only, at most 2000 files and 50 MB. Nothing can be traversed. Each file is
  opened once with `O_NOFOLLOW | O_NONBLOCK`, checked with `fstat` on that handle and read from
  it (exactly the checked size): there is no path between the check and the read for a symlink
  or a FIFO to slip into, and a symlink at the last step is `ELOOP`, refused.
- **`index.html` is checked at boot**: an inline `<script>`, a `<style>` element, a `style=` or
  `on*=` attribute or a `javascript:` URL refuses to start (`findInlineContent`). The document
  is parsed as a browser parses it (parse5, pinned) and every element is visited in every
  namespace, inside `<template>` and `<noscript>`; a tag regexp cannot know where `</script\t\n
bar>` ends or what the parser makes of entities or odd markup. The build test
  `apps/web/src/build.test.ts` runs `vite build` in `pnpm verify` and checks the same way.
- **Policy (ADR 0024):** the file routes and `/` declare `publicRoute`: the shell holds no
  tenant data and the sign-in page is in it. The route-permission matrix lists them.
- **Caching:** `assets/*` (content-hashed) `public, max-age=31536000, immutable`; other files
  `no-cache`; `index.html` `no-store`.
- **SPA fallback:** a GET or HEAD for a path outside `/api`, `/auth`, `/webhooks`, `/setup`,
  `/assets`, `/healthz`, made of non-empty segments of `[A-Za-z0-9._~@+-]` (none only dots; so no
  `//`, `;`, `%` or `\`) with no dot in its last segment, gets `index.html`. `//api/session` and
  `/api;x` therefore get the fixed 404, not the shell (review round 1).
  Everything else unmatched gets the fixed `404 {"error":"not_found"}` (Fastify's default echoed
  the URL), with or without a web app.

### 3. Rate limits (`apps/server/src/security/rate-limit.ts`, `route-limits.ts`)

Fixed windows per scope and key. `RateLimits.consume(request, reply, scope, key)` checks and
counts in one step; budgets that only some outcomes use up are checked with `allows` (no count)
and spent with `spend` after the outcome is known (concurrent requests can overshoot by the
number in flight):

| Scope                  | Key                                                  | Default     | Where                                                                             |
| ---------------------- | ---------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `auth.login`           | client address                                       | 30 / 10 min | `GET /auth/github/login`, before a `login_attempts` row                           |
| `auth.callback`        | client address                                       | 30 / 10 min | `GET /auth/github/callback`, before the state is looked up                        |
| `auth.logout`          | session (CSRF-proven), else client address           | 30 / 10 min | `POST /auth/logout` (after the CSRF guard)                                        |
| `auth.session`         | session for POSTs (CSRF-proven), else client address | 300 / 1 min | the session API (`/api/session`, `/api/session/active-org`)                       |
| `webhook.ip`           | client address + own/other app claim                 | 600 / 1 min | checked in `onRequest` before the precheck and the body; spent only by rejections |
| `webhook.installation` | `<forge>:<installation>`                             | 600 / 1 min | checked after the signature holds; spent only when the inbox queued the delivery  |
| `ask`                  | member id                                            | 20 / 1 min  | P9: `app.rateLimits.consume(request, reply, "ask", memberId)`                     |

- Auth uses the P7-1 seam `AuthDeps.rateLimit(scope)` (`authRateLimit`, an `onRequest` hook on
  the auth scope, mapped by route path). Webhooks take `WebhookDeps.rateLimit` (`sourceAllowed`,
  `sourceRejected`, `installationAllowed`, `installationQueued`).
- **Logout and org switching per session** (review round 1): a state-changing auth request whose
  session cookie comes with its matching CSRF token (an HMAC under the server secret, so a client
  cannot mint fresh pairs) counts against that session, so one client behind a shared NAT cannot
  stop others there from signing out. GETs and anything without such a pair count per address.
- **Webhook per-source budget counts rejections only** (review round 1): failed precheck, bad
  signature, oversized body (413). Genuine deliveries never spend it, and neither do authenticated
  deliveries with a bad payload. It is keyed by address and by whether the unauthenticated
  `X-GitHub-Hook-Installation-Target-Type/-ID` headers name this deployment's App
  (`GITHUB_APP_ID`; `WebhookIngress.claimsOwnSender`). GitHub sends every app's deliveries from
  one shared pool of addresses and sets those headers from the hook's owner, so another App
  pointed at Rocky with a wrong secret fills only the "other" bucket of a GitHub address while
  Rocky's own deliveries keep flowing. A direct client can claim our App id, but only from its own
  address, and gets at most two buckets per address. Without `GITHUB_APP_ID` (development) every
  delivery is "other".
- **Installation budget counts queued deliveries only** (review round 1): GitHub signatures have
  no timestamp, so a captured delivery can be replayed; the inbox dedups it and a duplicate does
  not spend the installation's budget. Ask (P9) does not exist yet; `buildApp` decorates `app.rateLimits` and the
  scope and its default are defined, tested on a test-only route (`rate-limit.test.ts`).
- **Answer:** `429`, `Retry-After: <seconds>`, `Cache-Control: no-store`,
  `{"error":"rate_limited"}`. A store failure answers `503 {"error":"unavailable"}` (fail closed).
- **Overrides:** `ROCKY_RATE_LIMIT_<SCOPE>=<max>/<seconds>` (`ROCKY_RATE_LIMIT_AUTH_LOGIN=30/600`).
  Malformed values and unknown names refuse to boot; a limit cannot be turned off.
- **Keys never in clear:** the key is HMAC-SHA256'd under a per-process random secret before it
  reaches the store or a log line. The log line (`rate limited`, warn, once per key and window)
  carries `scope`, `keyHash` (16 characters), `count`, `limit`, `windowSeconds`.
- **Store:** in memory, per instance, at most 10 000 keys **per scope** (review round 1: one
  shared map let a flood of login keys from many IPv6 /64s evict `ask` and
  `webhook.installation` counters, resetting a member's Ask cost cap). Every key of a scope has
  the same window length, so a scope's map is ordered by window end; making room drops expired
  windows from the front, then the oldest, in O(1) amortised per new key. With several instances each counts on its own: the effective limit
  is the configured one times the instance count (follow-up: a Postgres store; `RateLimitStore`
  is async for it).

### 4. Client address and trusted proxies (`apps/server/src/security/client-ip.ts`)

`ROCKY_TRUST_PROXY`:

- `none` (default outside production): the socket's peer; `X-Forwarded-For` and
  `Fly-Client-IP` are ignored entirely. Refused on Fly.io (`FLY_APP_NAME` set): every request
  arrives through Fly's proxy, so all users would share the proxy's one bucket.
- `fly`: `Fly-Client-IP`, set by Fly.io's proxy. Refused at boot unless `FLY_APP_NAME` is set
  (elsewhere any client could send it).
- `xff:<1-5>`: the n-th `X-Forwarded-For` entry from the right (each trusted proxy appends what
  it saw; entries further left are client-controlled). Cloudflare in front of Fly: `xff:2`.
  **Only sound when the origin accepts traffic from the proxy alone**: a client that reaches the
  origin directly writes the whole header and picks its own bucket. If the origin is reachable
  directly, prefer `fly` (Fly's proxy overwrites `Fly-Client-IP`).

The chosen mode is logged at boot (`trustProxy`, never an address).

Production must set it explicitly: a wrong default either believes spoofable headers or limits
every user as the proxy's one address. A missing, repeated or malformed header falls back to the
socket's peer (one shared bucket, never an exemption); in `fly` and `xff` modes that fallback logs
a warning at most once a minute per process (mode, `missing` or `malformed`, and how many
fallbacks since the last warning; no address), so a proxy that stops setting the header is
noticed instead of silently merging every client. IPv6 is counted per /64; IPv4-mapped IPv6
is IPv4. Fastify's `trustProxy` is not used: it would also change `request.protocol` and
`hostname` app-wide, and it has no Fly mode.

### 5. ZAP baseline (`pnpm security:zap`, CI job `zap baseline`)

`scripts/security/zap-baseline.sh` builds the web app, starts a throwaway Postgres (the dev image
by digest, random local port), migrates, starts the real server (webhooks, login with a dummy
client that is never contacted, the built SPA) and runs `zap-baseline.py` from the ZAP image
pinned by digest (`ZAP_IMAGE` in `scripts/security/images.sh`). A hook visits every route family
(the SPA renders its links with JavaScript). The run fails on any alert not accepted in
`scripts/security/zap/rules.tsv` and, whatever that file says, on any High or Medium alert
(`check-report.mjs` reads the JSON report). Reports: `artifacts/zap/` (gitignored). It runs in
CI on every push and pull request.

The scan runs over http on loopback (development mode), so HSTS and `Secure` cookies are not in
its view; they are covered by `server.security.test.ts` and ADR 0020's tests, and the
pre-launch scan of staging over https is L-4.

## Threat model

**Assets:** sessions and the login flow, users' trust in what the page shows (no script but
Rocky's), the webhook inbox and the database behind it, availability of sign-in, log hygiene.

**Attackers:** a malicious site the user visits (framing, embedding); malicious PR content that
reaches the page (titles, paths, labels from the LLM); a network attacker (downgrade); an
anonymous client flooding login, callback or webhooks, possibly spoofing forwarded headers or
rotating IPv6 addresses; a holder of a leaked webhook secret; someone reading logs or a shared
cache.

| #   | What can go wrong                                                                                                                                                                                                                   | Prevention                                                                                                                                                                    | Test                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | **Clickjacking:** a page frames Rocky and tricks a click (Finish review, logout)                                                                                                                                                    | `frame-ancestors 'none'` on every response, `X-Frame-Options: DENY`, COOP                                                                                                     | `headers.test.ts` "documents get the app CSP…", "errors and 404s carry the headers too", "buildApp applies the headers everywhere"; ZAP 10020 PASS                                                                  |
| H2  | **XSS via injection:** PR content or LLM labels become script or markup                                                                                                                                                             | Text-only rendering (ADR 0019 §4, P5-2) plus `script-src 'self'` without inline/eval, `object-src 'none'`, `base-uri 'none'`; no inline content in the build, refused at boot | `headers.test.ts` "the app CSP allows no inline script or style…"; `apps/web/src/build.test.ts`; `web-app.test.ts` "refuses at boot…", `findInlineContent` cases; ZAP 10038 PASS                                    |
| H3  | **CSS injection / exfiltration**                                                                                                                                                                                                    | `style-src 'self'` (no inline style elements or attributes from markup)                                                                                                       | same as H2                                                                                                                                                                                                          |
| H4  | **MIME sniffing:** a JSON or uploaded-looking answer is run as script or HTML                                                                                                                                                       | `nosniff` everywhere; static types from an allow-list with charsets; non-documents get a CSP that allows nothing                                                              | `headers.test.ts`; `web-app.test.ts` "hashed assets are immutable…types come from an allow-list"; ZAP 10021 PASS                                                                                                    |
| H5  | **Referrer leaks:** the callback URL (code, state) or PR paths sent to another site                                                                                                                                                 | `same-origin` by default; `no-referrer` on auth and setup pages (setup form: `strict-origin`, no secret in its URL)                                                           | `headers.test.ts` "keeps a route's stricter policy…"; `github-app-setup.test.ts` referrer assertions                                                                                                                |
| H6  | **Cached private answers** (shared proxy, back/forward cache, disk)                                                                                                                                                                 | `no-store` on everything except content-hashed assets; `index.html` `no-store`                                                                                                | `headers.test.ts` "no-store unless the route chose…"; `web-app.test.ts`; ZAP 10049 (informational, intended)                                                                                                        |
| H7  | **SSL stripping** in production                                                                                                                                                                                                     | HSTS (production), https-only public URL at boot (ADR 0020)                                                                                                                   | `headers.test.ts` "HSTS only when asked"; `server.security.test.ts` "production: … HSTS is on every response"                                                                                                       |
| H8  | Cross-origin leaks (Spectre, window references)                                                                                                                                                                                     | COOP, CORP, COEP                                                                                                                                                              | `headers.test.ts` (baseline); ZAP 90004 PASS                                                                                                                                                                        |
| H9  | **Duplicate or conflicting headers** loosen a page's policy                                                                                                                                                                         | One module; the hook only fills absent headers; pages build theirs with `pageCsp`                                                                                             | `headers.test.ts` "keeps a route's stricter policy and sends it once"; every header single-valued in each test                                                                                                      |
| H10 | **Path traversal** or serving files outside the build                                                                                                                                                                               | Route table built at boot from regular files; symlinks refused; dotfiles and unknown types skipped; no per-request filesystem access                                          | `web-app.test.ts` "only files enumerated at boot are served…", "refuses at boot…"                                                                                                                                   |
| H11 | Fingerprinting (`X-Powered-By`, `Server`), URL or error text reflected in a body                                                                                                                                                    | Removed; fixed 404 body; fixed error bodies from the root error handler and `frameworkErrors`                                                                                 | `headers.test.ts` "removes X-Powered-By and Server…", "the 404 body is fixed"; `errors.test.ts` "a thrown error never returns or logs its message"                                                                  |
| H12 | **Login brute force / state flooding:** unauthenticated starts grow `login_attempts`                                                                                                                                                | `auth.login` per address before the handler; existing pruning of 100 expired rows per start (ADR 0020 §10)                                                                    | `auth/rate-limit.test.ts` "login: after the limit, 429 and no login_attempts row"; `server.security.test.ts` "rate-limits login starts by default"                                                                  |
| H13 | Callback or logout floods (state guessing is infeasible at 256 bits; database load is not)                                                                                                                                          | `auth.callback` per address; `auth.logout`, `auth.session` POSTs per CSRF-proven session, else per address                                                                    | `auth/rate-limit.test.ts` "callback…", "logout and the session API…", "logout counts per session…", "a cookie without its CSRF token gets no bucket…"                                                               |
| H14 | **Webhook floods** before verification (HMAC over 25 MB, memory)                                                                                                                                                                    | `webhook.ip` checked in `onRequest`, before the precheck and the body, spent by rejections; ADR 0007's in-flight byte budget                                                  | `webhooks.rate-limit.test.ts` "bad signatures spend it…", "junk that fails the precheck…", "an oversized body spends the budget"; `server.security.test.ts`                                                         |
| H15 | Webhook floods after verification (runaway installation, leaked secret, replays)                                                                                                                                                    | `webhook.installation` keyed by the authenticated installation id; spent only by queued deliveries, so forged and replayed ones never count                                   | `webhooks.rate-limit.test.ts` "per installation after verification…", "forged deliveries naming an installation…", "replayed signed deliveries…"                                                                    |
| H16 | **IP spoofing via forwarded headers** to get a fresh bucket per request                                                                                                                                                             | `ROCKY_TRUST_PROXY` (none ignores headers; fly only on Fly.io; xff counts from the right); production must choose; malformed → socket peer                                    | `client-ip.test.ts`; `auth/rate-limit.test.ts` "a spoofed X-Forwarded-For does not get a fresh bucket…"; `server.security.test.ts` "refuses … proxy setting"                                                        |
| H17 | Rotating IPv6 addresses within one allocation                                                                                                                                                                                       | IPv6 keyed per /64; IPv4-mapped normalised                                                                                                                                    | `client-ip.test.ts` "IPv6 counts per /64…"                                                                                                                                                                          |
| H18 | Memory exhaustion through many distinct keys; one scope's flood resetting another's counters                                                                                                                                        | At most 10 000 keys per scope; expired dropped, then the oldest, O(1) amortised                                                                                               | `rate-limit.test.ts` "memory is bounded per scope…", "a flood of keys in one scope never evicts another scope's counters…", "making room while full does not sweep…"                                                |
| H19 | **Rate-limit bypass across instances**                                                                                                                                                                                              | Not prevented: per-instance counters (accepted for one Fly machine; follow-up Postgres store)                                                                                 | Residual risk R1                                                                                                                                                                                                    |
| H20 | Addresses, tokens or bodies in logs; a log flood from a request flood                                                                                                                                                               | HMAC'd key (`keyHash`), scope and counts only; once per key and window; the store sees only HMAC'd keys                                                                       | `rate-limit.test.ts` "logs scope, a hashed key and counts…", "the store never sees the raw key…"; `auth/rate-limit.test.ts`, `webhooks.rate-limit.test.ts`                                                          |
| H21 | A limit silently off (bad config, store failure)                                                                                                                                                                                    | Malformed or unknown `ROCKY_RATE_LIMIT_*` refuses to boot; store failure answers 503                                                                                          | `rate-limit.test.ts` "refuses malformed values…", "fails closed…"; `server.security.test.ts` "refuses a malformed limit…"                                                                                           |
| H23 | **Webhook budget poisoning:** genuine deliveries (or another App's forged ones from GitHub's shared addresses) spend the per-address budget and Rocky's deliveries get 429 (not retried)                                            | Spent by rejections only; keyed by address + own/other App claim                                                                                                              | `webhooks.rate-limit.test.ts` "genuine deliveries never spend…", "another app's forged deliveries from GitHub's shared address do not block ours"; `server.security.test.ts` "GITHUB_APP_ID keeps…"                 |
| H24 | **Bare framework errors:** a malformed URL answered without security headers, echoing the path                                                                                                                                      | `frameworkErrors` handler applies the headers and a fixed body                                                                                                                | `errors.test.ts` "malformed URLs"                                                                                                                                                                                   |
| H25 | SPA shell served for odd spellings of API paths (`//api/session`, `/api;x`)                                                                                                                                                         | Allow-list of SPA path shapes before the prefix check                                                                                                                         | `web-app.test.ts` "client-side routes get index.html; API…"                                                                                                                                                         |
| H26 | Trusted proxy misconfigured on Fly (`none`), or a proxy silently stops sending its header                                                                                                                                           | `none` refused on Fly; fallback warning at most once a minute; mode logged at boot                                                                                            | `client-ip.test.ts` "none is refused on Fly.io…", "says when a trusted mode fell back…"; `rate-limit.test.ts` "trusted proxy fallback warning"; `server.security.test.ts`                                           |
| H27 | A Medium ZAP alert waved through by an IGNORE rule                                                                                                                                                                                  | `check-report.mjs` fails on any High/Medium regardless of `rules.tsv`                                                                                                         | `scripts/security/zap/check-report.test.ts`                                                                                                                                                                         |
| H22 | A header regression ships unnoticed                                                                                                                                                                                                 | ZAP baseline in CI fails on High/Medium; negative control: without the hook it reports Medium 10020 and 10038, Low 10021, 10063, 90004                                        | CI job `zap baseline`                                                                                                                                                                                               |
| H28 | **Check-then-read race in `ROCKY_WEB_DIR`:** a path swapped for a symlink (`/etc/passwd`) or a FIFO between `stat` and `read` is served, or blocks boot                                                                             | One handle per file: `open(O_NOFOLLOW \| O_NONBLOCK)`, `fstat` on it, read from it exactly the checked size; the listing never decides                                        | `web-app.test.ts`: symlinked file and directory refused (`ELOOP`), a FIFO is skipped and boot does not hang (CodeQL js/file-system-race clean)                                                                      |
| H29 | **Parser differential in the inline-content check:** `</script\t\n bar>`, uppercase attributes, `<svg><script>`, `<template>`, `<noscript>`, entity-encoded `javascript:` get past a regexp and run under a weaker CSP than assumed | `findInlineContent` walks the parse5 tree (scripting disabled, so `<noscript>` content is visited too); every attribute value is normalised like the URL parser does          | `web-app.test.ts` corpus of those shapes; `build.test.ts` on the real build (CodeQL js/bad-tag-filter clean)                                                                                                        |
| H30 | **A P7-3 route without an access policy, or a policy denial answered without the security headers** (the policy replies from a hook, before any handler)                                                                            | Every route this task adds declares `publicRoute`; P7-2's `onRoute` hook refuses any other; the header `onSend` hook runs for hook replies too                                | `policy.db.test.ts` matrix rows for `/`, `/index.html` and the assets, with header assertions on every cell; `headers.test.ts` 401 from a session and a permission route; `errors.test.ts` with the policy in place |

## Consequences

- Every answer has the same headers from one place; new routes (P7-2, P9) get them without
  opting in, and a route that needs a stricter page policy uses `pageCsp`.
- The server can host the SPA; one origin keeps cookies, the CSRF Origin check and the CSP simple.
- `pnpm verify` builds the web app once (about a second). CI gains a ZAP job (a few minutes,
  parallel to `verify`).
- Production needs `ROCKY_TRUST_PROXY`.

## Residual risks

- **R1: per-instance counters.** With n instances the effective limits are n times the
  configured ones, and a restart resets them. Follow-up: a Postgres-backed `RateLimitStore`
  (keys stay HMAC'd; the HMAC secret must then be shared, e.g. derived from the session secret).
- **R2: many addresses.** Per-address limits do not stop a distributed flood; that belongs at
  the edge (Cloudflare, Fly's proxy). The webhook `ip` limit stops one noisy source only.
- **R3: a lost delivery.** A webhook refused with 429 (or 503) is not retried by GitHub. GitHub
  is the source of truth and redeliveries are possible; the reconcile follow-up of ADR 0007
  covers it.
- **R4: forwarded-header formats on the real hosting are unverified.** That Fly appends to
  `X-Forwarded-For` and sets `Fly-Client-IP` from the connecting client, and how Cloudflare
  composes the chain, must be checked on the first deploy (needs-human). `xff:<n>` is bypassable
  if the origin also accepts traffic that does not come through the proxy: the operator must make
  the proxy the only way in (or use `fly`).
- **R5: the dev server.** Vite's dev server does not send these headers; only the built app is
  covered.
- **R6: the ZAP scan is passive and over http.** It does not attack inputs and cannot see HSTS
  or `Secure` cookies; the staging scan over https and the full security review are L-4.
- **R7: Node's HTTP parser answers some requests itself.** A malformed request line or headers
  (400), a request that misses the request/headers timeout (408) and oversized headers (431) are
  answered by Node before Fastify sees them: no security headers, no body from Rocky. Those
  answers carry no content to protect (no HTML, nothing from the request), so this is accepted.
- **R8: shared-office NAT on login and callback.** `auth.login` and `auth.callback` count per
  address (there is no session yet), so a large office behind one address shares 30 starts per
  10 minutes. Raise `ROCKY_RATE_LIMIT_AUTH_LOGIN` / `ROCKY_RATE_LIMIT_AUTH_CALLBACK` for such a
  deployment; a better key is a follow-up (docs/progress.md).
- **R9: own-App claim relies on GitHub's headers.** If GitHub ever stopped sending the hook
  target headers, every delivery would be "other" and the per-address budget would again be
  shared with other Apps' rejected deliveries (it is still spent only by rejections).
