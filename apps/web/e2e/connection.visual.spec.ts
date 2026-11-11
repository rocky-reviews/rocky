import { expect, type Page, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  INBOX_SYNC,
  openConnection,
  openTokenInbox,
  SETUP_FIXTURES,
} from "./connection-support.js";
import { openSetup } from "./setup-support.js";
import { FIXTURE_NOW, MODES, settle, WIDTHS } from "./support.js";
import { CONNECTION_EMPTY } from "../src/connection/fixtures.js";

/**
 * P10-4 acceptance (screenshots): token mode at 375/1024/1440 px x light/dark: the connection
 * page (and with a classic token and nothing followed, and with the picker open), the wizard's
 * token step before and after a token is saved, the App-mode wizard with the token alternative
 * open, and the inbox's sync bar while syncing and after a rate limit. Baselines in
 * e2e/__screenshots__/, copies for the PR in artifacts/screenshots/P10-4/. The POC has none of
 * these: they follow its shell, tokens, cards, pills and buttons.
 */

test.use({ timezoneId: "UTC", locale: "en-GB" });

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P10-4");

type State = {
  id: string;
  /** A modal's backdrop covers the viewport only, so dialog states are not full-page. */
  dialog?: boolean;
  open: (page: Page) => Promise<unknown>;
  run?: (page: Page) => Promise<void>;
};

const STATES: State[] = [
  { id: "connection", open: (page) => openConnection(page) },
  { id: "connection-classic-empty", open: (page) => openConnection(page, CONNECTION_EMPTY) },
  {
    id: "connection-picker",
    dialog: true,
    open: (page) => openConnection(page),
    run: async (page) => {
      await page.getByRole("button", { name: "Add repository" }).click();
      await expect(page.getByText("Following").first()).toBeVisible();
    },
  },
  {
    id: "setup-token-required",
    open: (page) => openSetup(page, SETUP_FIXTURES["token-required"]),
  },
  {
    id: "setup-token-connected",
    open: (page) => openSetup(page, SETUP_FIXTURES["token-connected"]),
  },
  {
    id: "setup-app-token-alternative",
    open: (page) => openSetup(page, SETUP_FIXTURES.fresh),
    run: async (page) => {
      await page.locator(".setup-alt summary").click();
      await expect(page.getByText("Reviews are posted as you")).toBeVisible();
    },
  },
  {
    id: "inbox-sync-running",
    open: (page) => openTokenInbox(page, INBOX_SYNC.running),
  },
  {
    id: "inbox-sync-rate-limited",
    open: (page) => openTokenInbox(page, INBOX_SYNC.rateLimited),
  },
];

for (const state of STATES) {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        // "Saved N ago" is relative: the wizard's screenshots need the fixture clock too.
        await page.clock.setFixedTime(FIXTURE_NOW);
        await state.open(page);
        await settle(page);
        await state.run?.(page);
        await page.mouse.move(0, 0);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
        const fullPage = state.dialog !== true;
        await expect(page).toHaveScreenshot(`${name}.png`, { fullPage });
        await mkdir(OUT, { recursive: true });
        await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
      });
    }
  }
}
