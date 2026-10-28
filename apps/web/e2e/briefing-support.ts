import type { Page } from "@playwright/test";
import { FIXTURE_NOW } from "./support.js";

/** The fixture PRs (apps/web/src/briefing/fixtures.ts), by the state they show. */
export const STATE_PULLS = {
  main: 847,
  briefingUnavailable: 848,
  graphUnavailable: 849,
  none: 850,
  running: 851,
  awaitingApproval: 852,
  failed: 853,
  superseded: 854,
  reanalysing: 855,
  outOfDate: 856,
} as const;

/** Opens the shell on a fixture PR with a fixed clock and no saved theme choice. */
export const openBriefing = async (page: Page, pr: number): Promise<void> => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(`/?pr=${pr}`);
  await page.locator("#briefing-title").waitFor();
};

/** Lets the main column grow to its content, so a full-page screenshot shows all of it. */
export const unclipMain = async (page: Page): Promise<void> => {
  await page.addStyleTag({
    content: ".app{height:auto!important}.col{overflow:visible!important}",
  });
};
