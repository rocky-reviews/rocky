import type { Page } from "@playwright/test";

export const WIDTHS = [
  { width: 375, height: 812 },
  { width: 1024, height: 900 },
  { width: 1440, height: 900 },
] as const;
export const MODES = ["light", "dark"] as const;
export type Mode = (typeof MODES)[number];

/** 12 minutes after the fixture's last update, as in the POC ("updated 12 min ago"). */
export const FIXTURE_NOW = new Date("2026-10-25T12:12:00.000Z");

/**
 * Opens the shell for pr-847 with a fixed clock and no saved theme choice. H4-2: the fixture
 * needs its explicit switch (a real PR address reads the server; see real-pr-support.ts).
 */
export const openShell = async (page: Page): Promise<void> => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/?fixture=pr-847");
  await page.locator("header.topbar").waitFor();
};

/** Hides the caret and pauses transitions so screenshots are stable. */
export const settle = async (page: Page): Promise<void> => {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}",
  });
};
