import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MODES, settle, WIDTHS } from "./support.js";
import { openBriefing, STATE_PULLS, unclipMain } from "./briefing-support.js";

/**
 * P6-2 acceptance: the briefing and each of its empty and failed states at 375/1024/1440 px x
 * light/dark. States with a document are taken at full length (the main column unclipped), so
 * the change map, path, memory and checks are all in the picture; the others at viewport size.
 * Baselines in e2e/__screenshots__/, copies in artifacts/screenshots/P6-2/.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P6-2");

const STATES: { id: string; pr: number; full: boolean }[] = [
  { id: "brief", pr: STATE_PULLS.main, full: true },
  { id: "brief-by-rocky", pr: STATE_PULLS.briefingUnavailable, full: true },
  { id: "brief-map-unavailable", pr: STATE_PULLS.graphUnavailable, full: true },
  { id: "brief-none", pr: STATE_PULLS.none, full: false },
  { id: "brief-running", pr: STATE_PULLS.running, full: false },
  { id: "brief-awaiting-approval", pr: STATE_PULLS.awaitingApproval, full: false },
  { id: "brief-failed", pr: STATE_PULLS.failed, full: false },
  { id: "brief-superseded", pr: STATE_PULLS.superseded, full: false },
  { id: "brief-reanalysing", pr: STATE_PULLS.reanalysing, full: false },
  { id: "brief-out-of-date", pr: STATE_PULLS.outOfDate, full: false },
];

for (const state of STATES) {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openBriefing(page, state.pr);
        await settle(page);
        if (state.full) await unclipMain(page);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

        await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: state.full });
        await mkdir(OUT, { recursive: true });
        await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: state.full });
      });
    }
  }
}
