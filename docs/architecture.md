# Architecture

Decisions behind this page:
[ADR 0002 modular monolith](adr/0002-architecture.md), [ADR 0003 tenancy](adr/0003-tenancy.md),
[ADR 0004 schema-first LLM](adr/0004-schema-first-llm.md),
[ADR 0005 migrations and roles](adr/0005-migrations-and-roles.md),
[ADR 0006 envelope encryption](adr/0006-envelope-encryption.md),
[ADR 0007 forge port and webhook inbox](adr/0007-webhook-inbox.md),
[ADR 0008 GitHub App manifest](adr/0008-github-app-manifest.md),
[ADR 0009 installation lifecycle](adr/0009-installation-lifecycle.md),
[ADR 0010 pull request mirror](adr/0010-pull-request-mirror.md),
[ADR 0011 repository access check](adr/0011-repository-access-check.md),
[ADR 0012 LLM roles and provider port](adr/0012-llm-roles-and-provider-port.md),
[ADR 0013 LLM provider adapters](adr/0013-llm-provider-adapters.md).

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

| Path                         | Role                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`                | Fastify HTTP API, GitHub webhook receiver, serves the web build                                                                                                                                    |
| `apps/worker`                | Background jobs: webhook inbox consumer (installations, pull request mirror), org deletion sweep, retention; `pnpm mirror:rebuild`; later analysis, posting, indexing                              |
| `apps/web`                   | React SPA: PR review page, inbox, settings, project memory                                                                                                                                         |
| `packages/core`              | Domain logic and ports (`Entitlements`, `Clock`, `Forge`, `WebhookIngress`, `WebhookInbox`, `UserAccessReader`, the repository access check, `LlmProvider`/`LlmRoles`, later `Storage`, `Billing`) |
| `packages/schema`            | Analysis document (graph + triage + findings), JSON Schema emit, fixtures                                                                                                                          |
| `packages/db`                | SQL migrations + Drizzle mirror, RLS policies, `withOrg` client, append-only audit, retention purge                                                                                                |
| `packages/forge-github`      | GitHub App auth, webhooks, PR mirror, posting reviews                                                                                                                                              |
| `packages/llm`               | Role config (`ROCKY_LLM_*`), provider capabilities, role registry, provider adapters (Anthropic, Bedrock, Vertex, Foundry, OpenAI-compatible); later validate-and-repair, metering hooks           |
| `packages/renderer`          | Deterministic change-map SVG (adapted from PR Lens, MIT)                                                                                                                                           |
| `packages/crypto`            | Envelope encryption for tokens and customer API keys                                                                                                                                               |
| `packages/log`               | Pino with redaction, request ids, OpenTelemetry ids — see [logging.md](logging.md)                                                                                                                 |
| `packages/config`            | Config loading and validation                                                                                                                                                                      |
| `packages/evals`             | Seeded PRs and scoring for the AI pipeline                                                                                                                                                         |
| `ee/`                        | Commercial features (SSO, audit-log UI, org policies, insights) — `ee/LICENSE`                                                                                                                     |
| `rocky-cloud` (private repo) | Billing (Paddle), entitlements, managed LLM keys, infra, compliance                                                                                                                                |

## LLM roles

- ADR 0012: the pipeline asks a role (`triage`, `review`, `graph`, `ask`, `embed`) for a
  structured completion or embeddings through `LlmRoles` (`packages/core/src/llm.ts`). It never
  sees a provider. `packages/llm` validates the per-role provider + model + effort config
  (`llmConfigFromEnv`, `ROCKY_LLM_*` in `.env.example`) against each provider's capabilities and
  fails fast. Defaults: triage Haiku 5.5, review Opus 5.5, graph and ask Sonnet 5.5, all on the
  Anthropic API. Embeddings stay off until configured. `createLlmRoles` resolves each role to the
  adapter factory of its provider, so switching provider is a config change.
- The config names credentials by variable (`apiKeyEnv`) and never holds them. Adapters read
  keys through a `SecretSource` at call time (env today, per-org BYOK later).
- ADR 0013: `providerAdapters()` supplies those factories.
  - **Claude platforms:** one Messages core with four platform clients: the Anthropic API,
    Bedrock (Mantle), Vertex and Foundry, all on the official SDKs.
    - Every request is streamed, uses structured outputs (`output_config.format`), and maps
      effort to `output_config.effort` with adaptive thinking.
    - It has one cache breakpoint, on Rocky's instructions. PR content sits in nonce-delimited
      `pr_content` blocks in the user turn. No tools are sent.
    - On the Anthropic API, server-side refusal fallbacks run (`fallbacks: "default"`).
  - **OpenAI-compatible:** `fetch` to `/chat/completions` (`response_format: json_schema`, with
    the schema in the prompt as the fallback) and `/embeddings`.
  - **Clients:** each one pins its host from config, so no `ANTHROPIC_*_BASE_URL` variable or
    redirect moves it. Clients have SDK logging and OpenTelemetry off. Every failure becomes a
    body-free `LlmCallError`.

## Data layer

- Database roles (ADR 0005, ADR 0009): the migrator owns the schema, runs `pnpm db:migrate` and
  writes the retention settings; the server logs in as a member of `rocky_app` (RLS enforced, no
  bypass, no TEMP objects); the worker logs in as a member of `rocky_app` and `rocky_worker` (the
  only role that creates orgs, claims inbox rows and erases orgs). Each refuses the other's
  login: the worker starts only as a `rocky_worker` member; the server starts only on a plain
  `rocky_app` login (an allow-list for both session and current user: no privilege attribute, no
  other membership by any grant option, owns nothing, cannot reach `rocky_worker`,
  `rocky_lifecycle`, `rocky_retention` or the owner), checked at boot and on each new connection;
  connections are recycled every 5 minutes, which bounds a grant made while one is open;
  `rocky_retention` and
  `rocky_lifecycle` own the `SECURITY DEFINER` purge, deletion and inbox functions and nothing else.
- Every table in `public` is a tenant table: `org_id NOT NULL` with `ON DELETE CASCADE` to `orgs`,
  composite foreign keys to parents, `FORCE ROW LEVEL SECURITY`, one policy for `rocky_app`.
- Webhooks (ADR 0007): `POST /webhooks/github` verifies `X-Hub-Signature-256` over the raw body
  before parsing, decodes the few fields the domain needs and inserts one row into
  `app.webhook_deliveries`, a non-tenant inbox (installations precede orgs) that the app role can
  only `INSERT` into, deduplicated by delivery id and body sha256 in the database. The worker
  claims rows of its forge with a lease, one live lease per installation (oldest first, at a cost per
  claim that does not grow with the backlog; a row is finished by its own lease holder, whose
  verified completion also collapses earlier same-type duplicates of its installation), re-validates them and re-reads state from the forge before acting.
  Outages back off and wait; rows that keep failing for their own reasons are parked.
- Installation lifecycle (ADR 0009): nothing is claimed or erased until `GET /app` proves the
  key belongs to `GITHUB_APP_ID`. `installation.created` creates an org only if
  `GET /app/installations/{id}` (app JWT, RS256 via `node:crypto`) says it exists; orgs bind by
  installation id and the immutable account id, never by login. `installation.deleted` schedules
  deletion only on GitHub's own JSON 404; contradictions are retried before they are believed.
  Only the worker can write the deadline, which the database bounds to the 7-day grace (+1 h). A
  reinstall within the grace period rebinds the org and cancels the deletion. The worker's sweep
  asks GitHub again (still installed → cancel), marks the org erasing (a reinstall from then on
  gets a fresh org), erases external stores (`OrgErasers`: object storage, embeddings), then
  `retention.delete_org`, which cascades through every tenant table, deletes or scrubs the
  installation's inbox rows and leaves a tombstone in `app.org_deletions`.
- Pull request mirror (ADR 0010): the worker's `pull_request` lane re-reads each pull request
  from GitHub (the event is a hint) on an installation token minted per row for that one
  repository with `contents`/`pull_requests: read` only, checked, and revoked when the row is
  done; it upserts `repos`, `pull_requests` (never over a newer `forge_updated_at`) and the head
  revision in `pr_revisions` with its diff reading (bytes, sha256, `diff_truncation`:
  `max_bytes` past 1 MiB, `forge_limit`, `unavailable`). Diff text is not stored. Claims cover
  whole lanes, so no lane stops behind a type nobody claims. `pnpm mirror:rebuild <owner/name>`
  recreates a repository's mirror from GitHub (pull requests and their current head revisions;
  nothing deleted).
- Repository access (ADR 0011): Rocky membership is not enough to see a repository's data; the
  member must be able to read the repository on GitHub. `createRepositoryAccess`
  (`apps/server/src/repository-access.ts`, over `createRepositoryAccessCheck` in `packages/core`)
  reads the member, the repository's name and the encrypted token inside `withOrg`, decrypts the
  token for one call and asks GitHub as the user: `GET /user` (the token must be the member's
  `forge_user_id`), `GET /repos/{owner}/{repo}` (`permissions.pull`, same repository id) and, for a
  repository that is not private, membership (`GET /repos/{o}/{r}/collaborators/{login}`, 204/404) on an installation token minted for that one repository with `metadata: read` and revoked after use, never the effective-role `/permission` endpoint. An allow is cached per org + member + repository for at most 5 minutes from the
  question and never extended (an outage after that is a deny); denies for 30 s (5 s when
  transient); bounded LRU; invalidation hooks. Every failure denies. P7-2 must call it on every
  route that touches a repository's data, after resolving the repository with
  `resolveRepositoryForAccess` and before loading anything else; every deny answers 404
  (ADR 0011 §6).
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
