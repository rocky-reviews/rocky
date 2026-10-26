# ADR 0008 — GitHub App manifest: permissions, events and the self-host setup flow

- **Status:** Accepted
- **Date:** 2026-10-26
- **Task:** P3-1 (gate H3)
- **Relates to:** [ADR 0006](0006-envelope-encryption.md) (where secrets go later),
  [ADR 0007](0007-webhook-inbox.md) (the receiver these events reach)

## Context

Rocky acts on GitHub as a GitHub App. A self-hoster should be able to create their own app in
one click from their Rocky server, using GitHub's
[manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
Rocky renders a form that POSTs a JSON manifest to GitHub; the person reviews it and clicks
"Create GitHub App" (GitHub requires that human click: gate H3); GitHub redirects back with a
temporary `code` (valid one hour, usable once) and the `state` Rocky sent; Rocky exchanges the
code with `POST /app-manifests/{code}/conversions`, which returns the app id, slug, client id,
client secret, webhook secret and private key **once**.

Two things are at stake: what the app is allowed to do on every repository it is installed on
(permissions and events, fixed in the manifest), and the credentials the conversion returns,
which let anyone act as the app.

## Decision

### 1. Permissions: exactly four

| Permission      | Level | Why                                                                                                                                                                                                     |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contents`      | read  | Read the code: PR diffs and file contents at the head and base commits for analysis and the change map (P3-4, P4). Never write: Rocky does not push, commit or merge.                                   |
| `pull_requests` | write | Read PRs and their review comments (P3-4 mirror); **write** only to submit the review a person finished, as that person with their user token (P3-5). The app itself never posts (ADR 0004, P3-5 test). |
| `checks`        | read  | Show CI status in the briefing so the reviewer knows what already passed. Rocky does not create check runs.                                                                                             |
| `metadata`      | read  | Mandatory for every app; repository lookups, and the read-access check for users (P3-6).                                                                                                                |

Nothing else: no `issues`, `statuses`, `administration`, `members`, `actions`, `workflows`,
`secrets` or organization permissions. GitHub caps a user-to-server token at the intersection of
the app's and the user's permissions, so P3-5/P3-6 need nothing more here.
`GITHUB_APP_PERMISSIONS` in `packages/forge-github/src/app-manifest.ts` is frozen and pinned by
`app-manifest.test.ts`; widening it is a change to this ADR.

### 2. Webhook events: one subscription

| Event          | Subscribed | Why                                                                                                                                                                                                                                                                         |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request` | yes        | P3-2 decodes `opened`, `synchronize`, `closed`, `reopened`; P3-4 mirrors them. Other actions are answered 200 `ignored`.                                                                                                                                                    |
| `installation` | automatic  | GitHub delivers installation events to every app without a subscription (and they cannot be listed in `default_events`). P3-2 decodes `created`/`deleted`; P3-3 creates and schedules deletion of orgs.                                                                     |
| `ping`         | automatic  | Sent once when the hook is created; answered `pong`.                                                                                                                                                                                                                        |
| others         | no         | `installation_repositories`, `pull_request_review*`, `check_run`, `push` etc. are not decoded by P3-2; subscribing would only cost an HMAC per delivery. P3-3/P3-4 re-read state from GitHub (ADR 0007 §4) rather than relying on more events. Adding one is an ADR change. |

### 3. The rest of the manifest

Pinned exactly (`app-manifest.test.ts` "is pinned exactly…"):

- `public: false`. A self-hosted app is installable only on the account that owns it. So for
  an organization's repositories, create it **under that organization** (`?org=<login>`). Rocky
  Cloud's public app is configured in the private repository, not through this flow.
- `hook_attributes: { url, active: true }`. `url` is `GITHUB_APP_WEBHOOK_URL` or
  `<ROCKY_PUBLIC_URL>/webhooks/github`, and must be https: GitHub must reach it. Without one the
  page refuses to render (409) and says what to set. The manifest cannot carry a webhook secret;
  GitHub generates one (§5).
- `redirect_url: <ROCKY_PUBLIC_URL>/setup/github-app/callback`: the manifest-flow callback.
- `callback_urls: [<ROCKY_PUBLIC_URL>/auth/github/callback]`: **user login (P7-1)**. GitHub
  Apps issue user-to-server tokens through their own OAuth flow (with PKCE), and those tokens
  are what P3-5 posts reviews with and P3-6 checks repository access with, so the app is the
  OAuth client. No separate OAuth App. The path is reserved for P7-1; if P7-1 picks another
  path, it changes this constant, the pinned test, and existing apps' settings. GitHub's
  "expire user authorization tokens" setting is not a manifest field (new apps default to
  expiring tokens, which P7-1 must handle with refresh tokens).
- `request_oauth_on_install: false`. Login is its own flow (P7-1) with its own state, PKCE and
  session handling. Authorizing during install would send an unsolicited code to the callback
  and makes GitHub ignore `setup_url`.
- No `setup_url`, `setup_on_update: false`. Installations reach Rocky as signed webhooks
  (P3-3). A post-install redirect carries an unauthenticated `installation_id` query parameter
  that Rocky would have to treat as untrusted anyway. The onboarding UX can add it later.
- `name` defaults to "Rocky Reviews" (`GITHUB_APP_NAME`, 1–34 plain characters). App names are
  global on GitHub, so the person may need to edit it on GitHub's page; that is allowed.
- `url` (homepage) is `ROCKY_PUBLIC_URL`, or `GITHUB_APP_HOMEPAGE_URL` (https) when set. That
  override exists in case GitHub refuses a loopback homepage in development; the repository URL
  is a fine value. `description` is fixed text.

### 4. The setup routes (`apps/server/src/github-app-setup.ts`)

- **Off unless requested.** Routes are registered only when `GITHUB_APP_SETUP=true`, **not in
  production** (`NODE_ENV=production` or `FLY_APP_NAME` → ConfigError, the server does not boot),
  and no app is configured (`GITHUB_APP_ID` set, or anything exists at the credentials path).
  After a successful creation every setup route answers 404 until restart, and on restart the
  credentials file keeps setup off.
- **One-time boot token.** At boot the server generates 32 random bytes (base64url) and prints
  `…/setup/github-app?token=…` to **stderr, not the logger**: log pipelines ship and retain
  lines, and the token is a credential. Only its sha256 is kept; the comparison is
  constant-time over the hashes. First valid use burns it and starts a session: a random
  32-byte id in an `HttpOnly; SameSite=Lax; Path=/setup/github-app` cookie (`Secure` on https),
  stored hashed, one hour. The response is a 303 to the fixed path `/setup/github-app`, which
  drops the token from the address bar. A lost session means restarting the server.
- **State.** Each page render issues a fresh 32-byte `state`, stored hashed with the session and
  the target org, 30 minutes, at most 10 per session. On the callback it is removed at first
  presentation, whatever happens next (single use), and must belong to the presenting session
  and be unexpired. Otherwise 403 and no request to GitHub. `SameSite=Lax` lets the cookie ride
  the top-level GET redirect back from github.com. The same property lets another site navigate
  the operator's browser to the page, so a state is minted only when `Sec-Fetch-Site` is absent,
  `none` or `same-origin`. A `cross-site` or `same-site` navigation gets 403 and cannot evict the
  real state.
- **Code.** It must match `^[A-Za-z0-9_-]{1,128}$` (never a path or query), and its hash is
  remembered. A second presentation gets 409, and so does a second callback while an exchange
  is running (the claim happens before the first `await`).
- **Credentials target checked first.** The page (before the person goes to GitHub) and the
  callback (before the exchange) refuse when the credentials file exists or its directory is
  unsafe, because the secrets cannot be fetched twice.
- **Exchange.** One `POST` to `<api>/app-manifests/{code}/conversions`: `api.github.com`, or a
  GHES base from `GITHUB_URL`/`GITHUB_API_URL` that must be https, without credentials, query,
  fragment, or a path other than `/` or `/api/v3/`. It uses `redirect: "error"`, a 10 s timeout,
  a 256 KiB response cap, and requires status 201 and a JSON content type. The body is checked
  with a zod schema that bounds each kept field to a shape that cannot add lines or quotes to an
  env file. The PEM must parse with `node:crypto` as an RSA key of at least 2048 bits. Failures
  become `ManifestConversionError(reason, status?)`, so pages and logs see only a fixed reason
  and GitHub's HTTP status.
- **No widening.** The manifest page does not let the person change permissions or events, so
  this guards against GitHub changing its behaviour (or a response that does not match what was
  asked for). If GitHub reports permissions or events beyond the manifest, the credentials are
  not saved. The page links to the app's settings so the person can delete it.
- **A failed conversion leaves a live app.** GitHub sends the callback only after the app is
  created, so when the conversion fails (bad response, timeout, network, any HTTP error) the app
  most likely exists without saved credentials. The page says so. It links to
  `<GitHub>/settings/apps`, or `<GitHub>/organizations/<org>/settings/apps` (the org comes from
  the pending state). It offers two ways forward: delete the app and start again, or keep it and
  generate a client secret, private key and webhook secret by hand in its settings.
- **Slug.** GitHub's schema does not require `slug`, and slugs may contain `_`. A missing or
  invalid slug falls back to the last segment of `html_url` (`https://…/apps/<slug>`) when that
  is valid. Otherwise `GITHUB_APP_SLUG` and the install link are omitted and the page says where
  to find the app. A bad slug never stops the credentials from being saved.
- **Pages.** Server-rendered, no script, every dynamic value HTML-escaped. Headers:
  `Content-Security-Policy: default-src 'none'; style-src 'sha256-…'; form-action <GitHub
origin>; frame-ancestors 'none'; base-uri 'none'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` (except the form page, which sends `strict-origin`, so the
  cross-origin POST to GitHub carries a real `Origin` instead of `null`; that URL holds no secret
  after the 303), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Opener-Policy: same-origin`. Redirects go only to the fixed setup path plus a
  validated org login.
- **What a page may show.** The success page shows the credentials file's path, a link to install
  the app (`https://github.com/apps/<slug>/installations/new`, or the app list when there is no
  slug), and whether the webhook secret was generated. This is deliberate: the slug is public, it is the app's public URL, so the human can
  install it. The page never shows the id, client id, any secret, the key, the code or the state.
