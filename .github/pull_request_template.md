## Task

<!-- Task ID and title from the project plan, e.g. "P2-2 RLS policies + tenant-scoped client" -->

**Risk:** 🟢 NORMAL / 🔴 RISKY

## Acceptance criteria

<!-- Copy each criterion from the task and show the evidence (test name, screenshot, output). -->

- [ ] Criterion 1 — evidence:
- [ ] Criterion 2 — evidence:

## Definition of Done

- [ ] `pnpm verify` passes
- [ ] Tests cover new logic (coverage floor kept for core/schema/db/llm/crypto)
- [ ] No secrets, no new high/critical vulnerabilities, CodeQL/Semgrep clean
- [ ] No code, diffs, tokens, emails or prompts in logs
- [ ] Docs / ADR updated if behaviour or architecture changed
- [ ] UI only: screenshots (375/1024/1440 × light/dark) attached, axe clean, keyboard path works, parity items ticked

## Threat model (🔴 RISKY only)

<!-- Assets, what can go wrong, how it is prevented, how it is tested. -->

## Review

- [ ] Independent reviewer agent: no open high-severity findings
- [ ] 🔴 only: `/security-review` passed

## Follow-ups

<!-- Anything noticed but out of scope (also added to docs/progress.md). -->
