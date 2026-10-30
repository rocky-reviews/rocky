import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "./test.js";
import { openFile } from "./diff-support.js";
import { MODES, openShell, WIDTHS } from "./support.js";

/** P6-3: the file view's accessibility, keyboard path, own comments and virtualisation. */

const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

const focusedLabel = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim();
  });

const LARGE = "src/billing/ledger-rules.ts";

test.describe("axe", () => {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      test(`file view: no serious issues at ${size.width} px ${mode}`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openShell(page);
        await openFile(page, "src/auth/invitations.ts");
        // Flags, an own comment and the open composer are all on screen.
        await page.getByRole("button", { name: "Comment on line 3", exact: true }).click();
        await page.getByRole("textbox", { name: "Your comment on line 3" }).fill("Mine");
        await page.getByRole("button", { name: "Add comment" }).click();
        await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  }

  test("noise file view with the raw diff shown: no serious issues", async ({ page }) => {
    await openShell(page);
    await openFile(page, "pnpm-lock.yaml", { noise: true });
    await page.getByRole("button", { name: /Show raw diff/ }).click();
    await page.locator(".diff .ln").first().waitFor();
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe("keyboard", () => {
  test("arrows move between lines, Enter composes, ⌘/Ctrl+Enter adds, focus returns", async ({
    page,
  }) => {
    await openShell(page);
    await openFile(page, "src/auth/invitations.ts");
    await page.getByRole("button", { name: "Mark viewed", exact: true }).focus();
    await page.keyboard.press("Tab");
    expect(await focusedLabel(page)).toBe("Comment on line 1");
    for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowDown");
    expect(await focusedLabel(page)).toBe("Comment on line 10");
    await page.keyboard.press("ArrowUp");
    expect(await focusedLabel(page)).toBe("Comment on line 9");
    await page.keyboard.press("ArrowDown");

    await page.keyboard.press("Enter");
    const box = page.getByRole("textbox", { name: "Your comment on line 10" });
    await expect(box).toBeFocused();
    await page.keyboard.type("Should this TTL come from config?");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(box).toHaveCount(0);
    await expect(page.locator(".mine")).toContainText("Should this TTL come from config?");
    await expect(page.locator(".mine")).toContainText("Pending");
    expect(await focusedLabel(page)).toBe("Comment on line 10");

    // The line numbers are one tab stop: Tab leaves the diff for the comment's Delete button.
    await page.keyboard.press("Tab");
    expect(await focusedLabel(page)).toBe("Delete your comment on line 10");
    await page.keyboard.press("Enter");
    await expect(page.locator(".mine")).toHaveCount(0);
    expect(await focusedLabel(page)).toBe("Comment on line 10");

    // Escape cancels the composer and keeps nothing.
    await page.keyboard.press("Enter");
    await page.keyboard.type("draft");
    await page.keyboard.press("Escape");
    await expect(page.locator(".compose")).toHaveCount(0);
    await expect(page.locator(".mine")).toHaveCount(0);
    expect(await focusedLabel(page)).toBe("Comment on line 10");

    // Shift+Tab goes back out of the diff in one step.
    await page.keyboard.press("Shift+Tab");
    expect(await focusedLabel(page)).toBe("Mark viewed");
  });

  test("Add comment is disabled until there is text; comments survive switching files", async ({
    page,
  }) => {
    await openShell(page);
    await openFile(page, "src/auth/invitations.ts");
    await page.getByRole("button", { name: "Comment on line 5", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add comment" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Your comment on line 5" }).fill("   ");
    await expect(page.getByRole("button", { name: "Add comment" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Your comment on line 5" }).fill("Kept in memory");
    await page.getByRole("button", { name: "Add comment" }).click();
    await openFile(page, "src/api/routes/invitations.ts");
    await expect(page.locator(".mine")).toHaveCount(0);
    await openFile(page, "src/auth/invitations.ts");
    await expect(page.locator(".mine")).toContainText("Kept in memory");
  });

  test("Mark viewed & next marks the file and moves focus to the next file's title", async ({
    page,
  }) => {
    await openShell(page);
    await openFile(page, "src/auth/invitations.ts");
    await page.getByRole("button", { name: /Mark viewed & next/ }).click();
    await expect(page.locator("#file-title")).toHaveText("src/api/routes/invitations.ts");
    await expect(page.locator("#file-title")).toBeFocused();
    await expect(
      page.getByRole("checkbox", { name: "Viewed src/auth/invitations.ts" }),
    ).toBeChecked();
    await expect(page.locator(".coverage")).toContainText("1/4");
    await page.getByRole("button", { name: "Mark viewed", exact: true }).click();
    await expect(page.getByRole("button", { name: "✓ Viewed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Next file", exact: true })).toBeVisible();
  });

  test("Home and End reach the ends of a virtualised 5,000-line file", async ({ page }) => {
    await page.goto("/?fixture=large-diff");
    await page.locator(`#sidebar button.nav-file[title="${LARGE}"]`).click();
    await page.locator(".diff .ln").first().waitFor();
    await page.getByRole("button", { name: "Mark viewed", exact: true }).focus();
    await page.keyboard.press("Tab");
    expect(await focusedLabel(page)).toBe("Comment on line 1");
    await page.keyboard.press("End");
    await expect.poll(() => focusedLabel(page)).toBe("Comment on line 5480");
    await expect(
      page.getByRole("button", { name: "Comment on line 5480", exact: true }),
    ).toBeInViewport();
    await page.keyboard.press("PageUp");
    await expect.poll(() => focusedLabel(page)).toBe("Comment on line 5460");
    await page.keyboard.press("Home");
    await expect.poll(() => focusedLabel(page)).toBe("Comment on line 1");
    await expect(
      page.getByRole("button", { name: "Comment on line 1", exact: true }),
    ).toBeInViewport();
  });
});

test.describe("composer while scrolling", () => {
  test("a draft and its focus survive scrolling the composer out of the window", async ({
    page,
  }) => {
    await page.goto("/?fixture=large-diff");
    await page.locator(`#sidebar button.nav-file[title="${LARGE}"]`).click();
    await page.locator(".diff .ln").first().waitFor();
    // Record whether focus ever falls back to <body> (checked after the focus change settles).
    await page.evaluate(() => {
      const w = window as unknown as { lost: string[] };
      w.lost = [];
      document.addEventListener("focusout", (e) =>
        setTimeout(() => {
          if (document.activeElement === document.body)
            w.lost.push((e.target as HTMLElement).outerHTML.slice(0, 120));
        }),
      );
    });
    await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
    const box = page.getByRole("textbox", { name: "Your comment on line 10" });
    await box.pressSequentially("Keep this draft");
    // Scroll about 3,000 px away (well past the rendered window) and back.
    for (const top of [1000, 2000, 3200]) {
      await page.locator("#main").evaluate((main, y) => main.scrollTo({ top: y }), top);
      await page.waitForTimeout(100);
    }
    const lowest = await page
      .locator(".diff button.no")
      .evaluateAll((els) => els.map((el) => Number(el.textContent)).filter((n) => n > 20));
    expect(lowest.length, "the window moved far from line 10").toBeGreaterThan(20);
    await expect(box).toBeFocused();
    await page.locator("#main").evaluate((main) => main.scrollTo({ top: 0 }));
    await expect(box).toHaveValue("Keep this draft");
    await expect(box).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { lost: string[] }).lost)).toEqual([]);
  });
});

test.describe("diff content", () => {
  test("hot lines and AI flags sit on their lines", async ({ page }) => {
    await openShell(page);
    await openFile(page, "src/auth/invitations.ts");
    const row = (n: number) =>
      page.locator(".ln", { has: page.locator(`button[data-line="${n}"]`) });
    await expect(row(10)).toHaveClass(/hot-ok/);
    await expect(row(20)).toHaveClass(/hot-look/);
    await expect(row(27)).toHaveClass(/hot-question/);
    await expect(row(28)).toHaveClass(/hot-critical/);
    await expect(row(23)).toHaveClass(/hot-high/);
    await expect(page.locator(".flag.ok")).toContainText("Checked");
    await expect(page.locator(".flag.look")).toContainText("Look here");
    await expect(page.locator(".flag.question")).toContainText("Your call");
  });

  test("a modified file shows old and new numbers, signs and hunk headers", async ({ page }) => {
    await openShell(page);
    await openFile(page, "src/api/index.ts");
    await expect(page.locator(".hunk-head")).toHaveText([
      '@@ -3,3 +3,4 @@ import express from "express";',
      "@@ -18,4 +19,5 @@ const app = express();",
    ]);
    const added = page.locator(".ln.add").first();
    await expect(added.locator(".no").first()).toHaveText("");
    await expect(added.locator("button.no")).toHaveText("4");
    await expect(page.locator(".ln.ctx").first().locator(".no").first()).toHaveText("3");
  });

  test("the noise view shows the AI summary, and the raw diff on request", async ({ page }) => {
    await openShell(page);
    await openFile(page, "pnpm-lock.yaml", { noise: true });
    await expect(page.locator(".noise-card")).toContainText("AI summary");
    await expect(page.locator(".diff")).toHaveCount(0);
    await page.getByRole("button", { name: /Show raw diff/ }).click();
    await expect(page.locator(".diff .ln.del")).toHaveCount(3);
  });
});

test.describe("virtualisation", () => {
  test("a 5,000-line file keeps a bounded number of rows in the DOM", async ({ page }) => {
    await page.goto("/?fixture=large-diff");
    await page.locator(`#sidebar button.nav-file[title="${LARGE}"]`).click();
    await page.locator(".diff .ln").first().waitFor();
    const rows = () => page.locator(".diff [data-vkey]").count();
    expect(await rows()).toBeLessThan(200);
    await page.locator("#main").evaluate((main) => main.scrollTo({ top: 60_000 }));
    // The rows rendered follow the viewport, far from the top of the file.
    const lowest = () =>
      page
        .locator(".diff button.no")
        // Line 1 is the active (pinned) line and stays rendered; the rest follow the viewport.
        .evaluateAll((els) =>
          Math.min(...els.map((el) => Number(el.textContent)).filter((n) => n !== 1)),
        );
    await expect.poll(lowest).toBeGreaterThan(1500);
    expect(await rows()).toBeGreaterThan(20);
    expect(await rows()).toBeLessThan(200);
  });

  for (const size of WIDTHS) {
    test(`file view has no horizontal page scroll at ${size.width} px`, async ({ page }) => {
      await page.setViewportSize(size);
      await openShell(page);
      await openFile(page, "src/auth/invitations.ts");
      const overflow = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>("#main");
        return Math.max(
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          main === null ? 0 : main.scrollWidth - main.clientWidth,
        );
      });
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
