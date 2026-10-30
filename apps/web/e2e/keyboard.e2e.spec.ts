import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "./test.js";
import { FIXTURE_NOW, MODES, openShell, WIDTHS } from "./support.js";
import pr847 from "../../../packages/schema/fixtures/pr-847.json" with { type: "json" };

const F2_BODY = pr847.findings.find((f) => f.id === "F2")?.body ?? "";

/**
 * P6-5 acceptance criterion: "keyboard-only e2e completes a full review". The first test uses
 * only the keyboard (no clicks, no `focus()`): it walks the files in risk order, marks them
 * viewed, walks the AI drafts and accepts, edits and dismisses them, toggles the theme, opens
 * the help and the Ask entry point, then finishes the review (P6-6): ⌘/Ctrl+Enter opens the
 * modal, Tab reaches the verdict and Submit, Enter posts once, the toast and the status pill
 * update, and Escape closes the modal and returns focus.
 *
 * The others pin the rules (ADR 0030): nothing fires while typing or with Ctrl/⌘/Alt, nothing
 * behind a modal, single-key shortcuts can be turned off (WCAG 2.1.4), the help dialog traps
 * focus and closes with Escape, and axe finds no serious issue with it open.
 */

const AUTH = "src/auth/invitations.ts";
const ROUTES = "src/api/routes/invitations.ts";
const MIGRATION = "db/migrations/20261020_add_invitations.sql";
const JOB = "src/jobs/sendInviteEmail.ts";
const HIGH_RISK = [AUTH, ROUTES, MIGRATION, JOB];

const card = (page: Page, id: string) => page.locator(`[data-finding="${id}"]`);
const toast = (page: Page) => page.locator(".toast");
const fileTitle = (page: Page) => page.locator("#file-title");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const activeFinding = (page: Page) =>
  page.evaluate(() =>
    document.activeElement?.closest("[data-finding]")?.getAttribute("data-finding"),
  );

const reviewReady = (page: Page) =>
  page.locator("#review-panel .tally").waitFor({ state: "attached" });

const open = async (page: Page) => {
  await openShell(page);
  await reviewReady(page);
};

/** Presses a key and waits until the page has rendered the result (the next frame). */
const press = async (page: Page, key: string) => {
  await page.keyboard.press(key);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
};

const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

