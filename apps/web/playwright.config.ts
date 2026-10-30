import { defineConfig, devices } from "@playwright/test";

/**
 * P6-1: Playwright for the web app. `visual` takes the screenshots (baselines in
 * e2e/__screenshots__/, copies for the PR in artifacts/screenshots/<task>/); `e2e` runs axe,
 * the keyboard paths and the theme checks (and the P6-8 axe sweep, a11y.e2e.spec.ts); `perf`
 * records the diff scroll trace (P6-3) and the LCP budget (P6-8, ADR 0032). Data
 * is the pr-847 fixture (and the generated large diff), so runs are repeatable.
 * Run: pnpm test:e2e (pnpm test:e2e --update-snapshots to accept a reviewed change).
 */
/** Ports can be moved (`E2E_PORT`, `E2E_PERF_PORT`) when parallel worktrees run the suite. */
const PORT = Number(process.env.E2E_PORT ?? 5199);
/** P6-3: the production build, served for the performance trace (dev React is far slower). */
const PERF_PORT = Number(process.env.E2E_PERF_PORT ?? 5198);
const PERF_DIST = "../../test-results/web-dist";

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  outputDir: "../../test-results/web",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  expect: {
    // Tight enough that a moved count or pill fails; antialiasing noise stays well below it.
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled" },
  },
  projects: [
    { name: "visual", testMatch: /\.visual\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
    { name: "e2e", testMatch: /\.e2e\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
    // P6-3: the scroll performance trace runs after the others, alone, so they don't share CPU,
    // on the production build and without Playwright's own tracing. P6-8: the LCP budget runs
    // here too; one worker, so the two measurements never share the CPU either.
    {
      name: "perf",
      testMatch: /\.perf\.spec\.ts$/,
      workers: 1,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${PERF_PORT}`,
        trace: "off",
      },
      dependencies: ["visual", "e2e"],
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite build --outDir ${PERF_DIST} --emptyOutDir && pnpm exec vite preview --outDir ${PERF_DIST} --port ${PERF_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PERF_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
