# ADR 0002 — Modular monolith with ports and adapters

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Rocky Reviews is built and maintained mostly by AI agents with a very small human team. It
ships two ways — self-hosted (one install, one org or a few) and Rocky Cloud (multi-tenant) —
from the same code. It talks to several outside systems that will change or multiply over time:
GitHub (later GitLab/Gitea), LLM providers (Anthropic, Bedrock, Vertex, Foundry, local models),
object storage, the job queue, and billing (Paddle, possibly others).

## Decision

1. **One codebase, two process types.** `apps/server` (HTTP API, GitHub webhooks, serves the
   web build) and `apps/worker` (pg-boss jobs). They share packages and one Postgres database.
   No microservices until a measured need (load, isolation, team boundaries) appears.
2. **Ports and adapters (hexagonal).** `packages/core` contains domain logic and the
   interfaces it needs (`Forge`, `LlmProvider`, `Storage`, `Queue`, `Entitlements`, `Billing`,
   `Clock`, …). Adapters live in their own packages (`forge-github`, `llm`, `db`, …) or in
   `rocky-cloud`. Core does no I/O.
3. **The rule is enforced, not remembered.** ESLint `no-restricted-imports` fails any import of
   adapter libraries, adapter packages or `node:*` from `packages/core/src` (verified by
   planting a forbidden import, see P0-1).
4. **Cloud is a plugin.** `rocky-cloud` depends on released `rocky` packages and supplies its own
   implementations of ports (`Entitlements` backed by plans, `Billing` backed by Paddle,
   managed LLM keys). It never patches core.
5. **Workspace packages are consumed as TypeScript source** (`exports` → `src/index.ts`), run
   with `tsx` in development and bundled for production images (Phase 10). This keeps the dev
   loop instant and avoids per-package build steps.

## Consequences

- One deploy unit, one database, simple local dev (`pnpm dev`).
- Swapping or adding a provider means writing an adapter, not touching domain logic.
- Domain logic is unit-testable without databases or network.
- The monolith must keep module boundaries clean on its own; the lint rule and code review are
  the guard. If a boundary keeps being crossed, that is a signal to revisit this ADR.

## Tooling note

TypeScript is pinned to **6.0.x**: `typescript-eslint` 8.72 supports `<6.1`, so TypeScript 7
(native) waits until the linter supports it. Revisit when `typescript-eslint` widens its range.
