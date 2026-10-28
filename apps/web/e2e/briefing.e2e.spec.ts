import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { MODES, WIDTHS } from "./support.js";
import { openBriefing, STATE_PULLS } from "./briefing-support.js";

/** P6-2: accessibility, the keyboard path and clickable files in the briefing and its states. */

const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "";
    return (el.getAttribute("aria-label") ?? el.id ?? el.textContent ?? "").trim();
  });

const mainHeading = (page: Page) => page.locator("#main h2").first();

test.describe("axe", () => {
  for (const [state, pr] of Object.entries(STATE_PULLS)) {
    for (const size of WIDTHS) {
      for (const mode of MODES) {
        test(`${state}: no serious issues at ${size.width} px ${mode}`, async ({ page }) => {
          await page.setViewportSize(size);
          await page.emulateMedia({ colorScheme: mode });
          await openBriefing(page, pr);
          expect(await seriousViolations(page)).toEqual([]);
        });
      }
    }
  }
});

test.describe("layout", () => {
  for (const pr of [STATE_PULLS.main, STATE_PULLS.graphUnavailable, STATE_PULLS.awaitingApproval]) {
    test(`no horizontal page scroll at 375 px (PR ${pr})`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await openBriefing(page, pr);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      // The main column does not scroll sideways either; only the change map may, in its box.
      const mainOverflow = await page
        .locator("#main")
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(mainOverflow).toBeLessThanOrEqual(0);
    });
  }

  test("the risk table stacks at 375 px (POC defect 1)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openBriefing(page, STATE_PULLS.main);
    const table = await page.locator(".risk-table").boundingBox();
    const card = await page.locator(".brief").boundingBox();
    expect(table && card && table.x + table.width <= card.x + card.width).toBe(true);
  });
});

test.describe("clickable files", () => {
  test("a risk-table file selects it in the sidebar and the main column", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBriefing(page, STATE_PULLS.main);
    await page.getByRole("button", { name: "Open src/jobs/sendInviteEmail.ts" }).click();
    await expect(mainHeading(page)).toHaveText("src/jobs/sendInviteEmail.ts");
    await expect(
      page.locator("#sidebar .nav-file[aria-current='page']", {
        hasText: "src/jobs/sendInviteEmail.ts",
      }),
    ).toBeVisible();
    await expect(page.locator("#main")).toBeFocused();
  });

  test("an unanalysed file opens and is selected in the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBriefing(page, STATE_PULLS.graphUnavailable);
    await page.getByRole("button", { name: "Open src/api/index.ts" }).click();
    await expect(mainHeading(page)).toHaveText("src/api/index.ts");
    await expect(
      page.locator("#sidebar .nav-file[aria-current='page']", { hasText: "src/api/index.ts" }),
    ).toBeVisible();
  });

  test("the Briefing & change map entry returns to the briefing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBriefing(page, STATE_PULLS.main);
    await page.getByRole("button", { name: "Open src/auth/invitations.ts" }).click();
    await expect(mainHeading(page)).toHaveText("src/auth/invitations.ts");
    const entry = page.getByRole("button", { name: "Briefing & change map" });
    await entry.click();
    await expect(entry).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#briefing-title")).toBeVisible();
  });

  test("a noise file in the ignore row opens too", async ({ page }) => {
    await openBriefing(page, STATE_PULLS.main);
    await page.getByRole("button", { name: "Open pnpm-lock.yaml" }).click();
    await expect(mainHeading(page)).toHaveText("pnpm-lock.yaml");
  });

  test("a change-map card, a path step and the start button open their files", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBriefing(page, STATE_PULLS.main);
    await page.locator(".map-card button", { hasText: "InvitePage" }).click();
    await expect(mainHeading(page)).toHaveText("web/src/pages/InvitePage.tsx");

    await page.getByRole("button", { name: "Briefing & change map" }).click();
    await page.locator(".path-list button").nth(2).click();
    await expect(mainHeading(page)).toHaveText("db/migrations/20261020_add_invitations.sql");

    await page.getByRole("button", { name: "Briefing & change map" }).click();
    await page.getByRole("button", { name: "Start with the riskiest file" }).click();
    await expect(mainHeading(page)).toHaveText("src/auth/invitations.ts");
  });

  test("at 375 px a file opened from the briefing is the one selected in the Files drawer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openBriefing(page, STATE_PULLS.main);
    await page.getByRole("button", { name: "Open src/api/routes/invitations.ts" }).click();
    await expect(mainHeading(page)).toHaveText("src/api/routes/invitations.ts");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(
      page.locator("#sidebar .nav-file[aria-current='page']", {
        hasText: "src/api/routes/invitations.ts",
      }),
    ).toBeVisible();
  });
});

test.describe("keyboard", () => {
  test("skip link, then Tab reaches the risk table and Enter opens the file (1440 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBriefing(page, STATE_PULLS.main);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();

    await page.keyboard.press("Tab");
    expect(await focusedName(page)).toBe("Open src/auth/invitations.ts");
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as Element);
      return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
    });
    expect(ring).toBe(true);
    await page.keyboard.press("Tab");
    expect(await focusedName(page)).toBe("Open src/api/routes/invitations.ts");

    await page.keyboard.press("Enter");
    await expect(mainHeading(page)).toHaveText("src/api/routes/invitations.ts");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("every file control in the briefing is reachable with Tab, in reading order", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBriefing(page, STATE_PULLS.main);
    await page.locator("#main").focus();
    const names: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const inMain = await page.evaluate(() =>
        document.querySelector("#main")?.contains(document.activeElement),
      );
      if (!inMain) break;
      names.push(
        await page.evaluate(() => (document.activeElement as HTMLElement).dataset.path ?? ""),
      );
    }
    // 9 risk-table files, 5 map cards backed by a PR file, 4 path steps, the start button.
    expect(names).toHaveLength(19);
    expect(names.at(-1)).toBe("src/auth/invitations.ts");
    expect(names.every((p) => p !== "")).toBe(true);
  });
});

test.describe("states", () => {
  test("the in-progress state is a live status", async ({ page }) => {
    await openBriefing(page, STATE_PULLS.running);
    await expect(page.getByRole("status")).toContainText("Analysing this pull request");
  });

  test("without a document the sidebar says files come later", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBriefing(page, STATE_PULLS.failed);
    await expect(page.locator("#sidebar")).toContainText("Files appear here once");
    await expect(page.locator("#main")).toContainText("Code: repository_inaccessible");
  });
});
