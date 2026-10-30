# ADR 0029: Review inbox, "safe to bulk-approve", and approval only per confirmed batch

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-10-30
- **Task:** P6-7
- **Builds on:** [ADR 0011](0011-repository-access-check.md) (repository access check),
  [ADR 0019](0019-web-app-shell.md) (web shell, data ports),
  [ADR 0024](0024-org-roles-and-access-policy.md) (one access policy for every route)

## Context

A reviewer needs one place that lists the open pull requests across the org's repositories,
riskiest first, with filters. Many pull requests are small and low risk (typo fixes, dependency
bumps); approving them one page at a time wastes time, so the inbox offers them as a group to
approve together. That group is computed from the analysis, which is model output. Rocky's rules
say model output never triggers a side effect and only a person posts, so the group can only be
a suggestion: the person must confirm each batch, and the server must re-check everything before
anything reaches GitHub. Posting as the user is P3-5, built in parallel; this task must not depend
on it.

## Decision

### 1. One pure assessment, in core

`packages/core/src/review-inbox.ts` holds `assessPullRequest(facts)`: risk (the verdict level, or
`unknown` without a current, readable analysis), the analysis state, finding counts, the review
estimate, and whether the PR is offered for bulk approval with the reasons it is not (fixed
codes). The server runs it on stored rows; the web's fixture is checked against it; the approvals
route runs it again before approving. The document is used only after `parseAnalysisDocument`
and only when its provenance names this PR (`readInboxDocument`) and the analysed commit.

A PR is **offered** only when every check passes:

| Check                                                  | Written by     | Blocker               |
| ------------------------------------------------------ | -------------- | --------------------- |
| open                                                   | GitHub mirror  | `not_open`            |
| not the viewer's own PR (GitHub refuses self-approval) | GitHub mirror  | `own_pull_request`    |
| a done, valid analysis of the current head             | pipeline       | `no_current_analysis` |
| verdict `low`                                          | model          | `risk_not_low`        |
| verdict not below Rocky's floor (`belowVerdictFloor`)  | pipeline check | `verdict_below_floor` |
| no findings at all (any severity)                      | model          | `findings`            |
| no file triaged critical or important                  | model          | `risky_files`         |
| no migration or auth path (Rocky's `preTriage` rules)  | Rocky's rules  | `sensitive_paths`     |
| no unanalysed file                                     | pipeline       | `unanalysed_files`    |
| no read-by-hand file                                   | pipeline       | `read_by_hand`        |
| the briefing is the AI's (not Rocky's fallback)        | pipeline       | `briefing_by_rocky`   |
| the head's diff was read in full                       | mirror         | `diff_incomplete`     |
| at most `MAX_BULK_APPROVE_LINES` (300) changed lines   | GitHub mirror  | `too_large`           |

Several of these do not depend on the model, so a prompt injection that talks the verdict down to
`low` still cannot put an auth change, a migration, a truncated diff or a large PR in the group.
Sorting is by risk (critical, high, medium, unknown, low), then by critical, high and medium
finding counts, then the longest-waiting first, then repository and number.

### 2. Routes (ADR 0024 policy; matrix rows in `policy.db.test.ts`)

| Route                       | Permission             | Notes                                                  |
| --------------------------- | ---------------------- | ------------------------------------------------------ |
| `GET /api/inbox`            | `pull_requests.review` | 503 without the access check                           |
| `POST /api/inbox/approvals` | `pull_requests.review` | CSRF-checked; 503 without the approver or access check |

- **List.** Up to `MAX_INBOX_ITEMS` (100) open PRs of enabled repositories, most recently updated
  first, read in the member's `withOrg` (`packages/db/src/review-inbox.ts`). The P3-6 check is
  asked once per repository (at most 4 at a time); a denied repository's PRs are left out as if
  they did not exist. Answered `no-store`.
- **Approve.** Body `{ pullRequests: [{ id, headSha }] }`, 1 to `MAX_BULK_APPROVE_BATCH` (20)
  unique entries, strict (any other field is a 400). The server re-reads every PR in the member's
  org and re-runs the access check and the assessment. Any PR unknown, of another org or
  unreadable answers 404 for the whole batch; any PR whose head moved past the commit the person
  saw (`head_moved`) or that is no longer offered (`not_eligible`) answers 409 with the refusals;
  in both cases nothing is approved. Otherwise each PR goes to the `PullRequestApprover` port in
  order; a thrown error or a refusal from the forge is reported as `failed` for that PR only. A
  second batch from the same member while one is running is refused (409 `batch_in_progress`,
  per process).
- The actor and the org come from the session, never from the body.
- Logs carry ids, counts and fixed outcomes, never titles, logins or bodies.

### 3. The approver is a port P3-5 fills

`PullRequestApprover.approve({ orgId, memberId, pullRequestId, headSha })` (core) submits one
approving review as that member, pinned to `headSha`. `buildApp` takes it as
`pullRequestApprover`; `startServer` does not pass one yet, so a running server answers 503
`approve_unavailable` and the page says bulk approval is not available. Only the approvals route
calls it: not the worker, not anything reading model output.

### 4. Web (`apps/web/src/inbox/`, page `/inbox`)

- An `InboxSource` port with an HTTP source (`?source=api`: same origin, the session's CSRF
  token on the POST, answers validated with the core schemas, results that name other PRs than
  the batch are not believed) and a fixture source (the default until every page reads the
  server; its `approve` only answers).
- Nothing is selected on load. "Approve n selected…" opens a modal `<dialog>` listing exactly the
  batch with each short commit; Cancel is focused first, Escape and Cancel send nothing, the
  confirm button is inert for 600 ms after the dialog opens (on narrow screens the second click
  of a double-click on the opener can land where it appears), then sends one request and is
  disabled (and ref-guarded) while it runs, and the
  dialog cannot be dismissed until the answer is in. A filter narrows the batch to what is shown. After an approval, focus moves to the group's heading (the
  opener is gone or disabled).
- PR text is rendered as React text in `<bdi>`; the row link is built from validated names
  (`/?repo=owner%2Fname&pr=n`), never from data.

## Consequences

- The inbox works today against the fixture and against the server's list; approvals need P3-5.
- `apps/server` gains a dev dependency on `@rocky-reviews/schema` (test fixtures only).
- The list parses up to 100 stored documents per request; a stored summary per analysis would
  make it cheaper (follow-up).

## Residual risks

- The double-submit guard is per process; with several server processes two identical batches
  could both reach the approver. P3-5's posting should be idempotent per (member, PR, head).
- The repository access check is not wired in `startServer` yet (ADR 0024), so a running server
  answers 503 on both routes until it is.
- Low-risk PRs with no findings can still be wrong; the group is a suggestion, the dialog says
  so, and the person decides.