test("a full review with the keyboard only", async ({ page, reviewApi }) => {
  await open(page);
  const mode = await page.locator("html").getAttribute("data-mode");

  // ? opens the help, Escape closes it.
  await press(page, "?");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText("Next / previous file");
  await press(page, "Escape");
  await expect(dialog(page)).toHaveCount(0);

  // k / j walk the files in risk order, from the briefing.
  await press(page, "k");
  await expect(fileTitle(page)).toHaveText(AUTH);
  await press(page, "k");
  await expect(fileTitle(page)).toHaveText(ROUTES);
  await press(page, "j");
  await expect(fileTitle(page)).toHaveText(AUTH);

  // v marks the file viewed, and again un-marks it.
  const viewedButton = page.locator(".file-head").getByRole("button", { pressed: true });
  await press(page, "v");
  await expect(viewedButton).toHaveText(/Viewed/);
  await expect(page.getByRole("checkbox", { name: `Viewed ${AUTH}` })).toBeChecked();
  await press(page, "v");
  await expect(viewedButton).toHaveCount(0);
  await press(page, "v");

  // n / p walk the undecided drafts by severity (F1 critical, then F2, F3, F4 high…).
  await press(page, "n");
  await expect(card(page, "F1")).toBeFocused();
  await press(page, "n");
  await expect(card(page, "F2")).toBeFocused();
  await expect(fileTitle(page)).toHaveText(ROUTES);
  await press(page, "p");
  await expect(card(page, "F1")).toBeFocused();
  await expect(fileTitle(page)).toHaveText(AUTH);

  // a accepts the focused draft.
  await press(page, "a");
  await expect(toast(page)).toHaveText("Added to your pending review. Not posted yet.");
  await expect.poll(() => reviewApi.decision("F1").state).toBe("accepted");

  // e edits the next one; the letters typed go into the text box, ⌘/Ctrl+Enter saves.
  await press(page, "n");
  await expect(card(page, "F2")).toBeFocused();
  await press(page, "e");
  const box = page.getByRole("textbox", { name: "Your comment, edited from the AI draft" });
  await expect(box).toBeFocused();
  // The editor starts from the draft's text; the letters below replace it.
  await expect(box).toHaveValue(F2_BODY);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Check the caller is an org admin (k, j, n, v).");
  await expect(fileTitle(page)).toHaveText(ROUTES);
  await press(page, "ControlOrMeta+Enter");
  await expect
    .poll(() => reviewApi.decision("F2"))
    .toEqual({
      state: "accepted",
      edited: true,
      body: "Check the caller is an org admin (k, j, n, v).",
    });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // d dismisses with a reason picked by keyboard.
  await press(page, "n");
  await expect(card(page, "F3")).toBeFocused();
  await press(page, "d");
  await expect(card(page, "F3").getByRole("button", { name: "Not a real issue" })).toBeFocused();
  await press(page, "Tab");
  await press(page, "Enter");
  await expect
    .poll(() => reviewApi.decision("F3"))
    .toEqual({
      state: "dismissed",
      reason: "intentional",
    });

  // The rest: accept or dismiss each, until every draft has a decision.
  for (const [id, key] of [
    ["F4", "a"],
    ["F5", "a"],
    ["F6", "d"],
    ["F7", "a"],
    ["F8", "d"],
    ["F9", "a"],
    ["F10", "a"],
  ] as const) {
    await press(page, "n");
    await expect(card(page, id)).toBeFocused();
    await press(page, key);
    if (key === "d") await press(page, "Enter");
    await expect.poll(() => reviewApi.decision(id).state).not.toBe("draft");
  }
  await expect(page.locator("#review-panel")).toContainText("Every AI draft has a decision.");

  // Every critical and important file marked viewed, walking with k.
  await press(page, "b");
  await expect(page.getByRole("heading", { name: "Briefing & change map" })).toBeVisible();
  for (const path of HIGH_RISK) {
    await press(page, "k");
    await expect(fileTitle(page)).toHaveText(path);
    if (path !== AUTH) await press(page, "v");
  }
  await expect(page.locator(".coverage")).toContainText("All high-risk files reviewed ✓");

  // m switches light/dark and back.
  await press(page, "m");
  await expect(page.locator("html")).not.toHaveAttribute("data-mode", mode ?? "");
  await press(page, "m");
  await expect(page.locator("html")).toHaveAttribute("data-mode", mode ?? "");

  // / is the Ask entry point (Ask is P9).
  await press(page, "/");
  await expect(toast(page)).toHaveText("Ask is not available yet.");

  // Every decision reached the drafts API (the test's store, not the page).
  expect(reviewApi.decision("F1").state).toBe("accepted");
  expect(reviewApi.decision("F10").state).toBe("accepted");
  expect(reviewApi.decision("F8").state).toBe("dismissed");

  // ⌘/Ctrl+Enter opens Finish review (P6-6): focus starts inside, single keys are off.
  await press(page, "ControlOrMeta+Enter");
  const finish = page.getByRole("dialog", { name: "Finish your review" });
  await expect(finish).toBeVisible();
  await expect(finish.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(finish).toContainText("✓ You reviewed every Critical and Important file.");
  await expect(finish).toContainText("Will be posted to GitHub as @dana-k (7)");
  await expect(finish.locator(".post-list > li")).toHaveCount(7);
  await press(page, "k");
  await expect(fileTitle(page)).toHaveText(JOB);
  // Escape closes it and returns focus to the main column (nothing had focus before).
  await press(page, "Escape");
  await expect(finish).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");

  // Again, through to Submit: Tab to the summary, the draft button, the verdict (Request
  // changes is pre-selected: F1 is critical), Keep reviewing and Submit; Enter posts once.
  await press(page, "ControlOrMeta+Enter");
  await expect(finish.locator(".post-list > li")).toHaveCount(7);
  // Each comment's source box is a tab stop (it scrolls when long), then the summary.
  for (let i = 0; i < 7; i++) {
    await press(page, "Tab");
    await expect(finish.locator(".post-raw").nth(i)).toBeFocused();
  }
  await press(page, "Tab");
  await expect(finish.getByRole("textbox", { name: "Overall comment (optional)" })).toBeFocused();
  await page.keyboard.type("Four auth issues to fix before merge; smaller items inline (k, j).");
  await press(page, "Tab");
  // The summary has the person's own words now, so the draft button offers to replace them.
  await expect(
    finish.getByRole("button", { name: "Replace with a draft from my comments" }),
  ).toBeFocused();
  await press(page, "Tab");
  const request = finish.getByRole("radio", { name: /Request changes/ });
  await expect(request).toBeFocused();
  await expect(request).toBeChecked();
  await press(page, "Tab");
  await expect(finish.getByRole("button", { name: "Keep reviewing" })).toBeFocused();
  await press(page, "Tab");
  const submit = finish.getByRole("button", { name: "Submit review" });
  await expect(submit).toBeFocused();
  await expect(submit).toHaveAttribute("data-armed", "true");
  await press(page, "Enter");
  await press(page, "Enter");
  await expect(finish).toHaveCount(0);
  await expect(toast(page)).toHaveText("Review submitted to GitHub as @dana-k.");
  await expect(page.locator(".topbar .status-pill")).toHaveText("Changes requested");
  expect(reviewApi.posted()).toHaveLength(1);
  expect(reviewApi.posted()[0]).toMatchObject({
    verdict: "request_changes",
    body: "Four auth issues to fix before merge; smaller items inline (k, j).",
  });
  expect(reviewApi.posted()[0]?.comments).toHaveLength(7);
  // Focus is back on the page, and the posted drafts are read-only: n finds nothing to decide,
  // a does nothing.
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
  await press(page, "n");
  await press(page, "a");
  expect(reviewApi.posted()).toHaveLength(1);
});

test.describe("shortcuts never fire while typing", () => {
  test("in the comment composer", async ({ page }) => {
    await open(page);
    await press(page, "k");
    await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
    const box = page.getByRole("textbox", { name: "Your comment on line 10" });
    await expect(box).toBeFocused();
    await page.keyboard.type("kjnpaedvbm?/");
    await expect(box).toHaveValue("kjnpaedvbm?/");
    await expect(fileTitle(page)).toHaveText(AUTH);
    await expect(dialog(page)).toHaveCount(0);
    // ⌘/Ctrl+Enter in the composer adds the comment, it does not finish the review.
    await press(page, "ControlOrMeta+Enter");
    await expect(toast(page)).toHaveCount(0);
  });

  test("in a contenteditable element", async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.contentEditable = "true";
      el.id = "editable";
      el.setAttribute("aria-label", "Notes");
      document.querySelector("#main")?.prepend(el);
    });
    await page.locator("#editable").focus();
    await page.keyboard.type("kb");
    await expect(page.locator("#editable")).toHaveText("kb");
    await expect(page.getByRole("heading", { name: "Briefing & change map" })).toBeVisible();
  });
});

