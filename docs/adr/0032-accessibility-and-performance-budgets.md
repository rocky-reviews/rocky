# ADR 0032: Accessibility and performance budgets for the web app

- **Status:** Accepted
- **Date:** 2026-10-30
- **Task:** P6-8
- **Builds on:** [ADR 0019](0019-web-app-shell.md) (shell, Playwright suites),
  [ADR 0023](0023-diff-viewer.md) (perf project), [ADR 0025](0025-security-headers-and-rate-limits.md)
  (production cache headers), [ADR 0028](0028-change-map-click-through.md) (map badges)

## Context

P6-8 sets three budgets for the web app: no serious accessibility issue, a Largest Contentful
Paint under 1.5 s on the PR page with cached data, and under 300 KB of gzipped JavaScript before
the first render. Each feature suite already ran axe on its own states; nothing measured paint
time or bundle size, and nothing failed a change that broke a budget elsewhere.

## Decision

Each budget is a test that fails, not a number measured once.

1. **Bundle (`apps/web/src/bundle-budget.test.ts`, in `pnpm verify` and so in CI).** The test
   builds the app for production (with `NODE_ENV=production`: Vitest's `test` would build React's
   development bundles), reads Vite's manifest, and gzips (zlib level 9) the entry chunk with its
   static imports, transitively, plus the classic scripts `index.html` names (`theme-init.js`).
   Chunks reached only through `import()` are not initial. Budget: 300 KB (`INITIAL_JS_BUDGET_GZ`).
   If a route is ever split into a chunk that the entry imports dynamically at startup, that chunk
   is initial too and must be added to the count. Numbers: `artifacts/perf/P6-8/bundle.json`.
2. **Accessibility (`apps/web/e2e/a11y.e2e.spec.ts`, `pnpm test:a11y`, CI job "axe sweep").**
   One sweep over every page and state at 375 / 1024 / 1440 px × light / dark: the PR page
   (briefing with the change map, a focused badge, the files and review drawers where they exist,
   the keyboard help), every briefing state (no analysis, running, awaiting approval, failed,
   superseded, re-analysing, out of date, map or briefing unavailable), the diff (own comment and
   composer, accepted draft and toast, dismiss form, editor, noise file and its raw diff, the
   5,000-line fixture), Finish review (open, submitting, submitted with the status pill) and the
   inbox (list, selection, approve dialog, nothing matching). The rule
   set is axe's default (WCAG 2.0/2.1/2.2 A and AA, best practices) plus `target-size` (WCAG 2.2
   2.5.8), which axe ships switched off; any "serious" or "critical" finding fails and is
   reported with its state. axe skips SVG targets, so the map badges' 24 px target is measured
   in the same file. The feature suites keep their own axe checks next to their behaviour. New
   pages and states (Ask, settings) join the sweep.
3. **LCP (`apps/web/e2e/lcp.perf.spec.ts`, `pnpm test:lcp`, part of `pnpm test:e2e`).** On the
   production build, in the `perf` project (one worker, after the other projects, so nothing
   shares the CPU), the PR page for pr-847 is loaded once to fill the cache, then five times
   measured with a `PerformanceObserver` for `largest-contentful-paint` installed before the
   page's scripts, at 1440 and 375 px. Profile: CPU throttled 4x (the mid-range laptop of P6-3,
   `PERF_CPU_THROTTLE`), 40 ms round trip, 10 Mbit/s down, 5 Mbit/s up. Cache: the production
   server's headers (`/assets/` immutable, the page revalidated), applied over `vite preview`'s
   `no-cache` through the DevTools protocol; the drafts API is answered the same way, because
   `page.route` turns Chrome's HTTP cache off. The test asserts that no script or stylesheet body
   is downloaded on a measured load, and that the LCP element is inside the briefing card (not
   the "Loading…" line or an error). "Cached data": the PR's analysis is in the page (fixture
   source) and the drafts API answers at once; when the PR page reads its data from the server,
   that request is answered here as the drafts one is. Fails if the median of the five runs is
   1.5 s or more, or any run is above 1.8 s. Numbers: `artifacts/perf/P6-8/lcp.json`.

4. **Where they run.** Each Playwright web server starts only for the projects that use it
   (`apps/web/playwright.config.ts` reads `--project`), so the CI axe step does not build the
   app and `pnpm test:lcp` does not start the dev server.

### LCP in CI, and the plan to tighten it

The 4x-throttled profile describes a laptop, and its threshold depends on the CPU it runs on,
as P6-3's frame rate does. The CI job "axe sweep and LCP" therefore runs `pnpm test:lcp` with
the CPU unthrottled (`PERF_CPU_THROTTLE=1`) and the same 1.5 s budget (`LCP_BUDGET_MS`), the same
network and warm cache: on the runner that is a gross-regression check (today's page paints in
a few hundred milliseconds even on slow machines), not the acceptance profile. `lcp.json` is
uploaded as a build artifact on every run, pass or fail. Once a few weeks of runner numbers
exist, CI moves to a throttled profile (2x, then 4x if the median leaves room) with the 1.5 s
budget; the acceptance profile (4x) keeps running locally with `pnpm test:e2e` and
`pnpm test:lcp`.

## Measured (2026-10-30, Apple Silicon, Chromium 1248)

- Initial JS: 164.7 KB gzipped (one 536.8 KB chunk, with P6-6's Finish review, plus the 0.8 KB
  theme script); no split was needed. React DOM and Zod are most of it.
- LCP: median 192 ms at 1440 px and 188 ms at 375 px (4x CPU), slowest run 216 ms; unthrottled
  (the CI profile) 148 and 144 ms on this machine; the LCP element
  is the briefing summary.
- axe: 0 serious or critical issues in every state above; the cheap follow-ups from earlier tasks
  were fixed with it (badge target size and digit contrast, coverage bar without a range, key
  hints on touch screens, a hint that the map scrolls sideways), and the sweep found one issue
  once the Finish review modal landed: the "Changes requested" pill (`--crit` on `--crit-bg`,
  3.9:1 in light mode), now `--text` there (`--crit-tint-text`; dark keeps `--crit`).

## Consequences

- A change that adds a heavy dependency to the first render, an inaccessible state, or a slow
  first paint fails before review. The bundle budget runs on every `pnpm verify`; the build adds
  about a second.
- The CI job installs Chromium on Linux; the screenshot baselines stay macOS-only and do not
  run there (P6-1 follow-up).
- Text on a solid severity fill has its own tokens (`--on-crit|high|med|low`), each one of the
  POC's text or surface colours per mode; `scripts/design-tokens.test.ts` checks they reach
  4.5:1 on their fill in both modes; `--crit-tint-text` likewise on `--crit-bg`.
