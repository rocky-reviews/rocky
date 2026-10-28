import { expect, type Page, test } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openFile } from "./diff-support.js";
import { MODES, openShell, settle, WIDTHS } from "./support.js";

/**
 * P6-3: the file view at 375/1024/1440 px x light/dark, against the POC's file states
 * (docs/design/poc/02-file-critical-*, 06-own-comment-*, 07-noise-*). Each state is a baseline in
 * e2e/__screenshots__/ and a copy in artifacts/screenshots/P6-3/; `compare/` puts the POC and
 * the app side by side.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P6-3");
const POC = join(ROOT, "docs/design/poc");

type State = { id: string; poc: string; run: (page: Page) => Promise<void> };

const STATES: State[] = [
  {
    id: "file-critical",
    poc: "02-file-critical",
    run: (page) => openFile(page, "src/auth/invitations.ts"),
  },
  {
    id: "file-own-comment",
    poc: "06-own-comment",
    run: async (page) => {
      await openFile(page, "src/auth/invitations.ts");
      await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Your comment on line 10" })
        .fill("Should this TTL come from config?");
      // The composer in view (at 375 px it is below the fold).
      await page.locator(".compose").scrollIntoViewIfNeeded();
    },
  },
  {
    // The end of the file: "Your call" flag, question and critical markers, the footer.
    id: "file-critical-end",
    poc: "02-file-critical",
    run: async (page) => {
      await openFile(page, "src/auth/invitations.ts");
      await page.locator("#main").evaluate((main) => main.scrollTo({ top: main.scrollHeight }));
    },
  },
  {
    // A modified file with old/new numbers and a pending own comment with Delete.
    id: "file-pending-comment",
    poc: "06-own-comment",
    run: async (page) => {
      await openFile(page, "src/api/index.ts");
      await page.getByRole("button", { name: "Comment on line 4", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Your comment on line 4" })
        .fill("Order matters here?");
      await page.getByRole("button", { name: "Add comment" }).click();
      await page.mouse.move(0, 0);
    },
  },
  {
    // The noise file's raw diff: removed lines with their old numbers.
    id: "file-noise-raw",
    poc: "07-noise",
    run: async (page) => {
      await openFile(page, "pnpm-lock.yaml", { noise: true });
      await page.getByRole("button", { name: /Show raw diff/ }).click();
      await page.locator(".diff .ln.del").first().scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
    },
  },
  {
    id: "file-noise",
    poc: "07-noise",
    run: (page) => openFile(page, "pnpm-lock.yaml", { noise: true }),
  },
];

/** The POC and the app next to each other, labelled, at the same viewport size. */
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
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openShell(page);
        await settle(page);
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
