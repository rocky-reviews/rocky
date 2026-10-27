import { defineConfig, devices } from "@playwright/test";

/**
 * P6-1: Playwright for the web app. `visual` takes the screenshots (baselines in
 * e2e/__screenshots__/, copies for the PR in artifacts/screenshots/<task>/); `e2e` runs axe,
 * the keyboard paths and the theme checks. Data is the pr-847 fixture, so runs are repeatable.
 * Run: pnpm test:e2e (pnpm test:e2e --update-snapshots to accept a reviewed change).
 */
const PORT = 5199;

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
    // Font antialiasing differs a little between runs; layout changes are far larger.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" },
  },
  projects: [
    { name: "visual", testMatch: /\.visual\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
    { name: "e2e", testMatch: /\.e2e\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
