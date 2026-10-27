# ADR 0019: Web app stack and the PR page shell

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P6-1

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
   `try/catch`.
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

## Consequences

- Later P6 tasks fill `MainContent` and `RightPanelContent` and extend `ShellData`; the frame,
  theme and drawers stay.
- Baselines are rendered on macOS Chromium. `pnpm test:e2e` is not in CI yet; adding it needs
  Linux baselines (or a pinned container) and a browser install step.
- The bundle includes Zod and the schema package for client-side validation (about 116 KB gz
  total today, within the P6-8 budget).
