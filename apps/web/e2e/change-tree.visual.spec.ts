import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openBriefing, STATE_PULLS } from "./briefing-support.js";
import { MODES, openShell, settle, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * H4-12: the change tree modal at 375/1024/1440 px x light/dark, against the approved mockup
 * ("A · Compact tree"; the POC has no tree). `change-tree`: opened with `t` on the briefing, as
 * it starts (the riskiest folder open down to its files to read). `change-tree-file`: opened
 * on a file, which it highlights and reveals. `change-tree-unanalysed`: a PR with a file the
 * AI could not analyse, its own group above Ignored. The pointer is moved off before each picture, so
 * no hover is caught. Baselines in e2e/__screenshots__/, copies in artifacts/screenshots/H4-12/.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/H4-12");

const dialog = (page: Page) => page.getByRole("dialog", { name: "Change tree" });
const ready = (page: Page) => page.locator("#review-panel .tally").waitFor({ state: "attached" });

const STATES: { id: string; pr?: number; run: (page: Page) => Promise<void> }[] = [
  {
    id: "change-tree",
    run: async (page) => {
      await page.keyboard.press("t");
      await dialog(page).waitFor();
    },
  },
  {
    id: "change-tree-file",
    run: async (page) => {
      await page.keyboard.press("k");
      await page.keyboard.press("k");
      await expect(page.locator("#file-title")).toHaveText("src/api/routes/invitations.ts");
      await page.keyboard.press("t");
      await dialog(page).waitFor();
      await dialog(page)
        .getByRole("button", { name: /^Ignored/ })
        .press("Enter");
    },
  },
  {
    id: "change-tree-unanalysed",
    pr: STATE_PULLS.graphUnavailable,
    run: async (page) => {
      await page.keyboard.press("t");
      await dialog(page).waitFor();
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
        if (state.pr === undefined) await openShell(page);
        else await openBriefing(page, state.pr);
        await settle(page);
        await page.addStyleTag({ content: ".toast-region{display:none!important}" });
        await ready(page);
        await state.run(page);
        await page.mouse.move(0, 0);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

        await expect(page).toHaveScreenshot(`${name}.png`);
        await mkdir(OUT, { recursive: true });
        await page.screenshot({ path: join(OUT, `${name}.png`) });
      });
    }
  }
}
