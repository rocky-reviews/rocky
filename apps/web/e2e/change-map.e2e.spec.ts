import type { Locator } from "@playwright/test";
import { expect, type Page, test } from "./test.js";
import { openBriefing, STATE_PULLS } from "./briefing-support.js";

/**
 * P5-3: change-map click-through. A card backed by a file in the pull request opens that file;
 * a finding badge opens its worst finding (the file, focused on the finding's line). Both work
 * with the mouse and with the keyboard (Tab, then Enter or Space). The ids on the map are model
 * output: the page resolves them against the document's own nodes, findings and files, so an id
 * that names nothing (or a path) does nothing.
 */

const map = (page: Page): Locator => page.locator("#main .map-scroll");
const mainHeading = (page: Page) => page.locator("#main h2").first();
const backToBriefing = (page: Page) =>
  page.getByRole("button", { name: "Briefing & change map" }).click();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBriefing(page, STATE_PULLS.main);
  await map(page).locator("svg").waitFor();
});

test.describe("mouse", () => {
  test("clicking a card opens its file", async ({ page }) => {
    await map(page).locator('[data-node="page"]').click();
    await expect(mainHeading(page)).toHaveText("web/src/pages/InvitePage.tsx");
    await expect(
      page.locator("#sidebar .nav-file[aria-current='page']", {
        hasText: "web/src/pages/InvitePage.tsx",
      }),
    ).toBeVisible();
    await expect(page.locator("#main")).toBeFocused();
  });

  test("clicking a card's title text opens its file too", async ({ page }) => {
    await map(page).locator('[data-node="job"] .cm-node-title').click();
    await expect(mainHeading(page)).toHaveText("src/jobs/sendInviteEmail.ts");
  });

  test("clicking a finding badge opens its worst finding at its line", async ({ page }) => {
    // acceptInvitation() holds F1 (critical, line 28), F3 (high, 23) and F8 (low, 31).
    const badge = map(page).locator('[data-findings="F1 F3 F8"]');
    await expect(badge).toHaveAttribute("role", "button");
    await badge.click();
    await expect(mainHeading(page)).toHaveText("src/auth/invitations.ts");
    const line = page.locator('#main .diff button[data-line="28"]');
    await expect(line).toBeFocused();
    await expect(line).toBeInViewport();
  });

  test("a badge on another card opens that card's worst finding", async ({ page }) => {
    // invitations (migration): F4 (high, line 6) before F5 (medium, line 3).
    await map(page).locator('[data-findings="F4 F5"]').click();
    await expect(mainHeading(page)).toHaveText("db/migrations/20261020_add_invitations.sql");
    await expect(page.locator('#main .diff button[data-line="6"]')).toBeFocused();
  });

  test("with the diff already loaded, a badge still lands on its line", async ({ page }) => {
    await map(page).locator('[data-node="page"]').click();
    await expect(page.locator("#main .diff")).toBeVisible();
    await backToBriefing(page);
    await map(page).locator('[data-findings="F1 F3 F8"]').click();
    const line = page.locator('#main .diff button[data-line="28"]');
    await expect(line).toBeFocused();
    await expect(line).toBeInViewport();
  });

  test("a card whose file is not in the pull request is not a button and does nothing", async ({
    page,
  }) => {
    for (const id of ["mem", "mail"]) {
      const card = map(page).locator(`[data-node="${id}"]`);
      await expect(card).not.toHaveAttribute("role", "button");
      await expect(card).not.toHaveAttribute("tabindex");
      await card.click();
      await expect(page.locator("#briefing-title")).toBeVisible();
    }
  });
});