- **Logs.** `githubAppSetup.outcome` (fixed codes such as `bad_token`, `bad_state`,
  `code_reused`, `conversion_failed`, `grants_widened`, `created`), plus a reason, an HTTP status,
  widened grant names or `webhookSecretSource`. Fastify's request logging already drops query
  strings (`packages/log`).

### 5. How the self-hoster receives the credentials

**Written once to a file**, `GITHUB_APP_CREDENTIALS_FILE` (absolute; default
`~/.rocky/github-app.env`, outside the repository so it cannot be committed), in `.env` format:
`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY` (the PEM, multi-line). Every value is
**single-quoted** and limited to `[A-Za-z0-9._~+/=:@%-]` (`ENV_SAFE`; the PEM to base64 lines).
So the file reads back identically through Node's `--env-file`, `util.parseEnv`, and a POSIX
shell's `. file`, with nothing a shell would expand. Tests check all three.

The write is atomic and never overwrites: the directory is created `0700`, or refused when it
is group- or world-writable or not owned by the server's user. A temp file is opened with
`O_CREAT|O_EXCL` (no symlink following), mode `0600` re-applied with `fchmod` whatever the
umask, written and fsynced, then `link()`ed to the target. `link` fails if anything is there,
even a dangling symlink. The temp file is then removed. Each value is re-checked against
`ENV_SAFE` before writing.

