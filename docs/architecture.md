# Architecture

Decisions behind this page:
[ADR 0002 modular monolith](adr/0002-architecture.md), [ADR 0003 tenancy](adr/0003-tenancy.md),
[ADR 0004 schema-first LLM](adr/0004-schema-first-llm.md),
[ADR 0005 migrations and roles](adr/0005-migrations-and-roles.md),
[ADR 0006 envelope encryption](adr/0006-envelope-encryption.md),
[ADR 0007 forge port and webhook inbox](adr/0007-webhook-inbox.md),
[ADR 0008 GitHub App manifest](adr/0008-github-app-manifest.md).

## Runtime

```
             GitHub ──webhooks──►┌──────────────┐        ┌──────────────┐
                                 │ apps/server  │─jobs──►│ apps/worker  │──► LLM providers
  Browser ──HTTPS (Cloudflare)──►│ API + web    │        │ analysis,    │    (Anthropic, Bedrock,
                                 └──────┬───────┘        │ posting,     │     Vertex, local)
                                        │                │ indexing     │──► GitHub API
                                        ▼                └──────┬───────┘
                                 ┌─────────────────────────────────────┐
                                 │ Postgres (RLS per org, pgvector,     │
                                 │ pg-boss queue)                       │
                                 └─────────────────────────────────────┘
                                 Object storage (R2): renders, exports
```

## Code layout and dependency direction

```
apps/server, apps/worker, apps/web
        │ use
        ▼
adapters: packages/db · forge-github · llm · crypto · log · config · renderer
        │ implement ports from
        ▼
packages/core  (domain + ports; no I/O — enforced by ESLint)
packages/schema (analysis document; shared contract)
```

| Path                         | Role                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`                | Fastify HTTP API, GitHub webhook receiver, serves the web build                                                                        |
| `apps/worker`                | pg-boss consumers: analysis, posting reviews, retention, indexing                                                                      |
| `apps/web`                   | React SPA: PR review page, inbox, settings, project memory                                                                             |
| `packages/core`              | Domain logic and ports (`Entitlements`, `Clock`, `Forge`, `WebhookIngress`, `WebhookInbox`, later `LlmProvider`, `Storage`, `Billing`) |
| `packages/schema`            | Analysis document (graph + triage + findings), JSON Schema emit, fixtures                                                              |
| `packages/db`                | SQL migrations + Drizzle mirror, RLS policies, `withOrg` client, append-only audit, retention purge                                    |
| `packages/forge-github`      | GitHub App auth, webhooks, PR mirror, posting reviews                                                                                  |
| `packages/llm`               | Roles, providers, validate-and-repair, metering hooks                                                                                  |
| `packages/renderer`          | Deterministic change-map SVG (adapted from PR Lens, MIT)                                                                               |
| `packages/crypto`            | Envelope encryption for tokens and customer API keys                                                                                   |
| `packages/log`               | Pino with redaction, request ids, OpenTelemetry ids — see [logging.md](logging.md)                                                     |
| `packages/config`            | Config loading and validation                                                                                                          |
| `packages/evals`             | Seeded PRs and scoring for the AI pipeline                                                                                             |
| `ee/`                        | Commercial features (SSO, audit-log UI, org policies, insights) — `ee/LICENSE`                                                         |
| `rocky-cloud` (private repo) | Billing (Paddle), entitlements, managed LLM keys, infra, compliance                                                                    |

## Data layer

- Three database roles (ADR 0005): the migrator owns the schema, runs `pnpm db:migrate` and
  writes the retention settings; the application logs in as a member of `rocky_app` (RLS
  enforced, no bypass, no TEMP objects); `rocky_retention` owns the `SECURITY DEFINER` purge and
  org-deletion functions and nothing else.
- Every table in `public` is a tenant table: `org_id NOT NULL` with `ON DELETE CASCADE` to `orgs`,
  composite foreign keys to parents, `FORCE ROW LEVEL SECURITY`, one policy for `rocky_app`.
- Webhooks (ADR 0007): `POST /webhooks/github` verifies `X-Hub-Signature-256` over the raw body
  before parsing, decodes the few fields the domain needs and inserts one row into
  `app.webhook_deliveries`, a non-tenant inbox (installations precede orgs) that the app role can
  only `INSERT` into, deduplicated by delivery id and body sha256 in the database. The worker
  consumes it and re-reads state from the forge before acting.
- GitHub App (ADR 0008): created by the manifest flow (`GITHUB_APP_SETUP=true`, development
  only, one-time token printed to the terminal); four permissions (`contents:read`,
  `pull_requests:write`, `checks:read`, `metadata:read`) and one subscribed event
  (`pull_request`), pinned by a test. The conversion's credentials are written once to a
  `0600` file for the operator's secret manager; they are never logged or stored in the database.
- `withOrg` hands out a transaction-bound handle: it is refused after the transaction ends, and
  it refuses transaction-control, role and `app.*` statements. Detached work (timers, listeners)
  must start its own `withOrg` from outside.
- `audit_events` is append-only (trigger). Retention periods live in `app.retention_settings`
  (analyses 90 d, finished jobs 30 d, audit 365 d, org deletion grace 7 d; `RETENTION_*_DAYS`,
  `ORG_DELETION_GRACE_DAYS` applied by the migrator). Purge functions delete rows strictly older
  than `period` before the database clock and audit the purge in the same statement.
- Integration tests run on Testcontainers with the pgvector image pinned in
  `docker-compose.dev.yml`; the isolation suite enumerates tables, views, SECURITY DEFINER
  functions and default ACLs from `pg_catalog` (`packages/db/THREATS.md` maps each threat to its
  test).
