# Security Policy

Rocky Reviews reads other people's pull requests. We treat the security of that data as the
product. If you find a vulnerability, we want to hear about it, and we will not take legal
action against good-faith research that follows this policy.

## Reporting a vulnerability

**Email: security@rockyreviews.dev**

Please do **not** open a public GitHub issue for security problems.

Include what you can of:

- a description of the issue and its impact (what an attacker could do),
- the affected component (web app, API, GitHub App / webhooks, worker, `ee/`, Cloud, self-host
  packaging) and version or commit,
- steps to reproduce or a proof of concept,
- any logs or screenshots, with real customer data removed,
- how you would like to be credited, if at all.

If you prefer, you can encrypt your report; ask for our PGP key in a first email. Reports
through GitHub's private vulnerability reporting (the "Report a vulnerability" button on the
repository's Security tab) reach the same people once that feature is enabled for the repo.

## What happens next (response targets)

| Step                                   | Target                              |
| -------------------------------------- | ----------------------------------- |
| Acknowledge your report                | within 2 business days              |
| Initial assessment and severity rating | within 5 business days              |
| Fix for critical / high severity       | within 14 days of confirmation      |
| Fix for medium / low severity          | within 90 days of confirmation      |
| Public disclosure                      | coordinated with you, after the fix |

We will keep you informed of progress and tell you when the fix ships. We ask that you give us
reasonable time to fix the issue before disclosing it publicly, and that you do not access,
modify or delete data that is not yours while testing.

Rocky Reviews does not currently run a paid bug bounty. We credit reporters in release notes
and in `docs/security/hall-of-fame.md` unless you ask us not to.

## Supported versions

Rocky Reviews is pre-1.0. Security fixes go to:

| Version                       | Supported                                              |
| ----------------------------- | ------------------------------------------------------ |
| `main` and the latest release | yes                                                    |
| Rocky Reviews Cloud (hosted)  | always runs the latest release                         |
| Earlier releases              | no — please upgrade; self-host upgrades are documented |

Once 1.0 ships, this table will list the supported minor versions (we intend to support the
current and previous minor for security fixes).

## Scope

In scope: this repository (`rocky`, including `ee/`), the published packages under
`@rocky-reviews`, the Rocky Reviews GitHub App, and the hosted service at `rockyreviews.dev`.
Issues in third-party dependencies should go to those projects; tell us too if they affect
Rocky Reviews.

Out of scope: denial of service by volume, reports from automated scanners without a working
proof of concept, missing best-practice headers with no demonstrated impact, social engineering
of staff, and physical attacks.

## How we keep the code secure

Every pull request runs CodeQL, Semgrep, gitleaks (also as a local pre-commit hook) and
osv-scanner; Dependabot keeps dependencies and action pins current; `main` requires a pull
request, green checks, linear history and signed commits. AI-generated code is never merged
without review. Details are in `docs/security/` and the repository's workflows under
`.github/workflows/`.
