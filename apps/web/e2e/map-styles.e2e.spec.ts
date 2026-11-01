import type { Locator } from "@playwright/test";
import { seriousViolations } from "./axe.js";
import { openBriefing, STATE_PULLS } from "./briefing-support.js";
import { FIXTURE_NOW, MODES } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * H4-6 (ADR 0035): the change map styles. The setting (radio buttons in the settings dialog,
 * remembered in this browser, surviving storage that throws), Live traffic's switches, the
 * walkthrough's and the flow playback's stepping and playing, click-through in every style,
 * the fallback when a document has no walkthrough or flows, reduced motion, and axe.
 */

const STYLE_KEY = "rocky-map-style";

const section = (page: Page): Locator =>
  page.locator("section", { has: page.locator("#change-map-title") });
const mainHeading = (page: Page) => page.locator("#main h2").first();

/** Opens pr-847 with a saved style (or none). */
const open = async (page: Page, style?: string, pr: number = STATE_PULLS.main) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (style !== undefined)
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: STYLE_KEY,
      value: style,
    });
  await openBriefing(page, pr);
  await section(page).waitFor();
};

const openSettings = async (page: Page) => {
  await page.getByRole("button", { name: /^Map style: / }).click();
  return page.getByRole("dialog", { name: "Keyboard shortcuts" });
};

test.describe("the setting", () => {
  test("three radio buttons with the theme, Live traffic by default, arrow keys move", async ({
    page,
  }) => {
    await open(page);
    const dialog = await openSettings(page);
    const group = dialog.getByRole("group", { name: "Change map style" });
    const radios = group.getByRole("radio");
    await expect(radios).toHaveCount(3);
    await expect(group.getByRole("radio", { name: /Live traffic/ })).toBeChecked();
    await group.getByRole("radio", { name: /Live traffic/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(group.getByRole("radio", { name: /Guided walkthrough/ })).toBeChecked();
    await expect(group.getByRole("radio", { name: /Guided walkthrough/ })).toBeFocused();
    await expect(dialog).toContainText("Remembered in this browser.");
    // The map behind the dialog already plays the new style.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Map style: Guided walkthrough" })).toBeFocused();
    await expect(section(page)).toContainText("Stop 1 of 3");
  });

  test("is remembered in this browser", async ({ page }) => {
    await open(page);
    const dialog = await openSettings(page);
    await dialog.getByRole("radio", { name: /Flow playback/ }).check();
    expect(await page.evaluate((key) => localStorage.getItem(key), STYLE_KEY)).toBe("flows");
    await page.reload();
    await section(page).waitFor();
    await expect(page.getByRole("button", { name: "Map style: Flow playback" })).toBeVisible();
    await expect(section(page).locator(".seq")).toBeVisible();
  });

  test("still works when storage throws, and says it will not last", async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("blocked", "QuotaExceededError");
      };
      Storage.prototype.getItem = () => {
        throw new DOMException("blocked", "SecurityError");
      };
    });
    await open(page);
    const dialog = await openSettings(page);
    await dialog.getByRole("radio", { name: /Flow playback/ }).check();
    await expect(dialog.getByRole("status")).toHaveText(
      "This browser could not save the choice, so it lasts until you reload the page.",
    );
    await page.keyboard.press("Escape");
    await expect(section(page).locator(".seq")).toBeVisible();
  });

  test("ignores a stored value it did not write", async ({ page }) => {
    await open(page, "<img src=x>");
    await expect(page.getByRole("button", { name: "Map style: Live traffic" })).toBeVisible();
  });
});

