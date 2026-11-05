import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openBriefing, STATE_PULLS } from "./briefing-support.js";
import { MODES, settle, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * H4-6 acceptance pictures at 375/1024/1440 px x light/dark: each change map style (Live
 * traffic; the walkthrough at its second stop; the flow at its second step), the fallback
 * notice for a document without a walkthrough, and the setting in the settings dialog.
 * Animations are stopped (`settle`), so the dots sit at their start. Baselines in
 * e2e/__screenshots__/, copies in artifacts/screenshots/H4-6/.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/H4-6");

const section = (page: Page) => page.locator("section", { has: page.locator("#change-map-title") });

const shoot = async (page: Page, name: string, target = section(page)) => {
  await expect(target).toHaveScreenshot(`${name}.png`);
  await mkdir(OUT, { recursive: true });
  await target.screenshot({ path: join(OUT, `${name}.png`) });
};

const open = async (page: Page, style: string, pr: number = STATE_PULLS.main) => {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: "rocky-map-style",
    value: style,
  });
  await openBriefing(page, pr);
  await settle(page);
};

for (const size of WIDTHS) {
  for (const mode of MODES) {
    const suffix = `${size.width}-${mode}`;

    test.describe(suffix, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
      });

      test(`map-live-${suffix}`, async ({ page }) => {
        await open(page, "live");
        await shoot(page, `map-live-${suffix}`);
      });

      test(`map-walkthrough-${suffix}`, async ({ page }) => {
        await open(page, "walkthrough");
        await page.getByRole("button", { name: "Next stop" }).click();
        await expect(section(page)).toContainText("Stop 2 of 3");
        await shoot(page, `map-walkthrough-${suffix}`);
      });

      test(`map-flows-${suffix}`, async ({ page }) => {
        await open(page, "flows");
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(section(page).locator(".seq-now")).toContainText("Step 2 of 4");
        await shoot(page, `map-flows-${suffix}`);
      });

      test(`map-fallback-${suffix}`, async ({ page }) => {
        await open(page, "walkthrough", STATE_PULLS.noTour);
        await expect(section(page).getByRole("note")).toBeVisible();
        await shoot(page, `map-fallback-${suffix}`);
      });

      test(`map-style-setting-${suffix}`, async ({ page }) => {
        await open(page, "live");
        await page.getByRole("button", { name: /^Map style: / }).click();
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await dialog.getByRole("radio", { name: /Guided walkthrough/ }).focus();
        await page.keyboard.press("ArrowUp");
        await expect(dialog.getByRole("radio", { name: /Live traffic/ })).toBeFocused();
        await shoot(page, `map-style-setting-${suffix}`, dialog);
      });
    });
  }
}
