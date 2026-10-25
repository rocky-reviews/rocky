# Progress

Task log for the project plan. Agents append a row when a task is merged.

| Task  | Status | Evidence                                                                      | Follow-ups                      |
| ----- | ------ | ----------------------------------------------------------------------------- | ------------------------------- |
| P0-1  | done   | `pnpm verify` green; core import rule fires on planted `pg`/`node:fs` imports | —                               |
| P0-5  | done   | `pnpm dev` → `/healthz` 200 with DB, worker connected, web served             | S3-compatible dev store in P5   |
| P0-6  | done   | Hosting ADR (private repo)                                                    | —                               |
| P0-7  | done   | ADRs 0002–0004, `docs/architecture.md`                                        | —                               |
| P0-8  | done   | 60 screenshots in `docs/design/poc/`                                          | —                               |
| P0-9  | done   | `docs/design/poc-parity.md`                                                   | Reviewer spot-check of 10 items |
| P0-10 | done   | `tokens.css` + `scripts/design-tokens.test.ts`; raw-colour check in lint      | —                               |

## Remote verification (2026-10-25, first push to rocky-reviews/rocky)

- First CI run on `main`: verify, CodeQL, Semgrep, gitleaks, osv-scanner all green; `verify` took 37 s (P0-1: under 5 min).
- `scripts/github/protect-main.sh` applied: PR required, 7 required checks pinned to the GitHub Actions app, linear history, signed commits, no force push, enforced for admins; secret scanning + push protection on (P0-3).
- `cla-signatures` branch created (P0-2).
- This PR is the P0-4 dry run: opened from a task branch with the PR template, merged only after all required checks passed.