**POSIX only.** The protection rests on file modes, which Windows does not apply (it uses ACLs).
`GITHUB_APP_SETUP=true` on Windows is a ConfigError, and the writer refuses as well. Use WSL,
macOS or Linux to create the app.

Why a file rather than printing to the terminal: the PEM is about 1.7 KB of multi-line text that
terminals, `tmux` scrollback and CI logs keep and mangle. A file has an owner and a mode, and
`fly secrets import < file` or a secret manager's CLI can take it as-is. The values are **not**
stored in the database. They are instance credentials, not tenant data. The webhook secret and
key must be available before any org exists, and storing them would need a non-tenant secret
table with its own encryption design. When P10-2 builds the setup wizard, it can revisit
storing them with ADR 0006 envelope encryption under a KEK.

**Webhook secret.** GitHub documents `webhook_secret` as generated and nullable, with no stated
format, and the manifest cannot supply one. Rocky keeps GitHub's secret only when it passes
`checkWebhookSecret` (at least 32 characters, no padding) and uses only `ENV_SAFE` characters
(`usableWebhookSecret`). Otherwise Rocky generates 32 random bytes as hex, writes them with
a comment, and the success page tells the person to paste the secret into the app's settings
before installing. The value appears only in the file.

### 6. Local development: the webhook URL

