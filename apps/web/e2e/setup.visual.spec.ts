import { expect, type Page, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openSetup, SETUP_FIXTURES } from "./setup-support.js";
import { MODES, settle, WIDTHS } from "./support.js";

/**
 * P10-2 acceptance (screenshots): the setup wizard at 375/1024/1440 px x light/dark, at each
 * moment of a fresh install (fresh, app created, installed, done), with the usual failures, and
 * after finishing. Baselines in e2e/__screenshots__/, copies for the PR in
 * artifacts/screenshots/P10-2/. The POC has no setup page: these follow its shell, tokens, cards,
 * pills and buttons.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P10-2");

type State = {
  id: string;
  open: (page: Page) => Promise<unknown>;
  run?: (page: Page) => Promise<void>;
};

const STATES: State[] = [
  { id: "setup-fresh", open: (page) => openSetup(page, SETUP_FIXTURES.fresh) },
  { id: "setup-created", open: (page) => openSetup(page, SETUP_FIXTURES.created) },
  { id: "setup-not-installed", open: (page) => openSetup(page, SETUP_FIXTURES["not-installed"]) },
  { id: "setup-installed", open: (page) => openSetup(page, SETUP_FIXTURES.installed) },
  { id: "setup-accounts", open: (page) => openSetup(page, SETUP_FIXTURES.accounts) },
  { id: "setup-done", open: (page) => openSetup(page, SETUP_FIXTURES.done) },
  { id: "setup-failures", open: (page) => openSetup(page, SETUP_FIXTURES.failures) },
  { id: "setup-invalid-llm", open: (page) => openSetup(page, SETUP_FIXTURES["invalid-llm"]) },
  {
    id: "setup-testing",
    open: (page) => openSetup(page, SETUP_FIXTURES.fresh, { holdLlmTest: true }),
    run: async (page) => {
      await page.getByRole("button", { name: "Run the test call" }).click();
      await expect(page.getByRole("button", { name: "Testing…" })).toBeVisible();
    },
  },
  {
    id: "setup-too-soon",
    open: (page) => openSetup(page, SETUP_FIXTURES.created, { llmTestStatus: 429 }),
    run: async (page) => {
      await page.getByRole("button", { name: "Test again" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    },
  },
  {
    id: "setup-finish-failed",
    open: (page) => openSetup(page, SETUP_FIXTURES.done, { finishStatus: 500 }),
    run: async (page) => {
      await page.getByRole("button", { name: "Finish setup" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    },
  },
  {
    id: "setup-check-failed",
    open: async (page) => {
      const api = await openSetup(page, SETUP_FIXTURES.installed);
      api.setStatus(500);
    },
    run: async (page) => {
      await page.getByRole("button", { name: "Check again" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    },
  },
  {
    id: "setup-finished",
    open: (page) => openSetup(page, SETUP_FIXTURES.fresh),
    run: async (page) => {
      await page.getByRole("button", { name: "Finish setup" }).click();
      await expect(page.getByText("Setup is closed.")).toBeVisible();
    },
  },
  { id: "setup-no-session", open: (page) => openSetup(page, 403) },
  { id: "setup-closed", open: (page) => openSetup(page, 404) },
  { id: "setup-load-failed", open: (page) => openSetup(page, 500) },
];

for (const state of STATES) {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await state.open(page);
        await settle(page);
        await state.run?.(page);
        await page.mouse.move(0, 0);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
        await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
        await mkdir(OUT, { recursive: true });
        await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
      });
    }
  }
}
