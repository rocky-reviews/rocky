import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MODES, openShell, settle, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * P6-5: the shortcuts dialog and the keyboard focus states at 375/1024/1440 px x light/dark,
 * against the POC (docs/design/poc/10-shortcuts-*, 02-file-critical-*). Baselines in
 * e2e/__screenshots__/, copies in artifacts/screenshots/P6-5/, `compare/` side by side.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P6-5");
const POC = join(ROOT, "docs/design/poc");

const ready = (page: Page) => page.locator("#review-panel .tally").waitFor({ state: "attached" });

/** Presses a key and waits a frame for the page to render the result. */
const press = async (page: Page, key: string) => {
  await page.keyboard.press(key);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
};

type State = { id: string; poc: string; run: (page: Page) => Promise<void> };

const STATES: State[] = [
  {
    // "?" on the briefing: the dialog over the page.
    id: "keys-help",
    poc: "10-shortcuts",
    run: async (page) => {
      await ready(page);
      await press(page, "?");
      await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    },
  },
  {
    // The dialog with single-key shortcuts turned off.
    id: "keys-help-off",
    poc: "10-shortcuts",
    run: async (page) => {
      await ready(page);
      await press(page, "?");
      await page.getByRole("switch", { name: "Single-key shortcuts" }).press("Space");
    },
  },
  {
    // k then n: the riskiest file, its critical draft focused, with the a/e/d hints.
    id: "keys-draft-focus",
    poc: "02-file-critical",
    run: async (page) => {
      await ready(page);
      await press(page, "k");
      await page.locator(".diff .ln").first().waitFor();
      await press(page, "n");
      await expect(page.locator('[data-finding="F1"]')).toBeFocused();
      // The card at the top of the main column, as a jump leaves it on a short screen.
      await page.locator('[data-finding="F1"]').evaluate((el) => {
        const main = el.closest("#main");
        if (main === null) return;
        main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 140;
      });
    },
  },
  {
    // Tab onto the Accept button from the focused draft: the button's focus ring and hint.
    id: "keys-accept-focus",
    poc: "02-file-critical",
    run: async (page) => {
      await ready(page);
      await press(page, "k");
      await page.locator(".diff .ln").first().waitFor();
      await press(page, "n");
      await page.locator('[data-finding="F1"] [data-role="accept"]').focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.locator('[data-finding="F1"]').evaluate((el) => {
        const main = el.closest("#main");
        if (main === null) return;
        main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 140;
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
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openShell(page);
        await settle(page);
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
