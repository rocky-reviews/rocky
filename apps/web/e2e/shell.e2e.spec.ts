import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "./test.js";
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

const boxOf = async (page: Page, selector: string) => {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} is not visible`);
  return box;
};

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

/** P6-9 (parity audit D1, D2, D6): the top bar fits the PR like the POC at every width. */
test.describe("top bar fit", () => {
  const finishButton = (page: Page) => page.getByRole("button", { name: /^Finish review/ });
  const titleIsWhole = (page: Page) =>
    page
      .locator(".topbar .pr-title-text")
      .evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight);

  test("phone: the title is whole, Finish review keeps its label, and the bar stays compact", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openShell(page);
    expect(await titleIsWhole(page)).toBe(true);
    await expect(finishButton(page).locator(".label")).toBeVisible();
    await expect(finishButton(page).locator(".label")).toHaveText("Finish review");
    // The theme toggle left the bar (it is in the shortcuts dialog, and on m).
    await expect(page.locator(".topbar .mode-btn")).toBeHidden();
    await expect(page.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();
    const bar = await boxOf(page, "header.topbar");
    expect(bar.height).toBeLessThanOrEqual(124);
    // Every control inside the bar and the viewport.
    for (const name of ["Files", "Keyboard shortcuts", "Review panel"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box, name).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(bar.height);
    }
  });

  test("phone: the theme toggle is in the shortcuts dialog, and m still works", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: "light" });
    await openShell(page);
    const html = page.locator("html");
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await dialog.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(html).toHaveAttribute("data-mode", "dark");
    await expect(dialog.getByRole("button", { name: "Switch to light mode" })).toBeFocused();
    await page.keyboard.press("Escape");
    await page.keyboard.press("m");
    await expect(html).toHaveAttribute("data-mode", "light");
  });

  test("wider: the toggle stays in the bar, not in the dialog", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openShell(page);
    await expect(page.locator(".topbar .mode-btn")).toBeVisible();
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog.getByRole("button", { name: /^Switch to/ })).toBeHidden();
  });

  test("1024 and 1440: the details wrap item by item, as in the POC", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openShell(page);
    expect(await titleIsWhole(page)).toBe(true);
    // Two lines of details under the title, like the POC's 93 px bar.
    expect((await boxOf(page, "header.topbar")).height).toBeLessThanOrEqual(93);

    await page.setViewportSize({ width: 1440, height: 900 });
    // The approvals and comments stay on the first line; only the GitHub link wraps.
    const pill = await boxOf(page, ".topbar .status-pill");
    const stats = await boxOf(page, ".topbar .gh-stats");
    expect(Math.abs(stats.y + stats.height / 2 - (pill.y + pill.height / 2))).toBeLessThan(4);
  });
});

test.describe("keyboard", () => {
  test("tabs through the top bar into the sidebar with a visible focus ring (1440 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShell(page);
    const order: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      await page.keyboard.press("Tab");
      order.push(await focused(page));
      expect(await hasVisibleFocus(page), order.at(-1)).toBe(true);
    }
    expect(order).toEqual([
      "Skip to main content",
      "✓ 1 approvalApproved by @sam-r",
      "View on GitHub ↗ (opens in a new tab)",
      "Switch to dark mode",
      "Keyboard shortcuts",
      // P6-6: the Finish review button with its pending count.
      "Finish review0, 0 comments to post",
      "Briefing & change map",
      "Viewed src/auth/invitations.ts",
      "src/auth/invitations.ts97, risk score 97, 3 findings, worst critical",
    ]);
  });

  test("Escape closes the tooltip opened by hover, and the pointer can move onto it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShell(page);
    const trigger = page.locator(".has-tip");
    const tip = page.getByRole("tooltip");
    await trigger.hover();
    await expect(tip).toBeVisible();
    // Move down through the gap onto the tooltip itself: it stays open.
    const box = await boxOf(page, ".tip-box");
    await page.mouse.move(box.x + 10, box.y - 3);
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    // Leaving and hovering again reopens it.
    await page.mouse.move(5, 500);
    await trigger.hover();
    await expect(tip).toBeVisible();
  });

  test("the tooltip wraps within the viewport with many approvers", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openShell(page);
    await page.evaluate(() => {
      const box = document.querySelector(".tip-box");
      if (box)
        box.textContent = `Approved by ${Array.from({ length: 100 }, (_, i) => `@user-${i}`).join(", ")}`;
    });
    await page.locator(".has-tip").focus();
    const box = await boxOf(page, ".tip-box");
    expect(box.width).toBeLessThanOrEqual(375 - 32);
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

  const DRAWERS = [
    { name: "Files", region: "#sidebar", close: "Close files", width: 375, last: "Show" },
    {
      name: "Review panel",
      region: "#review-panel",
      close: "Close review panel",
      width: 1024,
      // P6-4: the panel's last control is the last draft to decide.
      last: "Missing tests for the two riskiest behavioursinvitations.test.ts:18✦ draft, Low severity",
    },
  ] as const;

  for (const d of DRAWERS) {
    test(`the ${d.name} drawer is a modal dialog with a focus trap (${d.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: d.width, height: 900 });
      await openShell(page);
      await page.getByRole("button", { name: d.name, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: d.name });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      const close = page.getByRole("button", { name: d.close });
      await expect(close).toBeFocused();
      const inside = () => page.evaluate((sel) => !!document.activeElement?.closest(sel), d.region);

      // Shift+Tab from the first control wraps to the last one, still inside.
      await page.keyboard.press("Shift+Tab");
      expect(await inside()).toBe(true);
      expect(await focused(page)).toBe(d.last);

      // Tab past the last control wraps to the first one.
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();

      // A full lap forwards never leaves the drawer.
      const count = await page
        .locator(d.region)
        .locator('a[href], button, input, [tabindex="0"]')
        .count();
      for (let i = 0; i < count + 2; i += 1) {
        await page.keyboard.press("Tab");
        expect(await inside()).toBe(true);
      }
      // The skip link is inert too.
      await expect(page.locator(".skip-link")).not.toBeFocused();
    });

    test(`widening the window past the breakpoint moves focus to the ${d.name} in place`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: d.width, height: 900 });
      await openShell(page);
      await page.getByRole("button", { name: d.name, exact: true }).click();
      await expect(page.getByRole("button", { name: d.close })).toBeFocused();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.locator(d.region)).toBeFocused();
      await expect(page.locator(d.region)).not.toHaveAttribute("role", "dialog");
      await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    });
  }

  test("choosing a file closes the Files drawer", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openShell(page);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page
      .locator("#sidebar")
      .getByRole("button", { name: /^src\/jobs\/sendInviteEmail\.ts/ })
      .click();
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
