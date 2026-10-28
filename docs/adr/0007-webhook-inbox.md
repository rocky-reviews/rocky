# ADR 0007 — Forge port and the webhook inbox

- **Status:** Accepted
- **Date:** 2026-10-26
- **Tasks:** P3-7, P3-2
- **Amends:** [ADR 0005](0005-migrations-and-roles.md) §1 (a third non-tenant table in `app`)
- **Amended by:** [ADR 0009](0009-installation-lifecycle.md) (P3-3: the inbox's processing state,
  the worker's claim path, the purge skips unprocessed rows; review round 1: claims per forge, one
  live lease per installation, transient vs. strike failures; review round 2: no superseding, a
  shape CHECK on installation rows; review round 3: a bounded claim, collapse on completion);
  [ADR 0010](0010-pull-request-mirror.md) (P3-4: the outbound `Forge` port's repository sessions,
  the pull request lane's consumer, claims cover whole lanes);
  [ADR 0025](0025-security-headers-and-rate-limits.md) (P7-3: rate limits per address and per
  installation)

## Context

GitHub tells Rocky about installations and pull requests through signed webhooks. The receiver
must authenticate each delivery, answer fast (GitHub times out after 10 s and does not retry on
its own), hand the work to the worker exactly once per delivery, and survive anything an
attacker can POST. Two constraints shape the hand-off:

- **Tenancy (ADR 0003).** Every table in `public` is a tenant table under RLS, and the existing
  `jobs` table needs an `org_id`. But `installation.created` arrives before the org it creates
  exists, so the receiver cannot write tenant-scoped rows, and it should not be able to read any.
- **Idempotency in the database.** The same delivery can arrive twice (GitHub redelivery, a
  retry racing the original, two server instances). An in-memory set is neither durable nor
  shared, so the database must decide.

The domain must also stay forge-neutral (GitLab and Gitea later, P3-7).

## Decision

### 1. Forge port in `packages/core`

`packages/core/src/forge.ts` defines, in forge-neutral terms:

- `ForgeEvent`: the six events the domain consumes (`installation.created|deleted`,
  `pull_request.opened|synchronize|closed|reopened`) carrying only ids, the PR number, the head
  sha, `merged`, and for installations the account id, login and kind plus the installer
  (`sender`: id and login, recorded because the forge cannot be asked for it later; P3-3 uses it
  for the first admin and the audit trail). The installer is **never fatal**: a sender that is
  missing or not a well-formed actor (a deleted "ghost" user, a staff or system action, an
  unexpected shape) decodes to `sender: null` and the delivery is still accepted, because losing
  an `installation.deleted` would lose the org-deletion obligation. Sender logins may carry a
  `[bot]` suffix (a GitHub App acting as itself, e.g. the app deleting its own installation);
  account logins may not;
- `WebhookIngress`: authenticate and decode one request (`receive(request) → WebhookReceipt`),
  pure, no I/O, never throws, authenticates the raw body before parsing it; plus
  `precheck(header)`, the header-shape rules alone (no secret), run before the body is read;
- `WebhookInbox`: `record(delivery) → "queued" | "duplicate"`;
- `Forge`: the read side used by P3-3/P3-4 (`getInstallation`, `verifyApp`; since P3-4
  `openRepository`, a session on one repository with a scoped token that reads pull requests,
  lists them and reads revision diffs, and `locateRepository`, ADR 0010); it grows with P3-5/P3-6.

GitHub specifics (header names, `X-Hub-Signature-256`, payload shapes, Octokit later) live in
`packages/forge-github`. Core imports nothing forge-specific: the ESLint allowlist (ADR 0002)
blocks it and two tests prove it (`scripts/lint-rules.test.ts` plants Octokit and adapter
imports; `packages/core/src/forge.test.ts` scans core's sources and manifest).

### 2. The receiver (`apps/server`, `POST /webhooks/github`)

The route runs in its own Fastify scope whose only content-type parser returns the raw bytes
(limit 25 MiB, GitHub's documented payload cap, so a genuine delivery such as a large
`installation.created` with thousands of repositories is never refused; larger → 413).

**Memory.** Before the body is read, an `onRequest` hook runs `precheck`: a missing or malformed
signature header → **401**, malformed delivery or event headers → **400**, another media type →
**415**, so an obviously bad request is never buffered. The rules are public, so a request with
a well-formed but forged signature and bad headers may get 400/415 here rather than the 401
`receive` would give; nothing leaks. Body bytes are then counted **as they are received**
(a `preParsing` hook) into a 64 MiB in-flight budget shared by all webhook requests; overflowing
it → **503** (`overloaded`). A declared `Content-Length` that cannot fit in what is left is
refused early, but nothing is reserved on the client's word: a client that announces 25 MiB and
trickles bytes holds only what it actually sent. A request's bytes are released once, when the
response is sent, the request is aborted or the connection closes (including after a 408).
`requestTimeout` is 30 s (also passed to `http.createServer` with `headersTimeout`, which Node
needs to enforce it, checked every second), so a slow upload cannot hold its bytes for long.
**Residual:** only a client that really sends data fast enough to fill 64 MiB within the request
timeout can exhaust the budget. Under such a high-bandwidth flood genuine deliveries can get 503
(GitHub does not retry them) in exchange for not running out of memory, until P7-3 adds rate
limiting. Then, for requests that get through, in this order:

1. **Authenticate** `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, raw body):
   `node:crypto` `createHmac` + `timingSafeEqual` over the two 32-byte digests. Missing, malformed
   or wrong → **401**, and nothing else about the request is examined. (The precheck above may
   already have answered 400/415 to a forged request whose headers are malformed: those rules are
   public, so this reveals nothing.)
2. Check `X-GitHub-Delivery` (a GUID, lower-cased) and `X-GitHub-Event` (`^[a-z_]{1,64}$`) → else
   **400**; `Content-Type: application/json` → else **415**.
3. Events other than `installation`, `pull_request` and `ping` → **200 ignored**, body not parsed.
4. `JSON.parse` (strict UTF-8) and decode with zod schemas that read only the needed fields. Unknown
   actions, and installations on an account type the domain does not model (an enterprise),
   → **200 ignored** (the latter with reason `unsupported_account_type`); a known action with the
   wrong shape → **400**.
5. `inbox.record(delivery)` → **202 queued** or **200 duplicate**; a database failure, or no
   answer within 6 s, → **503**. The server's single pool has `connectionTimeoutMillis` 2 s; the
   inbox insert alone runs in its own transaction with `SET LOCAL lock_timeout = 2s` and
   `SET LOCAL statement_timeout = 3s` (so Postgres itself gives up and frees the backend; a
   client-side timeout alone would leave one orphaned backend waiting on the lock per blocked
   webhook), plus a 3.5 s pg `query_timeout` as a backstop; any failure discards that connection
   (`release(err)`). Nothing is set pool-wide, so future `withOrg` routes inherit no hidden cap.
   Those fire first and are logged with their own SQLSTATE (e.g. `55P03`); the 6 s route guard is
   the backstop, inside GitHub's 10 s delivery timeout. An insert cut off by the client-side
   backstop may still commit; a redelivery then reads `duplicate`.
   The pool has an `error` listener (logs the code only), so an idle connection dropped by a
   Postgres restart does not crash the server.

No forge API call and no processing happens in the request path. Logs carry the forge, outcome,
fixed reason codes, delivery id, event name/type and body size; never headers, body, signature
or secret.

**Secret.** `GITHUB_WEBHOOK_SECRET`, at least 32 characters, no surrounding whitespace. In
production (`NODE_ENV=production`, or `FLY_APP_NAME` set by Fly.io) the server refuses to boot
without it; elsewhere an unset secret disables
the route (404) instead of verifying against an empty key. A set-but-weak secret is refused
everywhere. The boot log line `server listening` carries `webhooks: true|false`.

### 3. The inbox: `app.webhook_deliveries` (migration 0006)

A non-tenant table in the `app` schema, one row per accepted delivery. The row _is_ the queued
job: the worker consumes the inbox (P3-3 adds the claim path) and creates tenant-scoped work under
`withOrg` once it knows the org.

- **Keys.** Primary key `(forge, delivery_id)`; unique `(forge, payload_sha256)`. The headers
  are not signed, so a captured signed body replayed under a new delivery id is the same delivery.
  The insert is `ON CONFLICT DO NOTHING`; the row count tells `queued` from `duplicate`, and
  concurrent duplicates are serialised by the unique indexes.
- **Content.** `event_type`, `installation_id` and the minimal `ForgeEvent` as `jsonb` (≤ 1 KiB,
  CHECKs tie it to the columns), rebuilt from known fields by `packages/db` whatever the caller
  passes. No raw payload, titles, bodies, diffs, emails or URLs.
- **Privileges.** `rocky_app` holds `INSERT` only (no `SELECT`, `UPDATE`, `DELETE`): a
  compromised server can neither read other tenants' deliveries nor delete one to make a replay
  look new. RLS is enabled and forced with a single `FOR INSERT` policy for the app, so a stray
  future grant still matches no row. `received_at` is stamped by a trigger for every role.
- **Retention.** `retention.purge_webhook_deliveries(as_of)`, `SECURITY DEFINER`, owned by
  `rocky_retention`, period from `app.retention_settings` (`webhook_deliveries`, default 30 days,
  CHECK floor 7 days because GitHub redelivers for up to 3; `RETENTION_WEBHOOK_DELIVERIES_DAYS`).
  Same contract as the 0005 purges; not audited per org (a delivery has no org), `runRetention`
  reports the count. The retention period is also the dedup window. Since P3-3 it deletes
  **processed** rows only: pending, leased and parked rows stay however old (ADR 0009 §3).
- **Processing state (P3-3, ADR 0009 §3).** `attempts`, `strikes`, `available_at`,
  `lease_token`/`lease_until`, `processed_at` + `outcome`, `parked_at`, `last_error` (SQLSTATE or
  reason code). Reset by the stamp trigger on insert. The worker role claims rows of **its forge**
  with a lease through `worker.claim_webhook_deliveries`: at most one live lease per
  `(forge, installation_id)`, the oldest pending row first; no row is finished at claim or on
  failure; a lease holder's verified completion of an installation row marks earlier pending
  same-type rows of its installation `superseded` (ADR 0009 §3). A ready queue
  (`app.webhook_queue`) keeps the claim's cost independent of the backlog. Installation rows must have the shape
  `minimalEvent` produces (CHECK `webhook_deliveries_installation_shape`, for every role). It
  finishes them with `worker.complete_webhook_delivery`
  (inside the tenant transaction that applied the effect) or `worker.fail_webhook_delivery` with a
  kind: `transient` failures never park a row before it is 72 h old, `strike`s park it at five
  (a lost lease is a strike), `permanent` parks it now. The app role still holds `INSERT` only.
  The erasure of an org deletes or scrubs the rows of its installation and account (ADR 0009 §6).
- The isolation suite allow-lists the table explicitly, pins the app's privileges on it to
  `INSERT`, and the SECURITY DEFINER allow-list grows to five.

### 4. Rules for consumers (P3-3, P3-4)

A delivery is a hint, not a fact. Before acting, the worker re-reads state from the forge with
the installation token (GitHub is the source of truth): `installation.deleted` schedules deletion
only if `Forge.getInstallation` returns `null`; `installation.created` creates the org only if the
installation exists; PR events re-fetch the PR. This makes a replay outside the dedup window, or
a row planted by a compromised app credential, harmless. Processing is idempotent per delivery.

- **Re-validate on read.** A consumer decodes each inbox row again (`minimalEvent` in
  `packages/db`, or the same schema) and refuses a row that does not pass. It never trusts the
  stored shape: the app role can insert any row its CHECKs allow.
- **Reprocess from the inbox, not from GitHub.** "Redeliver" in GitHub's UI (or API) for a
  delivery already stored returns `duplicate` and stores nothing new, so retrying a failed
  processing step must re-run the inbox row, not ask GitHub to redeliver.
- **Never bind by login.** P3-3 must not attach an installation to an existing org by
  `account.login` (logins can be renamed and reused); bind by forge and installation id, and treat
  `account` and `sender` as display data until re-read from the forge.

### 5. Why not pg-boss now

`docs/architecture.md` names pg-boss for jobs. It is a consumer-side choice: its schema holds
cross-tenant rows that the app role must read and write, which needs its own isolation treatment.
The inbox is the durable, deduplicated boundary either way; whether the worker drains it directly
(`FOR UPDATE SKIP LOCKED` through a SECURITY DEFINER claim function) or feeds pg-boss is decided
with the first consumer (P3-3). **Decided in P3-3 (ADR 0009):** the worker drains the inbox
directly; no pg-boss schema with cross-tenant rows was needed.

## Threat model

Assets: the integrity of the job stream (it creates and deletes orgs and mirrors PRs), the webhook
secret, server availability, delivery metadata of all tenants, log hygiene.
Attackers: anyone on the internet; a network attacker holding captured signed deliveries; PR
authors (their content is inside genuine signed payloads); other tenants; whoever holds the
application's database credential.

| #   | Threat                                                                                                                 | Prevention                                                                                                                                                                                                                             | Test                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Forged delivery (no, wrong or malformed signature)                                                                     | HMAC-SHA256 over the raw body, constant-time compare, checked first → 401                                                                                                                                                              | `signature.test.ts` (GitHub's documented vector, malformed headers, other secret, flipped bit); `ingress.test.ts` "authentication comes first"; `webhooks.test.ts` "answers 401…", `webhooks.db.test.ts` "a forged delivery stores nothing"                                                                                                                                                                                                       |
| W2  | Parser differential: signature checked over a re-encoding, or body parsed before auth                                  | Raw-bytes content parser in an isolated scope; JSON parsed only after verification                                                                                                                                                     | `signature.test.ts` "verifies the raw bytes, not a re-encoding"; `webhooks.test.ts` "checks the signature before parsing…", "rejects a tampered body"                                                                                                                                                                                                                                                                                             |
| W3  | Empty or weak secret makes the HMAC forgeable                                                                          | `checkWebhookSecret` (≥ 32 chars, no padding) in the verifier and at boot; production refuses to boot without it; dev → no route                                                                                                       | `signature.test.ts` "refuses to be built with an empty, short…"; `config.test.ts` (unit + spawned boot in production); `webhooks.test.ts` "is not registered at all…"                                                                                                                                                                                                                                                                             |
| W4  | Same delivery twice (GitHub retry, redelivery, concurrent instances) → two jobs                                        | PK `(forge, delivery_id)` + `ON CONFLICT DO NOTHING`; the database decides                                                                                                                                                             | `webhooks.test.ts` (db) "stores a delivery once", "is race-safe: 25 concurrent duplicates…"; `webhooks.db.test.ts` "same delivery twice → one job", "concurrent duplicates… → exactly one job"                                                                                                                                                                                                                                                    |
| W5  | Captured signed body replayed under a new (unsigned) delivery id                                                       | Unique `(forge, payload_sha256)`                                                                                                                                                                                                       | db "treats the same signed body under a new delivery id as a replay", "is race-safe for concurrent replays…"; `webhooks.db.test.ts` "concurrent replays…"                                                                                                                                                                                                                                                                                         |
| W6  | Unsigned `X-GitHub-Event` swapped to reinterpret a signed body                                                         | Per-event strict schemas; disjoint action sets; body hash dedup                                                                                                                                                                        | `ingress.test.ts` "refuses a pull request body replayed under the installation event name"                                                                                                                                                                                                                                                                                                                                                        |
| W7  | Malformed, deep or huge payloads crash the server or cause 5xx                                                         | Body limit 25 MiB (GitHub's cap) → 413; ingress never throws (fatal UTF-8, try/catch, zod `safeParse`); 5xx only for the inbox (503)                                                                                                   | `property.test.ts` (4 seeded properties); `webhooks.test.ts` "under fuzzing (no 5xx)", "refuses bodies over the limit"; `ingress.test.ts` 200 000-deep nesting                                                                                                                                                                                                                                                                                    |
| W8  | Slow work or forge calls in the request path (timeouts, amplification)                                                 | Request path = HMAC + parse + one INSERT; the receiver has no forge client                                                                                                                                                             | `webhooks.test.ts` "does no forge I/O in the request path"                                                                                                                                                                                                                                                                                                                                                                                        |
| W9  | Untrusted PR content stored or logged (prompt injection later, PII)                                                    | Decoders keep ids, numbers, sha, login; `minimalEvent` rebuilds from known fields; logs carry ids and sizes only                                                                                                                       | `ingress.test.ts` "decodes … only" (planted title/body/email absent); db "stores only the minimal event", "has exactly the expected columns"; `webhooks.test.ts` "never logs the body, signature, secret…"                                                                                                                                                                                                                                        |
| W10 | Prototype pollution or type confusion from JSON                                                                        | `JSON.parse` (own `__proto__` keys), `Object.hasOwn` lookups, zod numeric bounds (safe positive ints)                                                                                                                                  | `ingress.test.ts` "does not let **proto** keys…", "refuses a known action with the wrong shape"; property invariants                                                                                                                                                                                                                                                                                                                              |
| W11 | Compromised app credential reads, deletes or backdates deliveries                                                      | `INSERT` only + INSERT-only RLS policy; stamp trigger; purge only via SECURITY DEFINER with owner-held period and 7-day floor                                                                                                          | db "can insert but not read, change, delete or truncate", "cannot choose received_at", "has a 7-day floor", "is reachable … only through the function"; `isolation.test.ts` privilege matrix                                                                                                                                                                                                                                                      |
| W12 | A non-tenant table weakens tenant isolation                                                                            | Explicit allow-list entry; no tenant data in the row beyond ids and the account login; app cannot read it                                                                                                                              | `isolation.test.ts` "every table in the database", "holds exactly the expected privileges…", SECURITY DEFINER allow-list                                                                                                                                                                                                                                                                                                                          |
| W13 | Database error text leaks row values into logs                                                                         | `WebhookInboxError` keeps only the SQLSTATE; the route logs `sqlstate`                                                                                                                                                                 | db "reduces a database failure to its SQLSTATE"; `webhooks.test.ts` "answers 503 … logging only the error code"                                                                                                                                                                                                                                                                                                                                   |
| W14 | A slow or hung database stalls the request path past GitHub's timeout, or a dropped idle connection crashes the server | Connect timeout 2 s on the pool; the insert in its own transaction with `SET LOCAL` lock 2 s / statement 3 s (no orphaned backend), 3.5 s client backstop, a 6 s route guard → 503, one pool with an `error` listener                  | `webhooks.test.ts` "item 2: answers 503 when the inbox never settles…", "the guard is per request…"; `server.test.ts` "bounds connect time only; no pool-wide statement cap", "survives an idle-client error…"; `server.db.test.ts` "survives its idle connections being terminated", "puts no hidden statement cap on the shared pool", "bounds the inbox insert itself…" (asserts no app backend left waiting on the lock); `main.test.ts`      |
| W15 | Production starts with webhooks silently off                                                                           | Secret required when `NODE_ENV=production` or `FLY_APP_NAME` is set; `webhooks` in the boot log                                                                                                                                        | `config.test.ts` "production detection", spawned boot on Fly.io; `server.test.ts` "startServer"                                                                                                                                                                                                                                                                                                                                                   |
| W16 | Unauthenticated clients make the server buffer large bodies (many at once, or slowly)                                  | `onRequest` precheck before the body is read; a 64 MiB budget of bytes actually received (not declared) → 503; 30 s request timeout enforced at the HTTP server. Residual: a high-bandwidth flood can still fill the budget until P7-3 | `webhooks.test.ts` "refuses a 25 MiB body with no or a malformed signature before reading it" (parser spy never runs), "answers 503 beyond the in-flight byte budget…", "cuts off a slow upload at the request timeout", "slow clients that announce big bodies but trickle do not crowd out a genuine delivery", "answers 503 when the bytes actually sent overflow the budget", "frees the budget after a 408…"; `ingress.test.ts` "precheck …" |
| W17 | An uninstall is lost because its actor is unusual (app bot, ghost user, staff action)                                  | Sender is optional: unusable → `null`, delivery accepted; `[bot]` suffix allowed for senders                                                                                                                                           | `ingress.test.ts` "accepts an installer that is a GitHub App…", "never loses an installation change over an unusable sender…"; db "stores a null installer and a GitHub App installer"; property invariant                                                                                                                                                                                                                                        |

## Consequences

- One INSERT per accepted delivery; unknown events cost an HMAC and nothing else.
- Adding an event type means a core type, an adapter decoder, and a migration extending the
  `event_type` CHECK.
- The worker logs in as its own role (`rocky_app` + `rocky_worker`, ADR 0009); its read path into
  the inbox is the SECURITY DEFINER functions in schema `worker`, not a table grant.

## Residual risks

- **Replay after the dedup window** (default 30 days): a captured signed body is accepted again.
  Mitigated by §4 (consumers re-verify with the forge); GitHub signs no timestamp to bound it.
- **Lost deliveries on infrastructure failure:** a 503 is not retried by GitHub automatically.
  Follow-up: a reconcile job that lists failed deliveries through the GitHub API and redelivers.
- **High-bandwidth flood:** a client that sends well-formed headers (no secret needed) and really
  uploads data fast can fill the 64 MiB budget of received bytes (for at most the 30 s request
  timeout per request) and make the server compute one HMAC per body. Slow or lying clients
  cannot: only bytes actually received count. During such a flood genuine deliveries get 503 and
  are lost unless redelivered (see the reconcile follow-up). Since P7-3 (ADR 0025 §3) one
  address can try at most `webhook.ip` times a minute (before the body is read) and one
  authenticated installation `webhook.installation` times; a distributed flood is for the edge
  (Cloudflare in front in Cloud).
- **Installer may be unknown:** `sender` is `null` when GitHub sends no usable actor. P3-3 handles
  it (ADR 0009 §2): the org gets no installer candidate, and P7-1 falls back to the first user who
  signs in and is verified as an admin.
- **Existence oracle:** a compromised app credential can learn whether a delivery id or body
  digest exists by attempting an insert. Delivery ids are not secret and digests need the body.
- `NODE_ENV=production` or `FLY_APP_NAME` makes the secret mandatory; a production deployment
  elsewhere that sets neither starts with the receiver disabled (404), which fails closed. The
  boot log says `webhooks: false`; deployment docs (Phase 10) must set `NODE_ENV`.