test.describe("keyboard", () => {
  test("Tab reaches each card and then its badge; Enter opens the file", async ({ page }) => {
    const first = map(page).locator('[data-node="page"]');
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(map(page).locator('[data-findings="F9"]')).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(first).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(mainHeading(page)).toHaveText("web/src/pages/InvitePage.tsx");
  });

  test("Space on a card opens its file", async ({ page }) => {
    await map(page).locator('[data-node="route"]').focus();
    await page.keyboard.press(" ");
    await expect(mainHeading(page)).toHaveText("src/api/routes/invitations.ts");
  });

  test("Enter and Space on a badge open the finding, focused on its line", async ({ page }) => {
    await map(page).locator('[data-findings="F2 F7"]').focus();
    await page.keyboard.press("Enter");
    await expect(mainHeading(page)).toHaveText("src/api/routes/invitations.ts");
    await expect(page.locator('#main .diff button[data-line="13"]')).toBeFocused();

    await backToBriefing(page);
    await map(page).locator('[data-findings="F6"]').focus();
    await page.keyboard.press(" ");
    await expect(mainHeading(page)).toHaveText("src/jobs/sendInviteEmail.ts");
    await expect(page.locator('#main .diff button[data-line="9"]')).toBeFocused();
  });

  test("cards and badges have names that say where they go", async ({ page }) => {
    await expect(
      map(page).getByRole("button", {
        name: "InvitePage web/src/pages, opens web/src/pages/InvitePage.tsx",
      }),
    ).toHaveAttribute("data-node", "page");
    await expect(
      map(page).getByRole("button", {
        name: "3 findings on acceptInvitation(), worst critical: go to src/auth/invitations.ts line 28",
      }),
    ).toHaveAttribute("data-findings", "F1 F3 F8");
  });

  test("a focused card shows a focus ring", async ({ page }) => {
    const card = map(page).locator('[data-node="auth"]');
    await card.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(card).toBeFocused();
    const outline = await card.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
  });
});

test.describe("untrusted ids", () => {
  test("ids that name nothing in the document do nothing", async ({ page }) => {
    // By name, which stays put while the test rewrites the ids under it.
    const card = map(page).getByRole("button", {
      name: "InvitePage web/src/pages, opens web/src/pages/InvitePage.tsx",
    });
    const badge = map(page).getByRole("button", { name: /^1 finding on InvitePage/ });
    // Values a hostile document could carry, written into the DOM after rendering: none of
    // them is one of the document's own node or finding ids.
    for (const value of ["../../etc/passwd", "web/src/pages/InvitePage.tsx", "constructor"]) {
      await card.evaluate((el, v) => el.setAttribute("data-node", v), value);
      await card.click();
      await expect(page.locator("#briefing-title")).toBeVisible();
    }
    for (const value of ["F404", "__proto__", "F9x F10"]) {
      await badge.evaluate((el, v) => el.setAttribute("data-findings", v), value);
      await badge.click();
      await expect(page.locator("#briefing-title")).toBeVisible();
    }
  });

  test("a finding on a file outside the map's cards opens only through its own id", async ({
    page,
  }) => {
    // F10 is on src/auth/invitations.test.ts, a PR file with no card. Pointing a badge at it is
    // still a known finding on a known file: it opens that file at its line.
    await map(page)
      .locator('[data-findings="F9"]')
      .evaluate((el) => el.setAttribute("data-findings", "F10"));
    await map(page).locator('[data-findings="F10"]').click();
    await expect(mainHeading(page)).toHaveText("src/auth/invitations.test.ts");
  });
});

test.describe("the map in the page DOM", () => {
  test("has nothing that runs, links or styles, and no inline handlers", async ({ page }) => {
    const found = await map(page).evaluate((root) => {
      const bad: string[] = [];
      for (const el of root.querySelectorAll("*")) {
        if (/^(script|foreignobject|a|use|style|image|iframe|animate|set)$/i.test(el.localName))
          bad.push(`<${el.localName}>`);
        for (const attr of el.attributes)
          if (/^(on|style$|href$|xlink:href$|src$)/i.test(attr.name))
            bad.push(`${el.localName}[${attr.name}]`);
      }
      for (const attr of root.attributes)
        if (/^(on|style$)/i.test(attr.name)) bad.push(`wrapper[${attr.name}]`);
      return bad;
    });
    expect(found).toEqual([]);
    // Tooltips stay inside the SVG.
    await expect(map(page).locator('[data-node="auth"] > title')).toHaveCount(1);
  });
});