GitHub must reach the webhook URL over the internet; `127.0.0.1` is not reachable. Options
considered:

- **smee.io channel (default, chosen for H3).** `GITHUB_APP_WEBHOOK_URL=https://smee.io/<channel>`,
  with `npx smee-client` forwarding to `http://127.0.0.1:4310/webhooks/github`. It needs no
  account, the URL is stable across restarts, and **nothing on the workstation is exposed
  inbound**. GitHub's own webhook-testing docs use it. Caveats:
  - Anyone holding the channel URL can read the deliveries. The H3 repository
    (`rocky-reviews/rocky`) is public, so a channel exposes nothing that is not already public.
    Do not use smee with private repositories.
  - smee-client re-serialises the body (`JSON.stringify` of the parsed payload) instead of
    forwarding GitHub's bytes. Whenever that output differs from GitHub's serialisation (escaped
    characters such as `<`, `>`, `&` in an HTML comment, non-ASCII text, emoji, tabs, number
    formatting), the HMAC over the raw body fails and the receiver answers **401**. The failure
    is **deterministic** for that payload: redelivering sends the same bytes through the same
    re-serialisation and fails again. This is the receiver working as designed. **The HMAC check
    is not relaxed for development.**
- **cloudflared (raw bytes; the alternative when smee's 401s get in the way).** A named
  tunnel forwards GitHub's bytes unchanged, so every delivery verifies. It needs a Cloudflare
  account and a hostname. Limit the ingress to the webhook route so nothing else on the
  workstation (setup routes, `/healthz`) is reachable:

  ```yaml
  ingress:
    - hostname: rocky-dev.example.com
      path: ^/webhooks/github$
      service: http://127.0.0.1:4310
    - service: http_status:404
  ```

  Then set `GITHUB_APP_WEBHOOK_URL=https://rocky-dev.example.com/webhooks/github`. A quick
  tunnel (`cloudflared tunnel --url …`) exposes the whole server and changes URL on every run,
  so it is not recommended.

- Creating the app with webhooks inactive and setting the URL later: an extra manual step, and
  installation events would be lost until then.

In production `ROCKY_PUBLIC_URL` is https and the webhook URL is derived from it.

## Threat model

Assets: the app's credentials (private key, client secret, webhook secret), the integrity of the
app's grants on every installed repository, the setup capability on a running server, and log
hygiene.
Attackers: anyone who can reach the server; a website the operator visits (CSRF); a network
attacker or a compromised or impersonated GitHub endpoint returning crafted data; other local
users on the workstation; whoever reads logs. PR authors and other tenants have no input into
this flow (no PR content, no tenant data, no database). They matter only through the
permissions the app ends up with, which §1–2 minimise.

| #   | What can go wrong                                                                            | Prevention                                                                                                                                                                                                                         | Test                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Someone else uses the setup routes on a running instance to create/bind an app               | Opt-in flag; refused in production; off when configured; one-time 256-bit boot token on stderr only, stored hashed, constant-time compare, burned on use; redemption locks after 20 wrong tokens until restart; 404 after creation | `config.setup.test.ts` (off unless requested, production refused, off when configured); `github-app-setup.test.ts` "refuses the page without a token or session", "refuses a wrong, truncated, padded or repeated token", "exchanges the token once…", "disables every setup route…"; `server.test.ts` "registers no setup route…"; "locks token redemption after too many wrong tokens…" |
| S2  | CSRF / login CSRF: the operator's browser is made to complete a flow with an attacker's code | `state` 256-bit, single use, 30 min, bound to the hashed session; cookie `HttpOnly; SameSite=Lax`                                                                                                                                  | "refuses a forged state", "refuses a valid state presented without the session it was issued to…", "refuses an expired state", "refuses a callback without the session cookie"                                                                                                                                                                                                            |
| S3  | Replay of a state or a code; double exchange                                                 | State deleted at first presentation; code hashes remembered; one exchange at a time, claimed before any await                                                                                                                      | "refuses a replayed state…", "exchanges a code at most once…", "runs one exchange at a time…"                                                                                                                                                                                                                                                                                             |
| S4  | Open redirect, or injection into the GitHub URL or the API path                              | Fixed redirect path plus a validated org; org login, state and code regexes; `encodeURIComponent`; endpoints https-only, no credentials, query or fragment, fixed paths                                                            | "keeps only a validated organization in the redirect", "refuses missing, repeated or malformed parameters", `app-manifest.test.ts` "builds the form action…", "refuses non-https, credentials…", "refuses a malformed code before any request"                                                                                                                                            |
| S5  | XSS or clickjacking on the setup pages                                                       | No scripts; every dynamic value escaped; CSP `default-src 'none'`, hashed style, `form-action` = GitHub only, `frame-ancestors 'none'`; `X-Frame-Options: DENY`                                                                    | "posts the pinned manifest to GitHub with a fresh state, behind strict headers", "targets an organization… refuses a malformed one"                                                                                                                                                                                                                                                       |
| S6  | Secrets leak into logs, pages, errors or Referer                                             | Fixed log fields; query strings never logged; the page shows only the path and the public install link; errors carry reason + HTTP status; `Referrer-Policy: no-referrer`, `no-store`                                              | "creates the app: … nothing secret in the page or logs", "answers 502 with the GitHub status only…", `app-manifest.test.ts` "reduces HTTP errors to the status code only…", `server.test.ts` "prints the one-time setup URL to the terminal only…", `credentials-file.test.ts` "never puts the contents in an error"                                                                      |
| S7  | Secrets written world-readable, overwritten, or redirected through a symlink                 | `O_EXCL` temp file with `0600` plus `fchmod`, fsync, `link` (no clobber), directory `0700`, refused if group/world-writable or foreign-owned; default path outside the repo                                                        | `credentials-file.test.ts` "writes the file with mode 0600 in a 0700 directory", "refuses to overwrite…", "refuses a (dangling) symlink…", "lets exactly one of several concurrent writers win", "refuses a group- or world-writable directory"                                                                                                                                           |
| S8  | Secrets lost because the file cannot be written after GitHub returned them once              | Target checked when rendering the page and before the exchange                                                                                                                                                                     | "refuses to send the human to GitHub when the credentials file already exists", "does not exchange when the credentials file already exists"                                                                                                                                                                                                                                              |
| S9  | A crafted or malformed conversion response (env-file injection, huge body, bad key)          | https API base only, no redirects, 10 s timeout, 256 KiB cap, JSON content type, strict zod shapes, RSA ≥ 2048 parsed by `node:crypto`; values re-checked by the file writer                                                       | `app-manifest.test.ts` "refuses responses that are not JSON, too large, or fail the schema" (16 cases incl. `\nNODE_OPTIONS=` injection), "maps a timeout and network failures…"; `credentials-file.test.ts` "refuses values that could inject…"                                                                                                                                          |
| S10 | The app ends up with more access than Rocky needs                                            | Pinned manifest; refuse to save if GitHub reports widened grants                                                                                                                                                                   | `app-manifest.test.ts` "is pinned exactly…", "requests exactly the four permissions…", `widenedGrants` suite; "refuses to save an app created with more than was requested"                                                                                                                                                                                                               |
| S11 | Weak or missing webhook secret makes deliveries forgeable                                    | `usableWebhookSecret` (`checkWebhookSecret` plus a plain charset), else 32 random bytes generated and the human told to set it                                                                                                     | `usableWebhookSecret` suite; "generates a strong webhook secret when GitHub's is missing or weak…"                                                                                                                                                                                                                                                                                        |
| S12 | The token leaks via history, Referer or a shared screen                                      | Burned at first use; 303 to a token-free URL; `no-referrer`; restart issues a new one                                                                                                                                              | "exchanges the token once…", "generates a different token on every boot"                                                                                                                                                                                                                                                                                                                  |
| S14 | Another site navigates the operator's browser to the page repeatedly to evict the real state | States minted only for `Sec-Fetch-Site` absent, `none` or `same-origin`                                                                                                                                                            | "item 5: cross-site navigations cannot mint states or evict the real one"                                                                                                                                                                                                                                                                                                                 |
| S15 | Credentials file sourced by a shell runs code; file modes ignored on Windows                 | Single-quoted values from `ENV_SAFE` only; setup refused on Windows                                                                                                                                                                | `credentials-file.test.ts` "single-quotes every value", "reads back identically through node --env-file and a POSIX shell's source…", "refuses shell-active characters…", "refuses to write on Windows…"; `config.setup.test.ts` "refuses setup on Windows…"                                                                                                                              |
| S13 | Unbounded memory from setup state                                                            | Only a session (which needs the token) creates states, at most 10 per session; expired entries pruned                                                                                                                              | Code review (bounded by construction)                                                                                                                                                                                                                                                                                                                                                     |

## Consequences

- Creating an app needs one flag, a browser on the same host as the printed URL, and an https
  webhook URL. Then a click on GitHub (H3), and copying values into the secret manager.
- Changing a permission or an event means changing this ADR, the frozen constants and the pinned
  test. Existing installations must also accept the new permission on GitHub.
- The server does not read the credentials file. P3-3/P3-4 read `GITHUB_APP_ID` and
  `GITHUB_APP_PRIVATE_KEY` from the environment like `GITHUB_WEBHOOK_SECRET`.

## Residual risks

- **Token on stderr.** Whoever can read the server's terminal or its captured stderr can open
  setup until it is used. That is the operator by definition, and setup is off in production.
- **Same-host session.** The cookie is bound to the `ROCKY_PUBLIC_URL` host. Opening the printed
  URL under another hostname (`localhost` vs `127.0.0.1`) breaks the callback (403, fail closed).
- **Single-use is in-memory.** State, code and token records live in the process. A restart
  issues a new token and forgets used codes, but GitHub rejects a reused code itself (one use).
- **Crash between write and link** leaves a `0600` temp file with the secrets next to the target.
  It is only readable by the owner and named `.rocky-credentials-*.tmp`; the runbook says to
  check for it.
- **smee.io in development** exposes deliveries of the test repository to anyone with the
  channel URL (public repository only). Some deliveries reliably fail the signature check through
  smee (§6); use cloudflared when that matters.
- **`Sec-Fetch-Site` absent:** older browsers send no fetch metadata. There a cross-site page could
  still mint up to 10 states and evict the real one. That is denial of service only; the person
  reloads the setup page.
- **A failed conversion leaves an app on GitHub** without saved credentials; the page tells the
  person to delete it or finish its setup by hand.
- **Session binding is redundant by construction.** Only one session can exist per boot, so the
  state-to-session check cannot be exercised separately from "has the session". It stays as
  defence in depth if multiple sessions are ever allowed.
