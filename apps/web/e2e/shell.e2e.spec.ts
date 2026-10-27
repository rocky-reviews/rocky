import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { MODES, openShell, WIDTHS } from "./support.js";

/** P6-1: accessibility, keyboard paths, layout limits and the theme rules. */

const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

/** The focused element's accessible label, for asserting a tab order. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "";
    return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ");
  });

const hasVisibleFocus = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
  });

test.describe("axe", () => {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      test(`no serious issues at ${size.width} px ${mode}`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openShell(page);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  }

  for (const mode of MODES) {
    test(`no serious issues with the drawers open (${mode})`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.emulateMedia({ colorScheme: mode });
      await openShell(page);
      await page.getByRole("button", { name: "Files", exact: true }).click();
      expect(await seriousViolations(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Review panel", exact: true }).click();
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
});

test.describe("layout", () => {
  for (const size of WIDTHS) {
    test(`no horizontal page scroll at ${size.width} px`, async ({ page }) => {
      await page.setViewportSize(size);
      await openShell(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("shows the panels the width allows, like the POC", async ({ page }) => {
    const sidebar = page.locator("#sidebar");
    const panel = page.locator("#review-panel");
    const filesToggle = page.getByRole("button", { name: "Files", exact: true });
    const panelToggle = page.getByRole("button", { name: "Review panel", exact: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShell(page);
    await expect(sidebar).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(filesToggle).toBeHidden();
    await expect(panelToggle).toBeHidden();

    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(sidebar).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(panelToggle).toBeVisible();

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(sidebar).toBeHidden();
    await expect(filesToggle).toBeVisible();
  });
});

test.describe("keyboard", () => {
  test("tabs through the top bar into the sidebar with a visible focus ring (1440 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShell(page);
    const order: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      await page.keyboard.press("Tab");
      order.push(await focused(page));
      expect(await hasVisibleFocus(page), order.at(-1)).toBe(true);
    }
    expect(order).toEqual([
      "Skip to main content",
      "✓ 1 approvalApproved by @sam-r",
      "View on GitHub ↗ (opens in a new tab)",
      "Switch to dark mode",
      "Briefing & change map",
      "Viewed src/auth/invitations.ts",
      "src/auth/invitations.ts97, risk score 97, 3 findings, worst critical",
    ]);
  });

  test("the approvals tooltip opens on focus and Escape closes it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShell(page);
    const tip = page.getByRole("tooltip");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText("Approved by @sam-r");
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
  });

  test("toggles light/dark from the keyboard and remembers it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await openShell(page);
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-mode", "light");
    await page.getByRole("button", { name: "Switch to dark mode" }).focus();
    await page.keyboard.press("Enter");
    await expect(html).toHaveAttribute("data-mode", "dark");
    await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeFocused();
    await page.reload();
    await expect(html).toHaveAttribute("data-mode", "dark");
  });

  test("the Files drawer opens, traps the page and closes with Escape (375 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openShell(page);
    await page.keyboard.press("Tab"); // skip link
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("Files");
    await page.keyboard.press("Enter");
    const sidebar = page.locator("#sidebar");
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole("button", { name: "Close files" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Files", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    // Tab stays inside the drawer: the rest of the page is inert.
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("#sidebar"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole("button", { name: "Files", exact: true })).toBeFocused();
  });

  test("choosing a file closes the Files drawer", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openShell(page);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: /^src\/jobs\/sendInviteEmail\.ts/ }).click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator("main h2")).toHaveText("src/jobs/sendInviteEmail.ts");
  });

  test("the review panel drawer opens and closes from the keyboard (1024 px)", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openShell(page);
    const toggle = page.getByRole("button", { name: "Review panel", exact: true });
    await toggle.focus();
    await page.keyboard.press("Enter");
    const panel = page.locator("#review-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByRole("button", { name: "Close review panel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test("a click on the scrim closes a drawer", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openShell(page);
    await page.getByRole("button", { name: "Review panel", exact: true }).click();
    await page.mouse.click(100, 400);
    await expect(page.locator("#review-panel")).toBeHidden();
  });

  test("viewed checkboxes update coverage and strike the file through", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShell(page);
    const box = page.getByRole("checkbox", { name: "Viewed src/auth/invitations.ts" });
    await box.focus();
    await page.keyboard.press("Space");
    await expect(box).toBeChecked();
    await expect(page.locator(".coverage-top b")).toHaveText("1/4");
    await expect(page.locator(".coverage-note")).toHaveText("About 4 min of high-risk code left");
    await expect(page.locator("li.nav-item.viewed")).toHaveCount(1);
  });

  test("noise: Show lists the files, Trust marks them viewed", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShell(page);
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page.getByRole("button", { name: /^pnpm-lock\.yaml/ })).toBeFocused();
    await page.reload();
    await page.getByRole("button", { name: "Trust & mark viewed" }).click();
    await expect(page.getByRole("checkbox", { name: "Viewed pnpm-lock.yaml" })).toBeChecked();
  });
});

test.describe("theme", () => {
  /** The pre-paint script alone, with the app bundle blocked: what the first paint gets. */
  const firstPaintMode = async (page: Page) => {
    await page.route("**/src/main.tsx", (route) => route.abort());
    await page.goto("/");
    return page.locator("html").getAttribute("data-mode");
  };

  test("first paint follows the system preference (no flash)", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await firstPaintMode(page)).toBe("dark");
  });

  test("first paint uses the saved choice over the system", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("rocky-mode", "light"));
    expect(await firstPaintMode(page)).toBe("light");
  });

  test("works when storage throws", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new DOMException("blocked", "SecurityError");
      };
      Storage.prototype.setItem = () => {
        throw new DOMException("blocked", "SecurityError");
      };
    });
    await openShell(page);
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-mode", "dark");
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(html).toHaveAttribute("data-mode", "light");
  });

  test("follows system changes until the viewer chooses", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openShell(page);
    const html = page.locator("html");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-mode", "dark");
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-mode", "light");
  });
});

test("View on GitHub opens the PR in a new tab", async ({ page }) => {
  await openShell(page);
  const link = page.getByRole("link", { name: /View on GitHub/ });
  await expect(link).toHaveAttribute("href", "https://github.com/acme/rocky-app/pull/847");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});
