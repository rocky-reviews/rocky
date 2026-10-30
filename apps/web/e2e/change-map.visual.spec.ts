import { expect, type Page, test } from "./test.js";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MODES, settle, WIDTHS } from "./support.js";
import { openBriefing, STATE_PULLS } from "./briefing-support.js";

/**
 * P5-3 acceptance pictures at 375/1024/1440 px x light/dark: the change map with a card and
 * then a finding badge focused from the keyboard (the focus ring), and the file a badge opens,
 * focused on the finding's line. Baselines in e2e/__screenshots__/, copies in
 * artifacts/screenshots/P5-3/. The briefing's own pictures (brief-*) show the map at rest.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P5-3");

const mapSection = (page: Page) => page.locator("section", { has: page.locator(".map-scroll") });

const shoot = async (page: Page, name: string, target = page.locator("html")) => {
  await expect(target).toHaveScreenshot(`${name}.png`);
  await mkdir(OUT, { recursive: true });
  await target.screenshot({ path: join(OUT, `${name}.png`) });
};

for (const size of WIDTHS) {
  for (const mode of MODES) {
    const suffix = `${size.width}-${mode}`;

    test.describe(suffix, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openBriefing(page, STATE_PULLS.main);
        await settle(page);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      });

      test(`map-focus-card-${suffix}`, async ({ page }) => {
        const card = page.locator('.map-scroll [data-node="auth"]');
        // Reached by Tab from the previous badge, so the ring is the keyboard's (:focus-visible).
        await page.locator('.map-scroll [data-findings="F2 F7"]').focus();
        await page.keyboard.press("Tab");
        await expect(card).toBeFocused();
        await shoot(page, `map-focus-card-${suffix}`, mapSection(page));
      });

      test(`map-focus-badge-${suffix}`, async ({ page }) => {
        await page.locator('.map-scroll [data-node="auth"]').focus();
        await page.keyboard.press("Tab");
        await expect(page.locator('.map-scroll [data-findings="F1 F3 F8"]')).toBeFocused();
        await shoot(page, `map-focus-badge-${suffix}`, mapSection(page));
      });

      test(`file-at-finding-${suffix}`, async ({ page }) => {
        await page.locator('.map-scroll [data-findings="F1 F3 F8"]').focus();
        await page.keyboard.press("Enter");
        await expect(page.locator('#main .diff button[data-line="28"]')).toBeFocused();
        await shoot(page, `file-at-finding-${suffix}`);
      });
    });
  }
}
