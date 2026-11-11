# ADR 0044: The setup wizard

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-10
- **Task:** P10-2
- **Builds on:** [ADR 0008](0008-github-app-manifest.md) (the manifest flow, its one-time token
  and credentials file), [ADR 0012](0012-llm-roles-and-provider-port.md) (roles, adapters, the
  test call its Consequences ask for), [ADR 0020](0020-github-login-and-sessions.md) §3 and §5
  (cookies, CSRF), [ADR 0043](0043-container-images-and-self-host-compose.md) (the images and the
  compose file)

## Context

A self-hoster starts from an empty VM. Before Rocky can analyse a pull request, four things must
be right: the database (reachable as the application login, extensions, migrations), a GitHub
App (created, its credentials in Rocky's configuration, installed on a repository), an LLM
provider (a key that works for the configured models), and the event path from GitHub to the
worker. The acceptance criterion is a fresh VM to the first analysed pull request in under 15
minutes, following the docs.

Three things stood in the way:

1. The manifest flow (P3-1) was refused in production, and a production server refused to boot
   without the webhook secret, the app's key, login and a session secret: the very values the
   manifest flow produces.
2. Nothing checked the LLM configuration against the provider before the first analysis (ADR 0012
   says validation reads the catalogue, not the provider).
3. Nothing told the operator whether the installation reached Rocky or whether an analysis had
   run, short of reading logs.

## Decision

### 1. `ROCKY_SETUP=true` opens a wizard; in production before an app exists the server runs it alone

- `ROCKY_SETUP=true` opens the wizard. It is allowed in production, where `ROCKY_PUBLIC_URL` must
  be set and https (the browser and GitHub need it). Its older name `GITHUB_APP_SETUP=true` does
  the same outside production only: P3-1 refused it in production, and a leftover value must not
  open the wizard on a server after an upgrade (fix round), so production still refuses to start
  with it.
- Left on, every restart opens the wizard again with a new link; the server warns at boot.
- **Setup mode:** production, wizard requested, `GITHUB_APP_ID` unset. The server validates only
  what it then uses (the database login check, `ROCKY_PUBLIC_URL`, `ROCKY_TRUST_PROXY`, rate
  limits, the web build) and registers only `/healthz`, the wizard, the manifest flow and the web
  app's files. The webhook receiver, login and every tenant route are not registered, so there is
  nothing to misconfigure and nothing tenant-shaped to reach. The worker is unchanged: with no
  app id it refuses to start and compose restarts it until the app is configured.
- Once `GITHUB_APP_ID` is set, the server boots in full (every production requirement applies
  again) and the wizard stays beside it while `ROCKY_SETUP=true`, for the LLM test and the first
  repository. Without `ROCKY_SETUP`, production is exactly as before.

### 2. One setup session for the manifest flow and the wizard

`apps/server/src/setup/session.ts` holds what P3-1 kept inside the manifest routes, unchanged in
substance: a 256-bit one-time boot token printed to **stderr** (not the logger), compared as
sha256 in constant time, burnt on first use; a random session id in an `HttpOnly; SameSite=Lax`
cookie, stored hashed in memory, one hour. Lax, not Strict: GitHub's redirect back to the
manifest callback is a cross-site top-level navigation, which a Strict cookie would not ride; the
POSTs have their own CSRF check (§4). Changes:

- **Lockout per client address** (fix round): after 20 wrong tokens from one address, that
  address is locked out until a restart. A request without a token of the right shape counts for
  nothing (crawlers find a new public host through certificate transparency logs within minutes),
  and one address's failures never lock out another; at most 1000 addresses are remembered, the
  oldest forgotten first. P3-1's single global counter let anyone lock the operator out.
- **Client address from `ROCKY_TRUST_PROXY`** (fix round): the setup routes' rate limit (100 a
  minute) and the lockout key on `RateLimits.clientKey` (ADR 0025), not the socket's peer, which
  behind Caddy or a tunnel is the proxy for every visitor.

- The cookie is `Path=/` and, on https, `__Host-rocky_setup` with `Secure` (ADR 0020 §3: no
  sibling subdomain can plant it). One cookie now covers `/setup/*` and `/api/setup/*`.
- The token is redeemed at `GET /setup/start?token=…`, which redirects to `/setup`. The old
  `GET /setup/github-app?token=…` still works.

After the app is created the manifest routes close (404) as before, but the session lives on:
the wizard's next step is the restart, and the operator needs the page to tell them so.

### 3. The wizard's API and page

