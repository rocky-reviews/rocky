import { expect, type Page, test } from "./test.js";
import { seriousViolations } from "./axe.js";
import { openBriefing, STATE_PULLS } from "./briefing-support.js";
import { openFile } from "./diff-support.js";
import { openInbox } from "./inbox-support.js";
import { MODES, openShell, WIDTHS } from "./support.js";

/**
 * P6-8 acceptance: "axe 0 serious". One sweep over every page and state of the web app, at
 * 375 / 1024 / 1440 px in light and dark, with the rule set of `axe.ts` (WCAG 2.2 AA including
 * target size). A state is recorded with its violations, so a failure names the state, the rule
 * and the elements. The feature suites keep their own axe checks next to their behaviour; this
 * one is the budget (ADR 0032) and also runs in CI.
 */

type Found = Record<string, string[]>;

/** Runs axe and keeps the state's violations, if any. */
const check = async (page: Page, found: Found, state: string): Promise<void> => {
  const violations = await seriousViolations(page);
  if (violations.length > 0) found[state] = violations;
};

const width = (page: Page) => page.viewportSize()?.width ?? 1440;
const card = (page: Page, id: string) => page.locator(`[data-finding="${id}"]`);
const toast = (page: Page) => page.locator(".toast");

/** Scrolls the main column until the (virtualised) draft card is rendered, then shows it. */
const showCard = async (page: Page, id: string) => {
  for (let i = 0; i < 30 && (await card(page, id).count()) === 0; i++) {
    await page.locator("#main").evaluate((main) => main.scrollBy({ top: 400 }));
  }
  await card(page, id).scrollIntoViewIfNeeded();
};

/** Waits for the toast's fade-in, so axe measures its contrast fully shown. */
const toastShown = (page: Page) =>
  toast(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

const GROUPS: Record<string, (page: Page, found: Found) => Promise<void>> = {
  "PR page: briefing, change map, drawers, keyboard help": async (page, found) => {
    await openShell(page);
    await page.locator("#main .map-scroll svg").waitFor();
    await check(page, found, "briefing with change map");
    await page.locator('#main .map-scroll [data-findings="F1 F3 F8"]').focus();
    await check(page, found, "change map, badge focused");
    if (width(page) <= 760) {
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await check(page, found, "files drawer");
      await page.keyboard.press("Escape");
    }
    if (width(page) <= 1180) {
      await page.getByRole("button", { name: "Review panel", exact: true }).click();
      await check(page, found, "review panel drawer");
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await check(page, found, "keyboard help");
  },

  "PR page: every briefing state": async (page, found) => {
    for (const [state, pr] of Object.entries(STATE_PULLS)) {
      if (pr === STATE_PULLS.main) continue;
      await openBriefing(page, pr);
      await check(page, found, `briefing: ${state}`);
    }
  },

  "PR page: diff and drafts": async (page, found) => {
    await openShell(page);
    await page.locator("#review-panel .tally").waitFor({ state: "attached" });
    await openFile(page, "src/auth/invitations.ts");
    await page.getByRole("button", { name: "Comment on line 3", exact: true }).click();
    await page.getByRole("textbox", { name: "Your comment on line 3" }).fill("Mine");
    await page.getByRole("button", { name: "Add comment" }).click();
    await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
    await check(page, found, "diff with own comment and composer");
    await showCard(page, "F1");
    await card(page, "F1").getByRole("button", { name: "Accept", exact: true }).click();
    await toastShown(page);
    await check(page, found, "draft accepted, toast");
    await showCard(page, "F8");
    await card(page, "F8").getByRole("button", { name: "Dismiss" }).click();
    await expect(card(page, "F8").getByRole("group")).toBeVisible();
    await check(page, found, "draft dismiss form");
    await card(page, "F8").getByRole("button", { name: "Cancel" }).click();
    await card(page, "F8").getByRole("button", { name: "Edit" }).click();
    await check(page, found, "draft editor");

    await openShell(page);
    await openFile(page, "pnpm-lock.yaml", { noise: true });
    await check(page, found, "noise file");
    await page.getByRole("button", { name: /Show raw diff/ }).click();
    await page.locator(".diff .ln").first().waitFor();
    await check(page, found, "noise file, raw diff");

    await page.goto("/?fixture=large-diff");
    await page.locator("header.topbar").waitFor();
    await openFile(page, "src/billing/ledger-rules.ts");
    await check(page, found, "5,000-line diff");
  },

  "inbox: list, approve dialog, no match": async (page, found) => {
    await openInbox(page);
    await check(page, found, "inbox");
    const safe = page.getByRole("region", { name: /Safe to bulk-approve/ });
    await safe.getByRole("button", { name: "Select all 3" }).click();
    await check(page, found, "inbox, batch selected");
    await page.getByRole("button", { name: "Approve 3 selected…" }).click();
    await check(page, found, "approve dialog");
    await page.keyboard.press("Escape");
    await page.getByRole("searchbox", { name: "Search" }).fill("nothing matches this");
    await check(page, found, "inbox, nothing matches");
  },
};

for (const [group, sweep] of Object.entries(GROUPS)) {
  test.describe(group, () => {
    for (const size of WIDTHS) {
      for (const mode of MODES) {
        test(`axe: no serious issues at ${size.width} px ${mode}`, async ({ page }) => {
          test.setTimeout(120_000);
          await page.setViewportSize(size);
          await page.emulateMedia({ colorScheme: mode });
          const found: Found = {};
          await sweep(page, found);
          expect(found).toEqual({});
        });
      }
    }
  });
}

test.describe("follow-ups from earlier tasks (P6-8)", () => {
  for (const size of WIDTHS) {
    test(`every clickable map badge is a 24 px target at ${size.width} px`, async ({ page }) => {
      // axe skips SVG targets, so the size is measured here (WCAG 2.2 2.5.8).
      await page.setViewportSize(size);
      await openShell(page);
      const badges = page.locator('#main .map-scroll .cm-badge[role="button"]');
      await expect(badges).toHaveCount(5);
      for (const badge of await badges.all()) {
        await badge.scrollIntoViewIfNeeded();
        const hit = await badge.locator(".cm-badge-hit").boundingBox();
        expect(hit?.width).toBeGreaterThanOrEqual(24);
        expect(hit?.height).toBeGreaterThanOrEqual(24);
        // The target takes the click: what is under its corner is the badge.
        if (hit === null) continue;
        const under = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest(".cm-badge") !== null,
          [hit.x + 2, hit.y + 2],
        );
        expect(under, "the hit area's corner belongs to the badge").toBe(true);
      }
    });

    test(`the map says it scrolls only when it does, at ${size.width} px`, async ({ page }) => {
      await page.setViewportSize(size);
      await openShell(page);
      await page.locator("#main .map-scroll svg").waitFor();
      const hint = page.locator(".map-scroll-hint");
      const overflows = await page
        .locator("#main .map-scroll")
        .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(overflows).toBe(size.width <= 760);
      if (overflows) await expect(hint).toHaveText(/Scroll sideways to see the whole map/);
      else await expect(hint).toHaveCount(0);
    });
  }

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

    test("buttons drop their key hints, the shortcuts button keeps its ?", async ({ page }) => {
      await openShell(page);
      await expect(page.locator(".brief-start kbd")).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Keyboard shortcuts" }).locator("kbd"),
      ).toBeVisible();
    });
  });

  test("with a mouse, buttons keep their key hints", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openShell(page);
    await expect(page.locator(".brief-start kbd")).toBeVisible();
  });
});
