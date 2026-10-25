# Architecture

Decisions behind this page: [ADR 0001 hosting](adr/0001-hosting.md),
[ADR 0002 modular monolith](adr/0002-architecture.md), [ADR 0003 tenancy](adr/0003-tenancy.md),
[ADR 0004 schema-first LLM](adr/0004-schema-first-llm.md). Full plan: [PLAN.md](../PLAN.md).

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
| `packages/db`                | Drizzle schema, SQL migrations, RLS policies, `withOrg` client                                                |
| `packages/forge-github`      | GitHub App auth, webhooks, PR mirror, posting reviews                                                         |
| `packages/llm`               | Roles, providers, validate-and-repair, metering hooks                                                         |
| `packages/renderer`          | Deterministic change-map SVG (adapted from PR Lens, MIT)                                                      |
| `packages/crypto`            | Envelope encryption for tokens and customer API keys                                                          |
| `packages/log`               | Pino with redaction                                                                                           |
| `packages/config`            | Config loading and validation                                                                                 |
| `packages/evals`             | Seeded PRs and scoring for the AI pipeline                                                                    |
| `ee/`                        | Commercial features (SSO, audit-log UI, org policies, insights) — `ee/LICENSE`                                |
| `rocky-cloud` (private repo) | Billing (Paddle), entitlements, managed LLM keys, infra, compliance                                           |
