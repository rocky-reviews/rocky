# Architecture

Decisions behind this page:
[ADR 0002 modular monolith](adr/0002-architecture.md), [ADR 0003 tenancy](adr/0003-tenancy.md),
[ADR 0004 schema-first LLM](adr/0004-schema-first-llm.md),
[ADR 0005 migrations and roles](adr/0005-migrations-and-roles.md).

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

| Path                         | Role                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/server`                | Fastify HTTP API, GitHub webhook receiver, serves the web build                                               |
| `apps/worker`                | pg-boss consumers: analysis, posting reviews, retention, indexing                                             |
| `apps/web`                   | React SPA: PR review page, inbox, settings, project memory                                                    |
| `packages/core`              | Domain logic and ports (`Entitlements`, `Clock`, later `Forge`, `LlmProvider`, `Storage`, `Queue`, `Billing`) |
| `packages/schema`            | Analysis document (graph + triage + findings), JSON Schema emit, fixtures                                     |
| `packages/db`                | SQL migrations + Drizzle mirror, RLS policies, `withOrg` client, append-only audit, retention purge           |
| `packages/forge-github`      | GitHub App auth, webhooks, PR mirror, posting reviews                                                         |
| `packages/llm`               | Roles, providers, validate-and-repair, metering hooks                                                         |
| `packages/renderer`          | Deterministic change-map SVG (adapted from PR Lens, MIT)                                                      |
| `packages/crypto`            | Envelope encryption for tokens and customer API keys                                                          |
| `packages/log`               | Pino with redaction                                                                                           |
| `packages/config`            | Config loading and validation                                                                                 |
| `packages/evals`             | Seeded PRs and scoring for the AI pipeline                                                                    |
| `ee/`                        | Commercial features (SSO, audit-log UI, org policies, insights) — `ee/LICENSE`                                |
| `rocky-cloud` (private repo) | Billing (Paddle), entitlements, managed LLM keys, infra, compliance                                           |

## Data layer

- Three database roles (ADR 0005): the migrator owns the schema and runs `pnpm db:migrate`;
  the application logs in as a member of `rocky_app` (RLS enforced, no bypass); `rocky_retention`
  owns the `SECURITY DEFINER` purge functions and nothing else.
- Every table in `public` is a tenant table: `org_id NOT NULL` with `ON DELETE CASCADE` to `orgs`,
  composite foreign keys to parents, `FORCE ROW LEVEL SECURITY`, one policy for `rocky_app`.
- `audit_events` is append-only (trigger). Retention: analyses 90 d, finished jobs 30 d, audit
  365 d (`RETENTION_*_DAYS`), rows strictly older than the cutoff are deleted and the purge is
  itself audited per org.
- Integration tests run on Testcontainers with the pgvector image pinned in
  `docker-compose.dev.yml`; the isolation suite enumerates tables from `pg_catalog`
  (`packages/db/THREATS.md` maps each threat to its test).
