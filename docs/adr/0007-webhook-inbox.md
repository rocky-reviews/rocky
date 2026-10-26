# ADR 0007 — Forge port and the webhook inbox

- **Status:** Accepted
- **Date:** 2026-10-26
- **Tasks:** P3-7, P3-2
- **Amends:** [ADR 0005](0005-migrations-and-roles.md) §1 (a third non-tenant table in `app`)

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
  sha, `merged`, and for installations the account id, login and kind;
- `WebhookIngress`: authenticate and decode one request (`receive(request) → WebhookReceipt`),
  pure, no I/O, never throws, authenticates the raw body before parsing it;
- `WebhookInbox`: `record(delivery) → "queued" | "duplicate"`;
- `Forge`: the read side used by P3-3/P3-4 (`getInstallation`, `getPullRequest`,
  `listOpenPullRequests`, `getPullRequestDiff`); it grows with P3-5/P3-6.

GitHub specifics (header names, `X-Hub-Signature-256`, payload shapes, Octokit later) live in
`packages/forge-github`. Core imports nothing forge-specific: the ESLint allowlist (ADR 0002)
blocks it and two tests prove it (`scripts/lint-rules.test.ts` plants Octokit and adapter
imports; `packages/core/src/forge.test.ts` scans core's sources and manifest).

### 2. The receiver (`apps/server`, `POST /webhooks/github`)

The route runs in its own Fastify scope whose only content-type parser returns the raw bytes
(limit 5 MiB, larger → 413). Then, in this order:

1. **Authenticate** `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, raw body):
   `node:crypto` `createHmac` + `timingSafeEqual` over the two 32-byte digests. Missing, malformed
   or wrong → **401**, and nothing else about the request is examined.
2. Check `X-GitHub-Delivery` (a GUID, lower-cased) and `X-GitHub-Event` (`^[a-z_]{1,64}$`) → else
   **400**; `Content-Type: application/json` → else **415**.
3. Events other than `installation`, `pull_request` and `ping` → **200 ignored**, body not parsed.
4. `JSON.parse` (strict UTF-8) and decode with zod schemas that read only the needed fields. Unknown
   actions → **200 ignored**; a known action with the wrong shape → **400**.
5. `inbox.record(delivery)` → **202 queued** or **200 duplicate**; a database failure → **503**.

No forge API call and no processing happens in the request path. Logs carry the forge, outcome,
fixed reason codes, delivery id, event name/type and body size; never headers, body, signature
or secret.

**Secret.** `GITHUB_WEBHOOK_SECRET`, at least 32 characters, no surrounding whitespace. With
`NODE_ENV=production` the server refuses to boot without it; elsewhere an unset secret disables
the route (404) instead of verifying against an empty key. A set-but-weak secret is refused
everywhere.

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
  reports the count. The retention period is also the dedup window.
- The isolation suite allow-lists the table explicitly, pins the app's privileges on it to
  `INSERT`, and the SECURITY DEFINER allow-list grows to five.

### 4. Rules for consumers (P3-3, P3-4)

A delivery is a hint, not a fact. Before acting, the worker re-reads state from the forge with
the installation token (GitHub is the source of truth): `installation.deleted` schedules deletion
only if `Forge.getInstallation` returns `null`; `installation.created` creates the org only if the
installation exists; PR events re-fetch the PR. This makes a replay outside the dedup window, or
a row planted by a compromised app credential, harmless. Processing is idempotent per delivery.

### 5. Why not pg-boss now

`docs/architecture.md` names pg-boss for jobs. It is a consumer-side choice: its schema holds
cross-tenant rows that the app role must read and write, which needs its own isolation treatment.
The inbox is the durable, deduplicated boundary either way; whether the worker drains it directly
(`FOR UPDATE SKIP LOCKED` through a SECURITY DEFINER claim function) or feeds pg-boss is decided
with the first consumer (P3-3).

## Threat model

Assets: the integrity of the job stream (it creates and deletes orgs and mirrors PRs), the webhook
secret, server availability, delivery metadata of all tenants, log hygiene.
Attackers: anyone on the internet; a network attacker holding captured signed deliveries; PR
authors (their content is inside genuine signed payloads); other tenants; whoever holds the
application's database credential.

| #   | Threat                                                                                | Prevention                                                                                                                       | Test                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Forged delivery (no, wrong or malformed signature)                                    | HMAC-SHA256 over the raw body, constant-time compare, checked first → 401                                                        | `signature.test.ts` (GitHub's documented vector, malformed headers, other secret, flipped bit); `ingress.test.ts` "authentication comes first"; `webhooks.test.ts` "answers 401…", `webhooks.db.test.ts` "a forged delivery stores nothing" |
| W2  | Parser differential: signature checked over a re-encoding, or body parsed before auth | Raw-bytes content parser in an isolated scope; JSON parsed only after verification                                               | `signature.test.ts` "verifies the raw bytes, not a re-encoding"; `webhooks.test.ts` "checks the signature before parsing…", "rejects a tampered body"                                                                                       |
| W3  | Empty or weak secret makes the HMAC forgeable                                         | `checkWebhookSecret` (≥ 32 chars, no padding) in the verifier and at boot; production refuses to boot without it; dev → no route | `signature.test.ts` "refuses to be built with an empty, short…"; `config.test.ts` (unit + spawned boot in production); `webhooks.test.ts` "is not registered at all…"                                                                       |
| W4  | Same delivery twice (GitHub retry, redelivery, concurrent instances) → two jobs       | PK `(forge, delivery_id)` + `ON CONFLICT DO NOTHING`; the database decides                                                       | `webhooks.test.ts` (db) "stores a delivery once", "is race-safe: 25 concurrent duplicates…"; `webhooks.db.test.ts` "same delivery twice → one job", "concurrent duplicates… → exactly one job"                                              |
| W5  | Captured signed body replayed under a new (unsigned) delivery id                      | Unique `(forge, payload_sha256)`                                                                                                 | db "treats the same signed body under a new delivery id as a replay", "is race-safe for concurrent replays…"; `webhooks.db.test.ts` "concurrent replays…"                                                                                   |
| W6  | Unsigned `X-GitHub-Event` swapped to reinterpret a signed body                        | Per-event strict schemas; disjoint action sets; body hash dedup                                                                  | `ingress.test.ts` "refuses a pull request body replayed under the installation event name"                                                                                                                                                  |
| W7  | Malformed, deep or huge payloads crash the server or cause 5xx                        | Body limit 5 MiB → 413; ingress never throws (fatal UTF-8, try/catch, zod `safeParse`); 5xx only for the inbox (503)             | `property.test.ts` (4 seeded properties); `webhooks.test.ts` "under fuzzing (no 5xx)", "refuses bodies over the limit"; `ingress.test.ts` 200 000-deep nesting                                                                              |
| W8  | Slow work or forge calls in the request path (timeouts, amplification)                | Request path = HMAC + parse + one INSERT; the receiver has no forge client                                                       | `webhooks.test.ts` "does no forge I/O in the request path"                                                                                                                                                                                  |
| W9  | Untrusted PR content stored or logged (prompt injection later, PII)                   | Decoders keep ids, numbers, sha, login; `minimalEvent` rebuilds from known fields; logs carry ids and sizes only                 | `ingress.test.ts` "decodes … only" (planted title/body/email absent); db "stores only the minimal event", "has exactly the expected columns"; `webhooks.test.ts` "never logs the body, signature, secret…"                                  |
| W10 | Prototype pollution or type confusion from JSON                                       | `JSON.parse` (own `__proto__` keys), `Object.hasOwn` lookups, zod numeric bounds (safe positive ints)                            | `ingress.test.ts` "does not let **proto** keys…", "refuses a known action with the wrong shape"; property invariants                                                                                                                        |
| W11 | Compromised app credential reads, deletes or backdates deliveries                     | `INSERT` only + INSERT-only RLS policy; stamp trigger; purge only via SECURITY DEFINER with owner-held period and 7-day floor    | db "can insert but not read, change, delete or truncate", "cannot choose received_at", "has a 7-day floor", "is reachable … only through the function"; `isolation.test.ts` privilege matrix                                                |
| W12 | A non-tenant table weakens tenant isolation                                           | Explicit allow-list entry; no tenant data in the row beyond ids and the account login; app cannot read it                        | `isolation.test.ts` "every table in the database", "holds exactly the expected privileges…", SECURITY DEFINER allow-list                                                                                                                    |
| W13 | Database error text leaks row values into logs                                        | `WebhookInboxError` keeps only the SQLSTATE; the route logs `sqlstate`                                                           | db "reduces a database failure to its SQLSTATE"; `webhooks.test.ts` "answers 503 … logging only the error code"                                                                                                                             |

## Consequences

- One INSERT per accepted delivery; unknown events cost an HMAC and nothing else.
- Adding an event type means a core type, an adapter decoder, and a migration extending the
  `event_type` CHECK.
- The receiver and the worker share one database role; the worker's read path into the inbox is a
  SECURITY DEFINER function added with it (P3-3), not a table grant.

## Residual risks

- **Replay after the dedup window** (default 30 days): a captured signed body is accepted again.
  Mitigated by §4 (consumers re-verify with the forge); GitHub signs no timestamp to bound it.
- **Lost deliveries on infrastructure failure:** a 503 is not retried by GitHub automatically.
  Follow-up: a reconcile job that lists failed deliveries through the GitHub API and redelivers.
- **Unauthenticated load:** anyone can make the server read up to 5 MiB and compute one HMAC per
  request. Rate limits on the webhook endpoint come with P7-3; Cloudflare sits in front in Cloud.
- **Existence oracle:** a compromised app credential can learn whether a delivery id or body
  digest exists by attempting an insert. Delivery ids are not secret and digests need the body.
- `NODE_ENV=production` is what makes the secret mandatory; a production deployment that does not
  set it starts with the receiver disabled (404), which fails closed but silently. Deployment
  docs (Phase 10) must set it; the boot log says `webhooks: false`.
