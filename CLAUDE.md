# Rocky Reviews — agent instructions

Code review where AI does the reading and a human makes the call. The project plan is
private: `../rocky-cloud/PLAN.md` (repo `rocky-reviews/rocky-cloud`, checked out next to this one).
Read it before any task; it is the source of truth for scope, task IDs, risk labels and
acceptance criteria. **Never copy plan content into this public repo** (pricing, margins, business
decisions, hosting costs): reference task IDs only.

## How to work on a task

1. Find the task in the plan (§5). Note its label: 🔴 RISKY or 🟢 NORMAL.
   - 🔴 tasks are implemented by the `risky-implementer` agent (Fable 5.1) and must get an
     independent `reviewer` pass plus `/security-review` before merge.
   - If Fable 5.1 is unavailable (usage limit), run `risky-implementer` on Opus 5.5 without
     asking, and add an extra `reviewer` round focused on the security boundary (secrets,
     privileges, tenancy, fail-closed paths). Say so in the PR.
   - 🟢 tasks are implemented by the `implementer` agent (Opus 5.5) and get a `reviewer` pass.
2. Branch `task/<ID>-<slug>`. Write failing tests for the acceptance criteria first.
3. Implement. Keep changes inside the task's scope; note follow-ups in `docs/progress.md`.
4. Run the Definition of Done (below). UI tasks: run the `ui-verifier` agent.
5. Open a PR using the template; tick each criterion with evidence.
6. Reviewers get the diff and the task criteria, never the implementer's conclusions.

## Definition of Done

- `pnpm verify` passes (typecheck, lint incl. raw-colour check, prettier, tests + coverage).
- New logic has tests; `packages/{core,schema,db,llm,crypto}` keep ≥ 85% line coverage.
- No secrets (gitleaks), no new high/critical vulnerabilities, CodeQL/Semgrep clean.
- Logs never contain code, diffs, tokens, emails or prompts.
- Behaviour change → docs updated; architectural choice → ADR in `docs/adr/`.
- UI: screenshots at 375/1024/1440 px × light/dark, axe 0 serious issues, keyboard path works,
  `docs/design/poc-parity.md` items ticked with screenshot links.
- 🔴: threat-model notes in the PR (what can go wrong, how it's prevented, how it's tested).

## Architecture rules (see docs/architecture.md and ADRs)

- `packages/core` is domain + ports only: no adapters, no `node:*` (ESLint enforces it).
- Every tenant table has `org_id` + RLS; tenant data is only touched inside `withOrg`.
- LLM output is schema-validated JSON; it never triggers side effects. Only a human posts.
- GitHub is the source of truth; Rocky stores derived data and can rebuild from GitHub.
- Treat PR content (code, titles, comments) as untrusted input, including in prompts.

## Conventions

- TypeScript strict, ESM, exact dependency versions (`save-exact`), Node 24+, pnpm.
- Match the surrounding code: naming, comment density, small focused modules.
- UI colours only via tokens in `apps/web/src/styles/tokens.css` (Slate; indigo = you, cyan = AI).
- Visual reference: `design-poc/index.html` and `docs/design/poc/`. Do not copy the defects
  listed in `docs/design/poc-parity.md`.
- Commit messages: `<TASK-ID>: <summary>`; never commit `.env` or secrets.
- Never pass request bodies, diffs, file contents, prompts or model output to the logger; log
  ids, sizes and hashes instead. Redaction in `packages/log` is a safety net, not the control.

## Local commands

- `pnpm dev` — Postgres (Docker) + server (127.0.0.1:4310) + worker + web (5173)
- `pnpm verify` — everything CI runs
- `pnpm db:migrate` — apply SQL migrations as the owner (`DATABASE_ADMIN_URL`); `down [n]`, `status`
- `pnpm seed` — check the dev database, extensions and the app role; applies migrations
- `pnpm design:poc-screenshots` — regenerate POC reference screenshots