test("shortcuts respect modifiers: Ctrl, ⌘ and Alt with a letter do nothing", async ({ page }) => {
  await open(page);
  for (const key of ["Control+k", "Meta+k", "Alt+k", "Control+m", "Alt+m"]) {
    await press(page, key);
  }
  await expect(page.getByRole("heading", { name: "Briefing & change map" })).toBeVisible();
  await expect(fileTitle(page)).toHaveCount(0);
});

test("j on the first file goes back to the briefing; k on the last file stays", async ({
  page,
}) => {
  await open(page);
  await press(page, "k");
  await press(page, "j");
  await expect(page.getByRole("heading", { name: "Briefing & change map" })).toBeVisible();
  // Nine files: seven triaged and two noise files, which open the noise group in the sidebar.
  for (let i = 0; i < 12; i++) await press(page, "k");
  await expect(fileTitle(page)).toHaveText("src/generated/api-types.ts");
  await expect(
    page.locator('#sidebar button.nav-file[title="src/generated/api-types.ts"]'),
  ).toHaveAttribute("aria-current", "page");
});

test("a, e and d act only on the focused draft of the file on screen", async ({
  page,
  reviewApi,
}) => {
  await open(page);
  await press(page, "a");
  await press(page, "e");
  await press(page, "d");
  await press(page, "k");
  await press(page, "a");
  expect(reviewApi.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  // Focused on F1, then moved to another file: F1 is no longer on screen.
  await press(page, "n");
  await expect(card(page, "F1")).toBeFocused();
  await press(page, "k");
  await expect(fileTitle(page)).toHaveText(ROUTES);
  await press(page, "a");
  expect(reviewApi.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
});

test("while a draft is being dismissed or edited, a/e/d leave its focus alone", async ({
  page,
  reviewApi,
}) => {
  await open(page);
  await press(page, "k");
  await press(page, "n");
  await press(page, "d");
  const reason = card(page, "F1").getByRole("button", { name: "Not a real issue" });
  await expect(reason).toBeFocused();
  for (const key of ["a", "e", "d"]) await press(page, key);
  await expect(reason).toBeFocused();
  // Escape still cancels, back to Dismiss.
  await press(page, "Escape");
  await expect(card(page, "F1").getByRole("button", { name: "Dismiss" })).toBeFocused();
  // In the editor, Tab to its Cancel button: a/d do not leave it either.
  await press(page, "e");
  await press(page, "Tab");
  await press(page, "Tab");
  const cancel = card(page, "F1").getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  for (const key of ["a", "d"]) await press(page, key);
  await expect(cancel).toBeFocused();
  expect(reviewApi.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
});

test.describe("the shortcuts dialog", () => {
  test("opens from the top bar, traps focus, and Escape returns focus to the button", async ({
    page,
  }) => {
    await open(page);
    const button = page.getByRole("button", { name: "Keyboard shortcuts" });
    await button.focus();
    await press(page, "Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Close" })).toBeFocused();
    // Tab and Shift+Tab stay inside the dialog.
    for (let i = 0; i < 4; i++) {
      await press(page, "Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
        true,
      );
    }
    for (let i = 0; i < 4; i++) {
      await press(page, "Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
        true,
      );
    }
    // Shortcuts do not fire behind it.
    await press(page, "k");
    await expect(fileTitle(page)).toHaveCount(0);
    await press(page, "Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test("a click outside closes it", async ({ page }) => {
    await open(page);
    await press(page, "?");
    await page.mouse.click(5, 5);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("single-key shortcuts can be turned off and stay off after a reload (WCAG 2.1.4)", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    const toggle = dialog(page).getByRole("switch", { name: "Single-key shortcuts" });
    await expect(toggle).toBeChecked();
    await toggle.press("Space");
    await expect(toggle).not.toBeChecked();
    await press(page, "Escape");
    await expect(page.locator("#review-panel .shortcut-strip")).toContainText(
      "Single-key shortcuts are off",
    );

    await press(page, "k");
    await press(page, "?");
    await expect(fileTitle(page)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    // The key hints go with them.
    await expect(page.locator(".brief-start kbd")).toHaveCount(0);

    await page.reload();
    await reviewReady(page);
    await press(page, "k");
    await expect(fileTitle(page)).toHaveCount(0);
    // ⌘/Ctrl+Enter has a modifier, so it stays on.
    await press(page, "ControlOrMeta+Enter");
    await expect(page.getByRole("dialog", { name: "Finish your review" })).toBeVisible();
    await press(page, "Escape");

    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await dialog(page).getByRole("switch", { name: "Single-key shortcuts" }).check();
    await press(page, "Escape");
    await press(page, "k");
    await expect(fileTitle(page)).toHaveText(AUTH);
  });

  for (const size of WIDTHS) {
    for (const mode of MODES) {
      test(`axe: no serious issues with it open at ${size.width} px ${mode}`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await open(page);
        await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
        await expect(dialog(page)).toBeVisible();
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  }
});

test("shortcuts are off while a drawer is open, and work at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page);
  await page.getByRole("button", { name: "Review panel", exact: true }).click();
  await press(page, "k");
  await expect(fileTitle(page)).toHaveCount(0);
  await press(page, "Escape");
  await press(page, "k");
  await expect(fileTitle(page)).toHaveText(AUTH);
  await press(page, "n");
  expect(await activeFinding(page)).toBe("F1");
});

test("on a diff from a newer push, n and p do nothing (the drafts are hidden)", async ({
  page,
  reviewApi,
}) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/?diff=newer-push");
  await reviewReady(page);
  await press(page, "k");
  await expect(fileTitle(page)).toHaveText(AUTH);
  await expect(page.locator("main")).toContainText("hidden on this diff");
  const before = await page.evaluate(() => document.activeElement?.id);
  for (const key of ["n", "p", "a", "e", "d"]) await press(page, key);
  await expect(fileTitle(page)).toHaveText(AUTH);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(before);
  await expect(page.locator(".f-item.focus")).toHaveCount(0);
  expect(reviewApi.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  // k still walks the files.
  await press(page, "k");
  await expect(fileTitle(page)).toHaveText(ROUTES);
});

test("help opened with nothing focused returns focus to the main column", async ({ page }) => {
  await open(page);
  await press(page, "?");
  await press(page, "Escape");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
});

test("when the browser cannot save the switch, the dialog says so", async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    Storage.prototype.setItem = blocked;
    Storage.prototype.removeItem = blocked;
  });
  await open(page);
  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  await expect(dialog(page)).toContainText("Remembered in this browser.");
  await dialog(page).getByRole("switch", { name: "Single-key shortcuts" }).press("Space");
  await expect(dialog(page)).toContainText(
    "This browser could not save the choice, so it lasts until you reload the page.",
  );
  await expect(dialog(page)).not.toContainText("Remembered in this browser.");
  // It still applies for this page.
  await press(page, "Escape");
  await press(page, "k");
  await expect(fileTitle(page)).toHaveCount(0);
});

test("key hints do not make small buttons taller", async ({ page }) => {
  await open(page);
  await press(page, "k");
  await press(page, "n");
  const height = (role: string) =>
    card(page, "F1")
      .locator(`[data-role="${role}"]`)
      .evaluate((el) => el.getBoundingClientRect().height);
  // "Send to agent" has no hint; Accept, Edit and Dismiss do.
  const plain = await height("agent");
  for (const role of ["accept", "edit", "dismiss"]) expect(await height(role)).toBe(plain);
});

test("the key hints are on the buttons they trigger", async ({ page }) => {
  await open(page);
  await expect(page.locator(".brief-start button")).toHaveAttribute("aria-keyshortcuts", "k");
  await expect(page.locator(".brief-start kbd")).toHaveText("k");
  await press(page, "k");
  await expect(page.locator(".file-head button")).toHaveAttribute("aria-keyshortcuts", "v");
  await press(page, "n");
  for (const [role, key] of [
    ["accept", "a"],
    ["edit", "e"],
    ["dismiss", "d"],
  ] as const) {
    const button = card(page, "F1").locator(`[data-role="${role}"]`);
    await expect(button).toHaveAttribute("aria-keyshortcuts", key);
    await expect(button.locator("kbd")).toHaveText(key);
  }
  // The kbd hint is not part of the button's name.
  await expect(card(page, "F1").getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  await expect(page.locator("#review-panel .shortcut-strip")).toContainText("next/prev file");
});