test.describe("Live traffic", () => {
  test("Pause motion freezes it, Traffic only dims all but the traffic edges", async ({ page }) => {
    await open(page);
    const pause = page.getByRole("button", { name: "Pause motion" });
    await expect(pause).toHaveAttribute("aria-pressed", "false");
    const dot = section(page).locator(".cm-pulse").first();
    // A dash of length 0 has no box, so "visible" is read from the style.
    expect(await dot.evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
    await pause.click();
    await expect(pause).toHaveAttribute("aria-pressed", "true");
    expect(await dot.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("paused");

    const traffic = page.getByRole("button", { name: "Traffic only" });
    await traffic.click();
    await expect(traffic).toHaveAttribute("aria-pressed", "true");
    const opacity = (id: string) =>
      section(page)
        .locator(`.cm-edge[data-edge="${id}"]`)
        .evaluate((el) => Number(getComputedStyle(el).opacity));
    // Polled: the dimming eases in.
    await expect.poll(() => opacity("page-route")).toBeLessThan(0.2);
    expect(await opacity("route-auth")).toBe(1);
  });

  test("cards and badges still open their file and finding while it moves", async ({ page }) => {
    await open(page);
    await section(page).locator('[data-node="page"]').click();
    await expect(mainHeading(page)).toHaveText("web/src/pages/InvitePage.tsx");
    await page.getByRole("button", { name: "Briefing & change map" }).click();
    await section(page).locator('[data-findings="F1 F3 F8"]').click();
    await expect(mainHeading(page)).toHaveText("src/auth/invitations.ts");
    await expect(page.locator('#main .diff button[data-line="28"]')).toBeFocused();
  });
});

test.describe("Guided walkthrough", () => {
  const pan = (page: Page) =>
    section(page)
      .locator(".walk-pan")
      .evaluate((el) => (el as HTMLElement).style.transform);

  test("Back, Next and the stop dots move between stops, and the map pans", async ({ page }) => {
    await open(page, "walkthrough");
    const back = page.getByRole("button", { name: "Back", exact: true });
    const next = page.getByRole("button", { name: "Next stop" });
    await expect(section(page)).toContainText("Stop 1 of 3");
    await expect(back).toBeDisabled();
    const first = await pan(page);
    await next.click();
    await expect(section(page)).toContainText("Stop 2 of 3");
    await expect(section(page)).toContainText("Where the role is decided");
    await expect.poll(() => pan(page)).not.toBe(first);
    // The step lights acceptInvitation() and memberships, and the edge between them.
    await expect(section(page).locator('[data-node="auth"]')).toHaveClass(/cm-focus/);
    await expect(section(page).locator('[data-node="page"]')).toHaveClass(/cm-dim/);
    await expect(section(page).locator('.cm-edge[data-edge="auth-mem"]')).toHaveClass(/cm-focus/);
    await page.getByRole("button", { name: "Stop 3: The email side" }).click();
    await expect(section(page)).toContainText("Stop 3 of 3");
    await expect(next).toBeDisabled();
    await expect(page.getByRole("button", { name: "Stop 3: The email side" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await back.click();
    await expect(section(page)).toContainText("Stop 2 of 3");
  });

  test("Play tour moves on by itself and stops at the end", async ({ page }) => {
    await page.clock.install({ time: FIXTURE_NOW });
    await open(page, "walkthrough");
    const play = page.getByRole("button", { name: "Play tour" });
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await page.clock.runFor(6_100);
    await expect(section(page)).toContainText("Stop 2 of 3");
    await page.clock.runFor(6_100);
    await expect(section(page)).toContainText("Stop 3 of 3");
    await expect(play).toHaveAttribute("aria-pressed", "false");
  });

  test("a lit card still opens its file", async ({ page }) => {
    await open(page, "walkthrough");
    await section(page).locator('[data-node="route"]').click();
    await expect(mainHeading(page)).toHaveText("src/api/routes/invitations.ts");
  });
});

test.describe("Flow playback", () => {
  const rows = (page: Page) => section(page).locator(".seq-msg");

  test("steps through the flow by Back, Next and the timeline", async ({ page }) => {
    await open(page, "flows");
    await expect(page.getByRole("button", { name: "Accepting an invitation" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(section(page).locator(".seq-now")).toContainText("Step 1 of 4");
    await expect(rows(page).nth(0)).toHaveClass(/is-active/);
    await expect(rows(page).nth(1)).toHaveClass(/is-future/);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(rows(page).nth(0)).toHaveClass(/is-past/);
    await expect(rows(page).nth(1)).toHaveClass(/is-active/);
    // The playing message's two column heads light up.
    await expect(section(page).locator(".seq-head.is-on")).toHaveCount(2);
    await page.getByRole("button", { name: /^Step 4: / }).click();
    await expect(section(page).locator(".seq-now")).toContainText("Step 4 of 4");
    await expect(section(page).locator(".seq-now")).toContainText("see finding F1");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(section(page).locator(".seq-now")).toHaveText("All 4 steps played.");
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(section(page).locator(".seq-now")).toContainText("Step 4 of 4");
  });

  test("Play runs to the end", async ({ page }) => {
    await page.clock.install({ time: FIXTURE_NOW });
    await open(page, "flows");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.clock.runFor(1_700 * 4);
    await expect(section(page).locator(".seq-now")).toHaveText("All 4 steps played.");
    await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("a column head opens its node's file", async ({ page }) => {
    await open(page, "flows");
    await page.getByRole("button", { name: /^InvitePage, opens / }).click();
    await expect(mainHeading(page)).toHaveText("web/src/pages/InvitePage.tsx");
  });
});

test.describe("fallback", () => {
  for (const [style, notice] of [
    ["walkthrough", "This pull request has no walkthrough"],
    ["flows", "This pull request has no flows"],
  ] as const) {
    test(`${style} without one shows Live traffic and says why`, async ({ page }) => {
      await open(page, style, STATE_PULLS.noTour);
      await expect(section(page).getByRole("note")).toContainText(notice);
      await expect(section(page).locator("svg.cm.cm-motion")).toBeVisible();
      await expect(section(page).locator(".cm-node")).toHaveCount(7);
    });
  }
});

test.describe("reduced motion", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("Live traffic: no dots, nothing to pause, arrows and hero colour stay", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("button", { name: "Pause motion" })).toHaveCount(0);
    const dot = section(page).locator(".cm-pulse").first();
    expect(await dot.evaluate((el) => getComputedStyle(el).display)).toBe("none");
    const hero = section(page).locator('.cm-edge[data-edge="route-auth"]');
    expect(await hero.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    expect(await hero.getAttribute("marker-end")).toMatch(/arrow-hero/);
  });

  test("Guided walkthrough: steps by hand, no Play, no easing", async ({ page }) => {
    await open(page, "walkthrough");
    await expect(page.getByRole("button", { name: "Play tour" })).toHaveCount(0);
    await page.getByRole("button", { name: "Next stop" }).click();
    await expect(section(page)).toContainText("Stop 2 of 3");
    const transition = await section(page)
      .locator(".walk-pan")
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(transition).toBe("0s");
    await expect(section(page).locator('[data-node="auth"]')).toHaveClass(/cm-focus/);
  });

  test("Flow playback opens fully played and still steps", async ({ page }) => {
    await open(page, "flows");
    await expect(section(page).locator(".seq-now")).toHaveText("All 4 steps played.");
    await expect(section(page).locator(".seq-msg.is-past")).toHaveCount(4);
    await expect(section(page).locator(".seq-token")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /^Step 2: / }).click();
    await expect(section(page).locator(".seq-msg").nth(1)).toHaveClass(/is-active/);
  });
});

test.describe("axe", () => {
  for (const mode of MODES) {
    for (const style of ["live", "walkthrough", "flows"]) {
      test(`${style}, ${mode}: no serious issues`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: mode });
        await open(page, style);
        await page.waitForTimeout(1_500);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
    test(`settings dialog, ${mode}: no serious issues`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode });
      await open(page);
      await openSettings(page);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
});
