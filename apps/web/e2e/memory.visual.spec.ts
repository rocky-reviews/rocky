import { expect, type Page, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { entryItem, MEMORY_FIXTURE, openMemory, openMemoryApi } from "./memory-support.js";
import { MODES, settle, WIDTHS } from "./support.js";

/**
 * P8-3 acceptance (screenshots): the project memory page at 375/1024/1440 px x light/dark, as an
 * admin and as a member, with earlier versions shown, editing an entry, the delete confirmation,
 * memory switched off for the repository, and a repository with no memory yet. Baselines in
 * e2e/__screenshots__/, copies for the PR in artifacts/screenshots/P8-3/. The POC has no memory
 * page: these follow its shell, tokens, card style, memory mark and modal.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P8-3");

type State = {
  id: string;
  open?: (page: Page) => Promise<unknown>;
  /** A modal's backdrop covers the viewport only, so dialog states are not full-page. */
  dialog?: boolean;
  run: (page: Page) => Promise<void>;
};

const STATES: State[] = [
  { id: "memory", run: async () => {} },
  { id: "memory-member", open: (page) => openMemory(page, { as: "member" }), run: async () => {} },
  {
    id: "memory-history",
    run: async (page) => {
      await page.getByRole("checkbox", { name: /Show earlier versions/ }).check();
      await page.mouse.move(0, 0);
    },
  },
  {
    id: "memory-edit",
    run: async (page) => {
      await entryItem(page, 1).getByRole("button", { name: "Edit" }).click();
      await page.getByRole("textbox", { name: "Text" }).waitFor();
    },
  },
  {
    id: "memory-delete",
    dialog: true,
    run: async (page) => {
      await entryItem(page, 2).getByRole("button", { name: "Delete…" }).click();
      await expect(page.getByRole("dialog")).toContainText("1 earlier version is deleted");
    },
  },
  {
    id: "memory-off",
    run: async (page) => {
      await page.getByRole("switch", { name: /Use project memory/ }).uncheck();
      await expect(page.getByText("Memory is off.")).toBeVisible();
      await page.mouse.move(0, 0);
    },
  },
  {
    id: "memory-empty",
    open: (page) => openMemoryApi(page, { list: { ...MEMORY_FIXTURE, entries: [] } }),
    run: async () => {},
  },
];

for (const state of STATES) {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await (state.open ?? openMemory)(page);
        await settle(page);
        await state.run(page);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
        const fullPage = state.dialog !== true;
        await expect(page).toHaveScreenshot(`${name}.png`, { fullPage });
        await mkdir(OUT, { recursive: true });
        await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
      });
    }
  }
}
