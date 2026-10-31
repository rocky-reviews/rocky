# ADR 0019: Web app stack and the PR page shell

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P6-1
- **Amended by:** [ADR 0025](0025-security-headers-and-rate-limits.md) (P7-3: the server serves
  the build from `ROCKY_WEB_DIR` under a CSP without inline content; the build is checked);
  H4-2 (the server-backed source, addresses and the dev proxy; "Amendment (H4-2)" below);
  [ADR 0034](0034-pull-request-diff-endpoint.md) (H4-3: the diff is served)

## Context

`apps/web` was a placeholder. Phase 6 builds the PR review page from `design-poc/index.html`
across several tasks (shell, briefing, diff, drafts, keyboard, finish, inbox), while login and
sessions (P7-1) land in parallel. The architecture already names the web app a React SPA built
with Vite. P6-1 needs the first real page: the top bar, sidebar, main column and right panel,
matching the POC at 375/1024/1440 px in light and dark.

## Decision

1. **React 19 on Vite, nothing else yet.** JSX goes through Vite's built-in TypeScript
   transform (`"jsx": "react-jsx"`); no `@vitejs/plugin-react`, since fast refresh is not
   needed yet. A router and a query library come with the first task that has a second route
   or a server call (P6-7, P7-1), not before.
2. **Plain CSS on the tokens.** `src/styles/shell.css` ports the POC's shell rules and uses
   only `tokens.css` variables (raw-colour check). Where the POC fails WCAG AA contrast the app
   keeps the token and changes which one is used (listed in `docs/design/poc-parity.md`,
   Intentional differences); the palette itself is unchanged.
3. **A data port for the shell, validated in one place.** Components read a `ShellData`
   (`pull`: GitHub's facts about the PR; `myReview`; `analysis`: the validated document or
   null). Sources implement `ShellDataSource.load(ref, { signal })` and return **unchecked**
   parts (`RawShellData`, all `unknown`); `App` runs every load through `parseShellData`, so no
   source can hand the components unvalidated data (review round 1 chose this over a branded
   type). `parseShellData` checks the PR summary with the schema's GitHub rules (owner, repo,
   refs; author and approvers with a looser display-only login rule that admits legacy logins),
   the analysis with `parseAnalysisDocument`, and refuses an analysis whose repository or PR
   number differs from `pull`. Errors name fields, never values. Today `createFixtureSource()`
   serves pr-847; P7-1/P6-2 add a server-backed source.
4. **PR content is text.** Titles, paths, branch names and logins render as React text
   children only. ESLint forbids `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`,
   `insertAdjacentHTML`, `createContextualFragment`, `setHTMLUnsafe`, `parseHTMLUnsafe`,
   `parseFromString`, `srcDoc` and `document.write` in `apps/web` (tests included), in dotted,
   computed and `Object.assign` forms. Each PR string sits in a `<bdi>`, so bidi controls in it
   cannot reorder the text around it.
   The View on GitHub link is built from a validated owner, repo and number on
   `https://github.com`, never from a URL in the data; an invalid one shows no link.
5. **Theme without a flash.** `public/theme-init.js`, a classic render-blocking script in
   `<head>` (no inline script, so a strict CSP needs no hash), sets `<html data-mode>` from the
   saved choice or `prefers-color-scheme` before the first paint. The app then follows system
   changes until the viewer toggles; the choice is saved in `localStorage` with every access in
   `try/catch`. P6-9: at ≤ 760 px the toggle leaves the top bar for the shortcuts dialog (the
   `m` key works at every width), so the PR title and a labelled Finish review button fit.
6. **Responsive panels as drawers.** At the POC's breakpoints (right panel hidden at ≤ 1180 px,
   sidebar at ≤ 760 px) top-bar toggles open them as drawers (POC defect 5). An open drawer is a
   modal dialog (`role="dialog"`, `aria-modal`, labelled by its heading): the rest of the page,
   skip link included, is `inert`, Tab wraps inside it, and Escape or a scrim click closes it and
   returns focus to its toggle. If the window widens until the panel shows in place, focus moves
   to that region.
7. **Evidence.** Playwright (`apps/web/playwright.config.ts`, `pnpm test:e2e`): project `visual`
   compares against baselines in `apps/web/e2e/__screenshots__/` and writes copies plus POC
   side-by-sides to `artifacts/screenshots/P6-1/`; project `e2e` runs axe (0 serious), the
   keyboard paths and the theme checks. Component markup is tested in Vitest with
   `react-dom/server`, so unit tests need no DOM library.

### Amendment to §3 (P6-2): `analysisRun` and the head commit

`ShellData` carries `analysisRun`, where the PR's latest analysis stands (the `analyses` row,
P4-6), and `PullSummary` carries `headSha`, the PR's current head commit (40 lowercase hex, the
schema's `FullSha`). `parseShellData` checks both; the server endpoint for the shell data
implements exactly these rules.

- `analysisRun` is one of: `none` (no analysis row), `queued`, `running`,
  `awaiting_approval` with `estimatedTokens` and `limitTokens` (integers, 0 to 10⁹), `failed`
  with `code`, or `done`. Strict objects: no other fields.
