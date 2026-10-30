# ADR 0027: AI drafts and pending comments, kept on the server per reviewer

- **Status:** Accepted
- **Date:** 2026-10-30
- **Task:** P6-4
- **Builds on:** [ADR 0004](0004-schema-first-llm.md) (findings are drafts a human decides),
  [ADR 0024](0024-org-roles-and-access-policy.md) (`drafts.own`, the route matrix),
  [ADR 0020](0020-github-login-and-sessions.md) (CSRF), [ADR 0011](0011-repository-access-check.md)

## Context

The PR page shows each AI finding as a draft under its line. The reviewer accepts it, edits it,
dismisses it with a reason, or copies its fix prompt for a coding agent, and can undo any of
it. The decisions must survive a reload, and Finish review (P6-6) and posting as the user (P3-5)
must be able to read exactly what will be posted. Project memory (P8) will later learn from
dismissal reasons; nothing learns yet.

## Decision

### 1. One state machine, in core

`packages/core/src/drafts.ts` (`applyDraftAction`), pure and shared by the server and the web
app:

| From \ action     | accept                        | edit(body)                         | dismiss(reason)    | undo  | send_to_agent         |
| ----------------- | ----------------------------- | ---------------------------------- | ------------------ | ----- | --------------------- |
| draft             | accepted (the finding's body) | accepted, edited (reviewer's body) | dismissed (reason) | —     | draft (prompt copied) |
| accepted / edited | —                             | —                                  | —                  | draft | —                     |
| dismissed         | —                             | —                                  | —                  | draft | —                     |

"—" is `invalid_transition`. Reasons are fixed codes (`not_an_issue`, `intentional`,
`not_worth_it`, `handled_elsewhere`): no free text is stored about a dismissal. An edited body is
trimmed, 1..65,536 characters (GitHub's limit), without NUL.

**Send to agent** copies the finding's `agentPrompt` to the clipboard (as the POC does) and
records `agent_prompt_copied_at`; the draft stays undecided. Handing the prompt to an agent
directly needs an agent integration that does not exist (follow-up).

### 2. Storage (migration 0015)

- `findings_state` becomes **per reviewer**: one row per (analysis, member, finding), with the
  state, the reason code, who decided and when, and `agent_prompt_copied_at`. Two reviewers of
  one PR decide independently ("only you can see this until you accept it").
- `comments_pending` holds **one row per comment Finish review would post as that reviewer**:
  own comments (`source = 'own'`) and accepted drafts (`ai`, or `ai_edited` after an edit), each
  with `analysis_id`, its body and the new-side location (`path`, `start_line`..`line`;
  `start_line` only for multi-line ranges). An accepted draft's row is written in the same
  transaction as its decision and deleted by its undo; a unique key allows one row per draft.
- What is posted: an own comment's body as it is; for an accepted draft,
  `composePostedComment(finding, row)` (`packages/core/src/drafts.ts`): `**title**`, the row's
  body (the finding's, or the reviewer's edit), and the finding's suggestion as a `suggestion`
  block with a fence longer than any backtick run inside it. No severity, confidence or agent
  prompt. The accepted card renders the same parts (`postedCommentParts`), so the reviewer sees
  what will be posted. An edit replaces the body only; it cannot remove the suggestion. P3-5's
  `findingCommentBody` has the same format and switches to this function when the two merge.
- Location and body of a draft come from the stored, re-validated document, never from the
  request: the client names a finding id. An own comment's line must be a new-side line of one
  of the analysed file's hunks.
- Both belong to the analysis the reviewer saw. A new push gets a new analysis and a fresh set;
  carrying decisions over is a follow-up. Deleting the analysis (retention) deletes them.
- Tenancy as everywhere: `org_id`, RLS, composite foreign keys, only inside `withOrg`.

### 3. API (`apps/server/src/reviews/routes.ts`)

| Route                                                  | Body                         | Answers                                           |
| ------------------------------------------------------ | ---------------------------- | ------------------------------------------------- |
| `GET /api/analyses/:analysisId/review`                 |                              | 200 `{ analysisId, drafts, comments }`            |
| `POST /api/analyses/:analysisId/drafts/:findingId`     | `{ action, body?, reason? }` | 200 `{ draft }`, 409 `{ error, draft }`, 400, 404 |
| `POST /api/analyses/:analysisId/comments`              | `{ path, line, body }`       | 201 `{ comment }`, 400, 404                       |
| `DELETE /api/analyses/:analysisId/comments/:commentId` |                              | 204, 404                                          |

All need `drafts.own` (every role) **and** the P3-6 repository access check (503 without it; a
denial is the same 404 as an unknown analysis). The member and org come from the session.
Mutations pass the global CSRF guard. A decision locks its row (`FOR UPDATE`), so two tabs
acting at once resolve one after the other and the loser gets 409 with the current state. Logs
carry the action, a fixed outcome and ids, never a body.

### 4. Web app

`ReviewSource` port with an HTTP client (`data/review-http-source.ts`, CSRF token from
`/api/session`), answers validated in `data/review-data.ts`. `drafts/ReviewProvider.tsx` applies
decisions at once with the core function and reconciles with the server: a 409 shows the
server's state, a failure restores the previous one; actions on one draft run in order.
Nothing can be decided or commented before the reviewer's state has loaded (or after it failed
to): the cards are read-only and say why. Answers that arrive after the analysis on screen
changed are dropped. On a diff newer than the analysis, drafts, own comments and the comment
composer are hidden (they are anchored to the analysed lines) and the panel's items do not jump. The
shell data carries `analysisId` (the fixture source gives fixture PRs a stable one). Own
comments moved from the P6-3 in-memory store to the same provider.

## Consequences

- A reload shows the same review; P3-5 and P6-6 read `comments_pending` for "what will be
  posted".
- Until the repository access check is wired in `startServer` (ADR 0024 residual risk), these
  routes answer 503 in a running server; until the server serves the shell data, the dev page has
  fixture analysis ids the server does not know. The e2e suite answers the API from a test-side
  store (`apps/web/e2e/review-api.ts`); the server's persistence is tested on Postgres.
