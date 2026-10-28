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
  `[A-Za-z0-9._-]` only, at most 2000 files and 50 MB. Nothing can be traversed.
- **`index.html` is checked at boot**: an inline `<script>`, a `<style>` element, a `style=` or
  `on*=` attribute or a `javascript:` URL refuses to start (`findInlineContent`). The build test
  `apps/web/src/build.test.ts` runs `vite build` in `pnpm verify` and checks the same.
- **Caching:** `assets/*` (content-hashed) `public, max-age=31536000, immutable`; other files
  `no-cache`; `index.html` `no-store`.
- **SPA fallback:** a GET or HEAD for a path outside `/api`, `/auth`, `/webhooks`, `/setup`,
  `/assets`, `/healthz`, with no dot in its last segment and no `%` or `\`, gets `index.html`.
  Everything else unmatched gets the fixed `404 {"error":"not_found"}` (Fastify's default echoed
  the URL), with or without a web app.

### 3. Rate limits (`apps/server/src/security/rate-limit.ts`, `route-limits.ts`)

Fixed windows per scope and key, through one `RateLimits.consume(request, reply, scope, key)`:

| Scope                  | Key                      | Default     | Where                                                         |
| ---------------------- | ------------------------ | ----------- | ------------------------------------------------------------- |
| `auth.login`           | client address           | 30 / 10 min | `GET /auth/github/login`, before a `login_attempts` row       |
| `auth.callback`        | client address           | 30 / 10 min | `GET /auth/github/callback`, before the state is looked up    |
| `auth.logout`          | client address           | 30 / 10 min | `POST /auth/logout` (after the CSRF guard)                    |
| `auth.session`         | client address           | 300 / 1 min | the session API (`/api/session`, `/api/session/active-org`)   |
| `webhook.ip`           | client address           | 600 / 1 min | webhook `onRequest`, before the precheck and the body         |
| `webhook.installation` | `<forge>:<installation>` | 600 / 1 min | after the signature holds, before the inbox insert            |
| `ask`                  | member id                | 20 / 1 min  | P9: `app.rateLimits.consume(request, reply, "ask", memberId)` |

- Auth uses the P7-1 seam `AuthDeps.rateLimit(scope)` (`authRateLimit`, an `onRequest` hook on
  the auth scope, mapped by route path). Webhooks take `WebhookDeps.rateLimit` (`bySource`,
  `byInstallation`). Ask (P9) does not exist yet; `buildApp` decorates `app.rateLimits` and the
  scope and its default are defined, tested on a test-only route (`rate-limit.test.ts`).
- **Answer:** `429`, `Retry-After: <seconds>`, `Cache-Control: no-store`,
  `{"error":"rate_limited"}`. A store failure answers `503 {"error":"unavailable"}` (fail closed).
- **Overrides:** `ROCKY_RATE_LIMIT_<SCOPE>=<max>/<seconds>` (`ROCKY_RATE_LIMIT_AUTH_LOGIN=30/600`).
  Malformed values and unknown names refuse to boot; a limit cannot be turned off.
- **Keys never in clear:** the key is HMAC-SHA256'd under a per-process random secret before it
  reaches the store or a log line. The log line (`rate limited`, warn, once per key and window)
  carries `scope`, `keyHash` (16 characters), `count`, `limit`, `windowSeconds`.
- **Store:** in memory, per instance, at most 10 000 keys per process (expired windows swept,
  then the oldest dropped). With several instances each counts on its own: the effective limit
  is the configured one times the instance count (follow-up: a Postgres store; `RateLimitStore`
  is async for it).

### 4. Client address and trusted proxies (`apps/server/src/security/client-ip.ts`)

`ROCKY_TRUST_PROXY`:

- `none` (default outside production): the socket's peer; `X-Forwarded-For` and
  `Fly-Client-IP` are ignored entirely.
- `fly`: `Fly-Client-IP`, set by Fly.io's proxy. Refused at boot unless `FLY_APP_NAME` is set
  (elsewhere any client could send it).
- `xff:<1-5>`: the n-th `X-Forwarded-For` entry from the right (each trusted proxy appends what
  it saw; entries further left are client-controlled). Cloudflare in front of Fly: `xff:2`.

Production must set it explicitly: a wrong default either believes spoofable headers or limits
every user as the proxy's one address. A missing, repeated or malformed header falls back to the
socket's peer (one shared bucket, never an exemption). IPv6 is counted per /64; IPv4-mapped IPv6
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

| #   | What can go wrong                                                                          | Prevention                                                                                                                                                                    | Test                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | **Clickjacking:** a page frames Rocky and tricks a click (Finish review, logout)           | `frame-ancestors 'none'` on every response, `X-Frame-Options: DENY`, COOP                                                                                                     | `headers.test.ts` "documents get the app CSP…", "errors and 404s carry the headers too", "buildApp applies the headers everywhere"; ZAP 10020 PASS                               |
| H2  | **XSS via injection:** PR content or LLM labels become script or markup                    | Text-only rendering (ADR 0019 §4, P5-2) plus `script-src 'self'` without inline/eval, `object-src 'none'`, `base-uri 'none'`; no inline content in the build, refused at boot | `headers.test.ts` "the app CSP allows no inline script or style…"; `apps/web/src/build.test.ts`; `web-app.test.ts` "refuses at boot…", `findInlineContent` cases; ZAP 10038 PASS |
| H3  | **CSS injection / exfiltration**                                                           | `style-src 'self'` (no inline style elements or attributes from markup)                                                                                                       | same as H2                                                                                                                                                                       |
| H4  | **MIME sniffing:** a JSON or uploaded-looking answer is run as script or HTML              | `nosniff` everywhere; static types from an allow-list with charsets; non-documents get a CSP that allows nothing                                                              | `headers.test.ts`; `web-app.test.ts` "hashed assets are immutable…types come from an allow-list"; ZAP 10021 PASS                                                                 |
| H5  | **Referrer leaks:** the callback URL (code, state) or PR paths sent to another site        | `same-origin` by default; `no-referrer` on auth and setup pages (setup form: `strict-origin`, no secret in its URL)                                                           | `headers.test.ts` "keeps a route's stricter policy…"; `github-app-setup.test.ts` referrer assertions                                                                             |
| H6  | **Cached private answers** (shared proxy, back/forward cache, disk)                        | `no-store` on everything except content-hashed assets; `index.html` `no-store`                                                                                                | `headers.test.ts` "no-store unless the route chose…"; `web-app.test.ts`; ZAP 10049 (informational, intended)                                                                     |
| H7  | **SSL stripping** in production                                                            | HSTS (production), https-only public URL at boot (ADR 0020)                                                                                                                   | `headers.test.ts` "HSTS only when asked"; `server.security.test.ts` "production: … HSTS is on every response"                                                                    |
| H8  | Cross-origin leaks (Spectre, window references)                                            | COOP, CORP, COEP                                                                                                                                                              | `headers.test.ts` (baseline); ZAP 90004 PASS                                                                                                                                     |
| H9  | **Duplicate or conflicting headers** loosen a page's policy                                | One module; the hook only fills absent headers; pages build theirs with `pageCsp`                                                                                             | `headers.test.ts` "keeps a route's stricter policy and sends it once"; every header single-valued in each test                                                                   |
| H10 | **Path traversal** or serving files outside the build                                      | Route table built at boot from regular files; symlinks refused; dotfiles and unknown types skipped; no per-request filesystem access                                          | `web-app.test.ts` "only files enumerated at boot are served…", "refuses at boot…"                                                                                                |
| H11 | Fingerprinting (`X-Powered-By`, `Server`), URL reflected in the 404 body                   | Removed; fixed 404 body                                                                                                                                                       | `headers.test.ts` "removes X-Powered-By and Server…", "the 404 body is fixed"                                                                                                    |
| H12 | **Login brute force / state flooding:** unauthenticated starts grow `login_attempts`       | `auth.login` per address before the handler; existing pruning of 100 expired rows per start (ADR 0020 §10)                                                                    | `auth/rate-limit.test.ts` "login: after the limit, 429 and no login_attempts row"; `server.security.test.ts` "rate-limits login starts by default"                               |
| H13 | Callback or logout floods (state guessing is infeasible at 256 bits; database load is not) | `auth.callback`, `auth.logout`, `auth.session` per address                                                                                                                    | `auth/rate-limit.test.ts` "callback…", "logout and the session API…"                                                                                                             |
| H14 | **Webhook floods** before verification (HMAC over 25 MB, memory)                           | `webhook.ip` in `onRequest`, before the precheck and the body; ADR 0007's in-flight byte budget                                                                               | `webhooks.rate-limit.test.ts` "per source address before the body is read…", "the address limit also counts junk…"; `server.security.test.ts`                                    |
| H15 | Webhook floods after verification (runaway installation, leaked secret)                    | `webhook.installation` keyed by the authenticated installation id; forged deliveries never count                                                                              | `webhooks.rate-limit.test.ts` "per installation after verification…", "forged deliveries naming an installation do not spend its budget"                                         |
| H16 | **IP spoofing via forwarded headers** to get a fresh bucket per request                    | `ROCKY_TRUST_PROXY` (none ignores headers; fly only on Fly.io; xff counts from the right); production must choose; malformed → socket peer                                    | `client-ip.test.ts`; `auth/rate-limit.test.ts` "a spoofed X-Forwarded-For does not get a fresh bucket…"; `server.security.test.ts` "refuses … proxy setting"                     |
| H17 | Rotating IPv6 addresses within one allocation                                              | IPv6 keyed per /64; IPv4-mapped normalised                                                                                                                                    | `client-ip.test.ts` "IPv6 counts per /64…"                                                                                                                                       |
| H18 | Memory exhaustion through many distinct keys                                               | At most 10 000 keys per store; expired swept, then the oldest dropped                                                                                                         | `rate-limit.test.ts` "memory is bounded…"                                                                                                                                        |
| H19 | **Rate-limit bypass across instances**                                                     | Not prevented: per-instance counters (accepted for one Fly machine; follow-up Postgres store)                                                                                 | Residual risk R1                                                                                                                                                                 |
| H20 | Addresses, tokens or bodies in logs; a log flood from a request flood                      | HMAC'd key (`keyHash`), scope and counts only; once per key and window; the store sees only HMAC'd keys                                                                       | `rate-limit.test.ts` "logs scope, a hashed key and counts…", "the store never sees the raw key…"; `auth/rate-limit.test.ts`, `webhooks.rate-limit.test.ts`                       |
| H21 | A limit silently off (bad config, store failure)                                           | Malformed or unknown `ROCKY_RATE_LIMIT_*` refuses to boot; store failure answers 503                                                                                          | `rate-limit.test.ts` "refuses malformed values…", "fails closed…"; `server.security.test.ts` "refuses a malformed limit…"                                                        |
| H22 | A header regression ships unnoticed                                                        | ZAP baseline in CI fails on High/Medium; negative control: without the hook it reports Medium 10020 and 10038, Low 10021, 10063, 90004                                        | CI job `zap baseline`                                                                                                                                                            |

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
  composes the chain, must be checked on the first deploy (needs-human).
- **R5: the dev server.** Vite's dev server does not send these headers; only the built app is
  covered.
- **R6: the ZAP scan is passive and over http.** It does not attack inputs and cannot see HSTS
  or `Secure` cookies; the staging scan over https and the full security review are L-4.