- A failure carries only the pipeline's fixed code (`[a-z][a-z0-9_]{0,63}`, the shape
  `analyses.error_code` stores), never a message, a prompt or model output. The page maps the
  code to its own fixed text and shows the code itself.
- Without a document every state but `done` is allowed. With a document: `done`, or a newer run
  that has not produced its document yet (`queued`, `running`, `awaiting_approval`, `failed`);
  the page then shows that previous document under a fixed banner. `none` and a `superseded`
  failure contradict a document and are refused. A source that omits `analysisRun` gets `done`
  with a document and `none` without one.
- Head rule: when `analysis.provenance.head.sha` differs from `pull.headSha`, the briefing is
  marked out of date with a banner naming both short SHAs, whatever the run state, `done`
  included.
- An invalid or contradictory state fails the load ("invalid analysis state"), naming no value.

### Amendment (H4-2): the shell's data from the server, addresses, the dev proxy

- **Endpoint.** `GET /api/repos/:owner/:repo/pulls/:number` (`apps/server/src/pulls/routes.ts`,
  policy `pull_requests.review` plus the P3-6 repository access check; 503 without it, and an
  unknown PR, a disabled repository, another org's and a denied repository are the same 404)
  answers `RawShellData` plus `pullRequestId`. `pull` is the mirror's view (ADR 0010), names as
  GitHub spells them; `analysis` is the latest finished document, the head's, else an older
  push's (shown out of date by the head rule above), re-validated and refused unless it
  describes this PR; `analysisRun` is the head revision's latest `analyses` row as §3's
  amendment defines it (a stored document that fails validation reads `failed` /
  `invalid_document`; a `superseded` head run is served without the older document); `myReview`
  is the member's latest review posted from Rocky (P3-5). The db read is
  `loadPullRequestPage` (`packages/db/src/pull-request-page.ts`), inside `withOrg`.
- **What the mirror does not hold is `null`.** `PullSummary.headRef`, `baseRef`, `approvers`
  and `commentCount` are nullable (the mirror stores neither branch names nor GitHub's reviews
  and comments), and so are `additions`, `deletions` and `changedFiles` (before the head
  revision is recorded). The top bar leaves a null fact out ("by @author" instead of "wants to
  merge a → b") rather than guess it. Storing them in the mirror is a follow-up.
- **Addresses** (`apps/web/src/route.ts`): `/:owner/:repo/pull/:number` reads the server
  (`createHttpShellSource`; 401 → sign in with `returnTo` set to the page, 404/400 → not found,
  503 → "Repository access isn't available yet", anything else or an answer `parseShellData`
  refuses → "could not be loaded"); `/inbox` reads the server (`?source=fixture` for the
  fixture); the fixtures are reached only with an explicit switch on `/` (`?fixture=pr-847`,
  `?fixture=large-diff`, `?pr=`, `?repo=`, `?diff=`); `/` alone goes to `/inbox`; any other
  address is "no page". Names in an address pass the schema's GitHub rules before anything is
  built from them. The switches work only in the dev server and in builds with
  `VITE_ROCKY_FIXTURES=on` (Playwright's `perf` build): `main.tsx` folds the condition to
  `false` in a production build, which then carries no fixture code or data
  (`bundle-budget.test.ts` checks; initial JS 155.4 KB gz, was 164.7 KB).
- **Logs:** Fastify's request lines carry the matched route's pattern, never the raw path, and
  `(unmatched)` for a 404 or the SPA fallback, so repository names in addresses stay out of the
  logs (`packages/log/src/fastify.ts`, `docs/logging.md`).
- **The diff** (H4-3, [ADR 0034](0034-pull-request-diff-endpoint.md)):
  `GET /api/repos/:owner/:repo/pulls/:number/diff`, the same policy and access check, read from
  GitHub on demand for the mirror's head; `createHttpDiffSource` implements the P6-3
  `DiffDataSource` against it, and the file view explains each refusal (not found, head moved,
  too large, access unavailable, GitHub failed, rate limited, signed out) with fixed text.
- **Dev proxy** (`apps/web/vite.config.ts`, `src/dev-proxy.ts`): Vite forwards `/api` and `/auth`
  (whole path segments) to `ROCKY_DEV_SERVER_URL` (default `http://127.0.0.1:4310`, http only on
  loopback; `off` disables it, as the Playwright suites do) with Host and Origin unchanged and
  no `X-Forwarded-*`. With `ROCKY_PUBLIC_URL=http://127.0.0.1:5173` the session cookie (non-Secure,
  unprefixed: the existing loopback-http development exception, refused in production) and the
  CSRF Origin check work unchanged; the server needs no new allowance. `vite preview` has no
  proxy. Runbook: `docs/runbooks/review-a-real-pr.md`.

## Consequences

- Later P6 tasks fill `MainContent` and `RightPanelContent` and extend `ShellData`; the frame,
  theme and drawers stay.
- Baselines are rendered on macOS Chromium. `pnpm test:e2e` is not in CI yet; adding it needs
  Linux baselines (or a pinned container) and a browser install step.
- The bundle includes Zod and the schema package for client-side validation (about 116 KB gz
  total today, within the P6-8 budget).
