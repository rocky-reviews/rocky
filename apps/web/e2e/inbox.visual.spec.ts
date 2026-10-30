import { expect, type Page, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openInbox, openInboxApi, numbered } from "./inbox-support.js";
import { MODES, settle, WIDTHS } from "./support.js";

/**
 * P6-7 acceptance (screenshots): the inbox at 375/1024/1440 px x light/dark, with the batch
 * selected, with its confirmation open, after the batch was approved, and filtered to nothing.
 * Baselines in e2e/__screenshots__/, copies for the PR in artifacts/screenshots/P6-7/. The POC
 * has no inbox: these follow its shell, tokens and card style.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P6-7");

type State = {
  id: string;
  api?: boolean;
  /** A modal's backdrop covers the viewport only, so dialog states are not full-page. */
  dialog?: boolean;
  answer?: Parameters<typeof openInboxApi>[1];
  run: (page: Page) => Promise<void>;
};

const safe = (page: Page) => page.getByRole("region", { name: /Safe to bulk-approve/ });

const STATES: State[] = [
  { id: "inbox", run: async () => {} },
  {
    id: "inbox-selected",
    run: async (page) => {
      await safe(page)
        .getByRole("checkbox", { name: numbered(41) })
        .check();
      await safe(page)
        .getByRole("checkbox", { name: numbered(309) })
        .check();
    },
  },
  {
    id: "inbox-confirm",
    dialog: true,
    run: async (page) => {
      await safe(page).getByRole("button", { name: "Select all 3" }).click();
      await page.getByRole("button", { name: "Approve 3 selected…" }).click();
    },
  },
  {
    id: "inbox-approved",
    api: true,
    dialog: true,
    run: async (page) => {
      await safe(page)
        .getByRole("checkbox", { name: numbered(41) })
        .check();
      await safe(page)
        .getByRole("checkbox", { name: numbered(309) })
        .check();
      await page.getByRole("button", { name: "Approve 2 selected…" }).click();
      await page.getByRole("button", { name: "Approve 2 pull requests" }).click();
      await expect(page.getByRole("dialog")).toContainText("Approved 2 pull requests");
    },
  },
  {
    id: "inbox-refused",
    api: true,
    dialog: true,
    answer: (body) => ({
      status: 409,
      body: {
        error: "batch_refused",
        refusals: [{ id: body.pullRequests[0]?.id ?? "", reason: "head_moved" }],
      },
    }),
    run: async (page) => {
      await safe(page).getByRole("button", { name: "Select all 3" }).click();
      await page.getByRole("button", { name: "Approve 3 selected…" }).click();
      await page.getByRole("button", { name: "Approve 3 pull requests" }).click();
      await expect(page.getByRole("dialog")).toContainText("Nothing was approved");
    },
  },
  {
    id: "inbox-after-approval",
    api: true,
    run: async (page) => {
      await safe(page)
        .getByRole("checkbox", { name: numbered(41) })
        .check();
      await page.getByRole("button", { name: "Approve 1 selected…" }).click();
      await page.getByRole("button", { name: "Approve 1 pull request" }).click();
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.getByRole("status")).toContainText("Approved 1 pull request");
      await page.mouse.move(0, 0);
    },
  },
  {
    id: "inbox-filtered-empty",
    run: async (page) => {
      await page.getByRole("searchbox", { name: "Search" }).fill("nothing matches this");
    },
  },
];

for (const state of STATES) {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        if (state.api === true) await openInboxApi(page, state.answer);
        else await openInbox(page);
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
