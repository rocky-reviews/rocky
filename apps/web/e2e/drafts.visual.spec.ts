import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openFile } from "./diff-support.js";
import { MODES, openShell, settle, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";
import type { ReviewApi } from "./review-api.js";

/**
 * P6-4: the AI drafts at 375/1024/1440 px x light/dark, against the POC's draft states
 * (docs/design/poc/02-file-critical-*, 03-draft-dismiss-*, 04-draft-accepted-*, 05-draft-edit-*).
 * Baselines in e2e/__screenshots__/, copies in artifacts/screenshots/P6-4/, and `compare/` puts
 * the POC and the app side by side.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P6-4");
const POC = join(ROOT, "docs/design/poc");
const FILE = "src/auth/invitations.ts";

type State = {
  id: string;
  poc: string;
  /** Keep the toast in the picture (others hide it: it times out). */
  toast?: boolean;
  /** Decisions already stored when the page loads (as after an earlier visit). */
  stored?: (api: ReviewApi) => void;
  run: (page: Page) => Promise<void>;
};

const card = (page: Page, id = "F1") => page.locator(`[data-finding="${id}"]`);

/** The file, scrolled so the F1 draft card sits in view (it is virtualised). */
const atF1 = async (page: Page) => {
  await page.locator("#review-panel .tally").waitFor({ state: "attached" });
  await openFile(page, FILE);
  for (let i = 0; i < 30 && (await card(page).count()) === 0; i++) {
    await page.locator("#main").evaluate((main) => main.scrollBy({ top: 400 }));
  }
  // Scroll the main column only (scrollIntoView would also move the page under the top bar).
  await card(page).evaluate((el) => {
    const main = el.closest("#main");
    if (main === null) return;
    const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
    main.scrollTop += top - 140;
  });
  await page.mouse.move(0, 0);
};

const panelStored = (api: ReviewApi) => {
  api.set("F1", { state: "accepted", edited: false, body: "x" });
  api.set("F2", { state: "dismissed", reason: "handled_elsewhere" });
  api.set("F6", { state: "dismissed", reason: "intentional" });
};

const panelOpen = async (page: Page) => {
  await page.locator("#review-panel .tally").waitFor({ state: "attached" });
  await openFile(page, FILE);
  await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
  await page.getByRole("textbox", { name: "Your comment on line 10" }).fill("TTL from config?");
  await page.getByRole("button", { name: "Add comment" }).click();
  if ((page.viewportSize()?.width ?? 1440) <= 1180)
    await page.getByRole("button", { name: "Review panel" }).click();
  await page.mouse.move(0, 0);
};

const STATES: State[] = [
  { id: "drafts-card", poc: "02-file-critical", run: atF1 },
  {
    id: "drafts-dismiss",
    poc: "03-draft-dismiss",
    run: async (page) => {
      await atF1(page);
      await card(page).getByRole("button", { name: "Dismiss" }).click();
      await page.mouse.move(0, 0);
    },
  },
  {
    id: "drafts-accepted",
    poc: "04-draft-accepted",
    toast: true,
    run: async (page) => {
      await atF1(page);
      await card(page).getByRole("button", { name: "Accept", exact: true }).click();
      await page.locator(".toast").waitFor();
      await page.mouse.move(0, 0);
    },
  },
  {
    id: "drafts-edit",
    poc: "05-draft-edit",
    run: async (page) => {
      await atF1(page);
      await card(page).getByRole("button", { name: "Edit" }).click();
      await page
        .getByRole("textbox", { name: "Your comment, edited from the AI draft" })
        .fill("`requestedRole` lets the invitee pick their role. Always use `invite.role`.");
    },
  },
  {
    id: "drafts-dismissed",
    poc: "03-draft-dismiss",
    stored: (api) =>
      api.set("F3", { state: "accepted", edited: true, body: "Check `acceptedAt` first." }),
    run: async (page) => {
      await atF1(page);
      await card(page).getByRole("button", { name: "Dismiss" }).click();
      await card(page).getByRole("button", { name: "Intentional" }).click();
      await page.mouse.move(0, 0);
    },
  },
  {
    // The Review panel with decided drafts and an own comment; a drawer below 1180 px.
    id: "drafts-panel",
    poc: "04-draft-accepted",
    stored: panelStored,
    run: panelOpen,
  },
  {
    // The same panel scrolled to its end: the dismissal note and "Your comments".
    id: "drafts-panel-end",
    poc: "04-draft-accepted",
    stored: panelStored,
    run: async (page) => {
      await panelOpen(page);
      await page.locator("#review-panel .learn").evaluate((el) => {
        for (let box = el.parentElement; box !== null; box = box.parentElement) {
          if (
            box.scrollHeight > box.clientHeight + 1 &&
            getComputedStyle(box).overflowY !== "visible"
          ) {
            box.scrollTop = box.scrollHeight;
            return;
          }
        }
      });
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
        if (state.toast !== true)
          await page.addStyleTag({ content: ".toast-region{display:none!important}" });
        await state.run(page);
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