- `GET /api/setup/status`: every step's state as fixed codes, counts and names, validated
  against `SetupStatusResponse` (`packages/core/src/setup.ts`) before it is sent, plus the
  session's synchronizer token. No key, token, connection string or driver message.
  - **Database:** the application pool's login check (`checkServerLogin`, refusals by code), the
    `vector` extension, and every table and column of this release's schema (the Drizzle mirror,
    kept equal to the migrations by `schema-drift.test.ts`) read from `pg_catalog`, which every
    role may read. No new grant, no migration ledger access.
  - **GitHub App:** `not_created` (with the manifest flow's link, or `webhook_url_missing`),
    `created` (the credentials file exists, checked on every status request since the manifest flow writes it while the server runs; restart with its values), `configured` (`GET /app`
    with the app's JWT proves the key, and its `slug` gives the install link), `check_failed`.
  - **LLM:** the targets the test call would reach (`probeTargets`), or the configuration's
    `LlmConfigError` text (variable paths and rules, never key values).
  - **First repository:** `GET /app/installations` (one page of 20) as the app; the live orgs for
    those installations through the existing `auth.login_orgs` function (ids only); per org,
    inside `withOrg`, counts of repositories, pull requests and analyses by status, and the most
    recent finished analysis's `owner/name#number`.
- `POST /api/setup/llm-test`: `probeLlmConfig` (`packages/llm/src/probe.ts`): one call per
  distinct provider and model of the completion roles, through `createLlmRoles` and the real
  adapters, with fixed Rocky instructions (`rockyInstructions`), no untrusted content, 512 output
  tokens and a 60 s timeout; plus one embedding of one word when an embed role is configured. Any
  answer counts as working (`ok`, or `answered` when cut short or off-schema); a thrown
  `LlmCallError` is reported by kind. One at a time, at most one per 10 s. The results (provider,
  model, outcome, duration) are kept in memory for the status. The call is not metered: there is
  no org yet to bill or count it against.
- `POST /api/setup/finish`: closes every setup route (404) and ends every session until the
  server restarts.
- `GET /setup`: the web app's shell (production build) at that one path while setup is open; the
  page is `apps/web/src/setup/`, in the inbox's frame with the POC's cards, pills and buttons.

### 4. CSRF for a session that is not a login session

The global CSRF guard (ADR 0020 §5) refuses every state-changing request without a login
session. The wizard's two POSTs declare `csrfExempt: "setup_session"` and run the same three
checks against the setup session in their handler: `Sec-Fetch-Site` same-origin when present,
`Origin` (or `Referer`) equal to `ROCKY_PUBLIC_URL`'s origin, and `x-rocky-csrf` equal to an
HMAC of the setup cookie under a per-process key. An `onRoute` hook refuses to register the
exemption on any route outside `/api/setup/`, so it cannot be borrowed.

### 5. Credentials stay in a file; Docker Compose gets an overlay

The credentials are still written once to a 0600 file (ADR 0008 §5); the operator appends them
to `deploy/rocky.env` and deletes the file. Storing them encrypted in the database (ADR 0008's
open question) is not done: the server must read them before it can open anything, and a
non-tenant secret table with its own key handling is a larger design than this task. For
Compose, `deploy/docker-compose.setup.yml` adds `ROCKY_SETUP=true`, the credentials path and one
bind-mounted directory (`deploy/setup`, created `0700` and owned by uid 65532), to the server
only. Starting without the overlay recreates the server without the wizard and without a
writable mount: that is how setup is closed for good.

### 6. Not in scope

- **Per-org LLM overlays and BYOK** (ADR 0012 §7, the C-5 / P10-2 note): a self-hosted instance
  has one LLM configuration, from the environment. Per-org keys are C-5 (Rocky Cloud).
- Persisting "setup finished" across restarts: the switch is the environment (`ROCKY_SETUP`, or
  the overlay), which the operator controls.
- Creating the org without the installation event: the operator installs after the restart, when
  the webhook receiver exists (the pages say so). An installation made earlier can be redelivered
  from the app's settings on GitHub.

## Threat model

| #   | What can go wrong                                                                                              | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                | Test                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1  | **Someone on the network finds a fresh instance in setup mode** and creates their own app, or reads the status | Every setup route but the static page needs the session from the 256-bit one-time token, printed to stderr only; 20 wrong tokens lock out that client address (missing or malformed ones are not counted, so crawlers cannot lock the operator out); 100 requests a minute per client address, which `ROCKY_TRUST_PROXY` resolves behind the proxy; the server is published on loopback behind the operator's TLS proxy by default        | `setup/session.test.ts` (once, per-client lockout, crawlers, expiry), `setup/routes.test.ts` ("needs the session", "client addresses behind a proxy"), `server.test.ts` ("counts the setup routes' limits per client address") |
| W2  | **The token leaks through logs** (docker logs are shipped and kept)                                            | The token goes to stderr, never the logger; it works once and only within the process; the URL page sends `Referrer-Policy: no-referrer`. Residual: docker's json-file log keeps stderr; the token is useless once redeemed or after a restart                                                                                                                                                                                            | `server.test.ts` ("prints the one-time setup URL to the terminal only"), `routes.test.ts` (no token in logs)                                                                                                                   |
| W3  | **CSRF**: another site makes the operator's browser run the test call (spend) or finish setup                  | The setup-session CSRF check (same origin, synchronizer token bound to the cookie); `SameSite=Lax`; the exemption is limited to `/api/setup/*` at registration                                                                                                                                                                                                                                                                            | `session.test.ts` ("refuses cross-site…"), `routes.test.ts` ("is refused … from another origin", "only /api/setup/* may use…")                                                                                                 |
| W4  | **Secrets in pages or logs**: an LLM key, the app's private key, a connection string, a provider's error text  | Status and test answers are built from fixed codes and validated against strict schemas (unknown fields refused); probe failures are reduced to `LlmCallError` kinds or `failed`; a key pasted into a `ROCKY_LLM_*_MODEL` variable is refused by the config check ("looks like a credential") and the config error is scrubbed again before the page; database errors to state codes; logs carry outcome codes, provider, model, duration | `checks.test.ts` (no connection string, no key value, no key pasted as a model), `routes.test.ts` ("never sends or logs a key"), `probe.test.ts`, `setup.test.ts` (core)                                                       |
| W5  | **Prompt or output side effects** from the test call                                                           | Fixed Rocky-authored instructions, no untrusted content, output validated by a one-field schema and then discarded; nothing acts on it                                                                                                                                                                                                                                                                                                    | `probe.test.ts` ("makes one minimal call … with no PR content")                                                                                                                                                                |
| W6  | **Cost abuse** through repeated test calls                                                                     | Session + CSRF; one call at a time; at most one per 10 s; 512 output tokens per call, at most five calls                                                                                                                                                                                                                                                                                                                                  | `routes.test.ts` ("runs one at a time, and at most once per interval")                                                                                                                                                         |
| W7  | **Setup mode weakens production**: login, webhooks or tenant routes reachable without their secrets            | In setup mode none of them is registered; without `ROCKY_SETUP` the production checks are unchanged; once an app id is set every production requirement applies again                                                                                                                                                                                                                                                                     | `server.test.ts` ("boots in setup mode … the wizard only", and the same environment without `ROCKY_SETUP` is refused)                                                                                                          |
| W8  | **Cross-tenant read** in the first-repository step                                                             | Installation → org through the existing `auth.login_orgs` (ids only); counts inside `withOrg` under RLS; only the app's own installations from GitHub are asked about                                                                                                                                                                                                                                                                     | `setup.db.test.ts` (as the application login, one org's counts), `checks.test.ts`                                                                                                                                              |
| W9  | **Credentials written somewhere others can read**, or into the image                                           | ADR 0008's writer (0600, `O_EXCL`, directory 0700 owned by the server's uid, refused otherwise); the overlay mounts one directory to the server only; `deploy/setup` is git- and docker-ignored                                                                                                                                                                                                                                           | `credentials-file.test.ts`, `deploy.test.ts` (the overlay's shape and ignores)                                                                                                                                                 |
| W10 | **Setup left open**                                                                                            | "Finish setup" closes every route until restart; the server logs a warning at boot while `ROCKY_SETUP` is on; the docs end with starting without the overlay                                                                                                                                                                                                                                                                              | `routes.test.ts` ("closes every setup route, the manifest flow's too")                                                                                                                                                         |
| W11 | **Untrusted names** (GitHub logins, repository names, model names) rendered as markup                          | Rendered as React text; the PR link is built from validated `owner/name` segments; the install link must be https (schema)                                                                                                                                                                                                                                                                                                                | `setup.test.tsx` (web: config error shown as text, `pullPath`), core schema tests                                                                                                                                              |

## Consequences

- A fresh VM goes from `docker compose up` with the overlay to a created app, a tested provider,
  an installed repository and an analysed pull request without reading logs beyond the one link
  (`docs/self-host/setup.md`).
- The one-time link now starts at `/setup/start`; `/setup/github-app?token=` still works.
- A new table or column in a migration is picked up by the database check through the Drizzle
  schema, which `schema-drift.test.ts` already keeps in step.
- The test call spends about a cent or two per click with the default models and is not
  recorded in `llm_usage`.

## Residual risks

- The token reaches docker's log files through stderr (W2). Mitigated by single use; an operator
  who ships container stderr to a shared system should restart the server after setup.
- Between creating the app and the restart, an installation's event is refused (no receiver);
  the pages tell the operator to install after the restart.
