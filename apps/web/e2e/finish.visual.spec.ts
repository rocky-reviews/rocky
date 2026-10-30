import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openFile } from "./diff-support.js";
import type { ReviewApi } from "./review-api.js";
import { MODES, openShell, settle, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * P6-6: Finish review at 375/1024/1440 px x light/dark, against the POC's finish state
 * (docs/design/poc/09-finish-*): the modal with the warnings, the list and the suggested
 * verdict; the success state; and the page after a review was posted (status pill, posted
 * items read-only). Baselines in e2e/__screenshots__/, copies in artifacts/screenshots/P6-6/,
 * and `compare/` puts the POC and the app side by side.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P6-6");
const POC = join(ROOT, "docs/design/poc");
const FILE = "src/auth/invitations.ts";
const HIGH_RISK = [
  FILE,
  "src/api/routes/invitations.ts",
  "db/migrations/20261020_add_invitations.sql",
  "src/jobs/sendInviteEmail.ts",
];

type State = {
  id: string;
  poc: string;
  stored?: (api: ReviewApi) => void;
  run: (page: Page, api: ReviewApi) => Promise<void>;
};

const dialog = (page: Page) => page.getByRole("dialog", { name: "Finish your review" });
const reviewReady = (page: Page) =>
  page.locator("#review-panel .tally").waitFor({ state: "attached" });

const openFinish = async (page: Page) => {
  await reviewReady(page);
  await page.getByRole("button", { name: /^Finish review/ }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).not.toContainText("Loading what will be posted");
  await expect(dialog(page).getByRole("button", { name: "Submit review" })).toHaveAttribute(
    "data-armed",
    "true",
  );
  await page.mouse.move(0, 0);
};

const STATES: State[] = [
  {
    // The POC's state: F1 accepted, nothing viewed, Request changes suggested.
    id: "finish",
    poc: "09-finish",
    stored: (api) => api.set("F1", { state: "accepted", edited: false, body: "x" }),
    run: openFinish,
  },
  {
    // Everything viewed and decided, two comments to post: Comment suggested.
    id: "finish-covered",
    poc: "09-finish",
    stored: (api) => {
      api.set("F1", { state: "accepted", edited: false, body: "x" });
      api.set("F5", { state: "accepted", edited: true, body: "Add `on delete cascade`." });
      for (const f of ["F2", "F3", "F4", "F6", "F7", "F8", "F9", "F10"])
        api.set(f, { state: "dismissed", reason: "not_an_issue" });
    },
    run: async (page) => {
      await reviewReady(page);
      // Below 760 px the sidebar is a drawer: open it for the checkboxes, then close it.
      const narrow = (page.viewportSize()?.width ?? 1440) <= 760;
      if (narrow) await page.getByRole("button", { name: "Files", exact: true }).click();
      for (const path of HIGH_RISK)
        await page.getByRole("checkbox", { name: `Viewed ${path}` }).check();
      if (narrow) await page.keyboard.press("Escape");
      await openFinish(page);
      await dialog(page).getByRole("button", { name: "Draft a summary from my comments" }).click();
      await page.mouse.move(0, 0);
    },
  },
  {
    // The verdict and footer, scrolled into view (the modal scrolls at phone width).
    id: "finish-verdict",
    poc: "09-finish",
    stored: (api) => api.set("F1", { state: "accepted", edited: false, body: "x" }),
    run: async (page) => {
      await openFinish(page);
      await dialog(page)
        .getByRole("radio", { name: /Request changes/ })
        .focus();
      await page.mouse.move(0, 0);
    },
  },
  {
    // While the request runs: every control disabled, the live status focused.
    id: "finish-sending",
    poc: "09-finish",
    stored: (api) => api.set("F1", { state: "accepted", edited: false, body: "x" }),
    run: async (page, api) => {
      await openFinish(page);
      api.holdSubmits();
      await dialog(page).getByRole("button", { name: "Submit review" }).click();
      await expect(dialog(page).getByRole("button", { name: "Submitting…" })).toBeVisible();
    },
  },
  {
    // GitHub refused: the notice, the items still listed.
    id: "finish-failed",
    poc: "09-finish",
    stored: (api) => api.set("F1", { state: "accepted", edited: false, body: "x" }),
    run: async (page, api) => {
      await openFinish(page);
      api.scriptSubmit({ status: 502, body: { error: "post_failed", reason: "rejected" } });
      await dialog(page).getByRole("button", { name: "Submit review" }).click();
      await expect(dialog(page).getByRole("alert")).toContainText("GitHub rejected");
      await page.mouse.move(0, 0);
    },
  },
  {
    // No answer from GitHub: the review may exist; the attempt shows in flight.
    id: "finish-unknown",
    poc: "09-finish",
    stored: (api) => api.set("F1", { state: "accepted", edited: false, body: "x" }),
    run: async (page, api) => {
      await openFinish(page);
      api.scriptSubmit({ status: 502, body: { error: "post_unknown", submissionId: "x" } });
      api.addInFlight();
      api.markPosted({ findingId: "F1" }, "posting");
      await dialog(page).getByRole("button", { name: "Submit review" }).click();
      await expect(dialog(page).getByRole("alert")).toContainText("may or may not");
      await expect(dialog(page)).toContainText("still being confirmed");
      await page.mouse.move(0, 0);
    },
  },
  {
    // After the click: the pill, the toast, the posted card read-only.
    id: "finish-posted",
    poc: "04-draft-accepted",
    stored: (api) => api.set("F1", { state: "accepted", edited: false, body: "x" }),
    run: async (page) => {
      await openFinish(page);
      await dialog(page).getByRole("button", { name: "Submit review" }).click();
      await expect(dialog(page)).toHaveCount(0);
      await page.locator(".toast").waitFor();
      await openFile(page, FILE);
      for (let i = 0; i < 30 && (await page.locator('[data-finding="F1"]').count()) === 0; i++) {
        await page.locator("#main").evaluate((main) => main.scrollBy({ top: 400 }));
      }
      await page.locator('[data-finding="F1"]').evaluate((el) => {
        const main = el.closest("#main");
        if (main === null) return;
        const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
        main.scrollTop += top - 140;
      });
      await page.mouse.move(0, 0);
    },
  },
];

const sideBySide = async (
  page: Page,
  poc: Buffer,
  app: Buffer,
  size: { width: number; height: number },
  title: string,
) => {
  const img = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
  await page.setViewportSize({ width: size.width * 2 + 40, height: size.height + 60 });
  await page.setContent(`<!doctype html><body style="margin:0;font:14px system-ui">
    <div style="display:flex;gap:16px;padding:12px;align-items:flex-start">
      <figure style="margin:0;flex:1"><figcaption>POC · ${title}</figcaption>
        <img src="${img(poc)}" style="width:100%;outline:1px solid"></figure>
      <figure style="margin:0;flex:1"><figcaption>App · ${title}</figcaption>
        <img src="${img(app)}" style="width:100%;outline:1px solid"></figure>
    </div></body>`);
};

for (const state of STATES) {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page, reviewApi }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        state.stored?.(reviewApi);
        await openShell(page);
        await settle(page);
        if (state.id !== "finish-posted")
          await page.addStyleTag({ content: ".toast-region{display:none!important}" });
        await state.run(page, reviewApi);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

        await expect(page).toHaveScreenshot(`${name}.png`);
        await mkdir(join(OUT, "compare"), { recursive: true });
        const app = await page.screenshot({ path: join(OUT, `${name}.png`) });
        const poc = await readFile(join(POC, `${state.poc}-${size.width}-${mode}.png`));
        await sideBySide(page, poc, app, size, `${size.width} px ${mode}`);
        await page.screenshot({ path: join(OUT, "compare", `${name}.png`), fullPage: true });
      });
    }
  }
}
