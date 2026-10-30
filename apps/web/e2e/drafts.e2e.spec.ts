import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "./test.js";
import { openFile } from "./diff-support.js";
import { MODES, openShell, WIDTHS } from "./support.js";
import pr847 from "../../../packages/schema/fixtures/pr-847.json" with { type: "json" };

/**
 * P6-4 acceptance criteria: "all transitions tested; refresh keeps state". Every transition is
 * made through the UI, read back from the drafts API after a reload (the page keeps nothing
 * itself), and undone. Also the keyboard path, the review panel, toasts, failures and axe.
 */

const FILE = "src/auth/invitations.ts";
const byId = (id: string) => {
  const found = pr847.findings.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no finding ${id}`);
  return found;
};
const F1 = byId("F1");
const card = (page: Page, id = "F1") => page.locator(`[data-finding="${id}"]`);
const toast = (page: Page) => page.locator(".toast");

/** The drafts API has answered: the panel's tally only renders then. */
const reviewReady = (page: Page) =>
  page.locator("#review-panel .tally").waitFor({ state: "attached" });

/** Scrolls the main column until the (virtualised) draft card is rendered, then shows it. */
const showCard = async (page: Page, id = "F1") => {
  for (let i = 0; i < 30 && (await card(page, id).count()) === 0; i++) {
    await page.locator("#main").evaluate((main) => main.scrollBy({ top: 400 }));
  }
  await card(page, id).scrollIntoViewIfNeeded();
};

/** A reload, as the reviewer would do it, back on the file. */
const reload = async (page: Page) => {
  await page.reload();
  await page.locator("header.topbar").waitFor();
  await reviewReady(page);
  await openFile(page, FILE);
  await showCard(page);
};

const open = async (page: Page) => {
  await openShell(page);
  await reviewReady(page);
  await openFile(page, FILE);
  await showCard(page);
};

const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

test.describe("every transition, and a refresh keeps it", () => {
  test("accept → refresh → accepted → undo → refresh → draft", async ({ page, reviewApi }) => {
    await open(page);
    await expect(card(page)).toContainText("Only you can see this until you accept it");
    await card(page).getByRole("button", { name: "Accept", exact: true }).click();
    await expect(toast(page)).toHaveText("Added to your pending review. Not posted yet.");
    await expect(card(page)).toContainText(/Pending\s*· from AI draft/);
    await expect.poll(() => reviewApi.decision("F1").state).toBe("accepted");

    await reload(page);
    await expect(card(page)).toContainText(/Pending\s*· from AI draft/);
    await expect(card(page)).toContainText(F1.title);

    await card(page).getByRole("button", { name: "Undo" }).click();
    await expect(card(page).getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    await expect.poll(() => reviewApi.decision("F1").state).toBe("draft");
    await reload(page);
    await expect(card(page).getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  });

  test("edit → save → refresh keeps the reviewer's text, marked edited", async ({
    page,
    reviewApi,
  }) => {
    await open(page);
    await card(page).getByRole("button", { name: "Edit" }).click();
    const box = page.getByRole("textbox", { name: "Your comment, edited from the AI draft" });
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(F1.body);
    await box.fill("Please always use `invite.role` here.");
    await card(page).getByRole("button", { name: "Save as my comment" }).click();
    await expect(card(page)).toContainText(/Pending\s*· edited from AI draft/);
    await expect(card(page).locator(".mine-body code")).toHaveText("invite.role");
    expect(reviewApi.decision("F1")).toEqual({
      state: "accepted",
      edited: true,
      body: "Please always use `invite.role` here.",
    });

    await reload(page);
    await expect(card(page)).toContainText("edited from AI draft");
    await expect(card(page)).toContainText("Please always use invite.role here.");
    await card(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => reviewApi.decision("F1").state).toBe("draft");
  });

  test("edit → cancel changes nothing; an emptied edit cannot be saved", async ({
    page,
    reviewApi,
  }) => {
    await open(page);
    await card(page).getByRole("button", { name: "Edit" }).click();
    const box = page.getByRole("textbox", { name: "Your comment, edited from the AI draft" });
    await box.fill("   ");
    await expect(card(page).getByRole("button", { name: "Save as my comment" })).toBeDisabled();
    await box.press("Escape");
    await expect(card(page).getByRole("button", { name: "Edit" })).toBeFocused();
    expect(reviewApi.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  test("dismiss with a reason → refresh shows it collapsed with the reason → undo", async ({
    page,
    reviewApi,
  }) => {
    await open(page);
    await card(page).getByRole("button", { name: "Dismiss" }).click();
    const reasons = card(page).getByRole("group", { name: /Why\?/ });
    await expect(reasons.getByRole("button")).toHaveText([
      "Not a real issue",
      "Intentional",
      "Not worth it here",
      "Already handled elsewhere",
      "Cancel",
    ]);
    await reasons.getByRole("button", { name: "Intentional" }).click();
    await expect(card(page)).toHaveText(`AI draftdismissed · ${F1.title} (Intentional)Undo`);
    expect(reviewApi.decision("F1")).toEqual({ state: "dismissed", reason: "intentional" });
    // A dismissed draft no longer marks its line.
    await expect(page.locator(".ln.hot-critical")).toHaveCount(0);

    await reload(page);
    await expect(card(page)).toContainText("(Intentional)");
    await expect(page.locator("#review-panel .learn")).toContainText(
      "Rocky keeps the reason for 1 dismissal",
    );
    await card(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => reviewApi.decision("F1").state).toBe("draft");
    await reload(page);
    await expect(card(page).getByRole("button", { name: "Dismiss" })).toBeVisible();
  });

  test("send to agent copies the fix prompt, says so, and a refresh still shows it", async ({
    page,
    context,
    reviewApi,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page);
    await card(page).getByRole("button", { name: "Send to agent" }).click();
    await expect(toast(page)).toHaveText("Fix prompt copied. Paste it into your coding agent.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(F1.agentPrompt);
    await expect(card(page)).toContainText("✓ Fix prompt copied");
    // Still undecided: it is not a decision.
    expect(reviewApi.decision("F1")).toEqual({ state: "draft" });
    await reload(page);
    await expect(card(page)).toContainText("✓ Fix prompt copied");
  });

  test("own comments: add → refresh lists it on its line and in the panel → delete → refresh", async ({
    page,
    reviewApi,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
    await page.getByRole("textbox", { name: "Your comment on line 10" }).fill("TTL from config?");
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect.poll(() => reviewApi.comments().length).toBe(1);

    await reload(page);
    await expect(page.locator(".diff .mine-body", { hasText: "TTL from config?" })).toBeVisible();
    await expect(page.locator("#review-panel #own-comments")).toBeAttached();
    await page.getByRole("button", { name: "Delete your comment on line 10" }).click();
    await expect.poll(() => reviewApi.comments().length).toBe(0);
    await reload(page);
    await expect(page.locator(".diff .mine-body")).toHaveCount(0);
  });
});

test.describe("before the reviewer's decisions are loaded", () => {
  test("drafts and lines are read-only until they load, then work", async ({ page, reviewApi }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: F1.body });
    const release = reviewApi.holdLoads();
    await openShell(page);
    await openFile(page, FILE);
    await showCard(page, "F3");
    // An Accept here would be overwritten by the stored decisions once they arrive.
    await expect(card(page, "F3")).toContainText("Loading your decisions…");
    await expect(card(page, "F3").getByRole("button", { name: "Accept", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Line 10", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.getByRole("button", { name: "Line 10", exact: true }).click({ force: true });
    await expect(page.getByRole("textbox", { name: "Your comment on line 10" })).toHaveCount(0);

    release();
    await reviewReady(page);
    await showCard(page);
    await expect(card(page)).toContainText(/Pending\s*· from AI draft/);
    await showCard(page, "F3");
    await card(page, "F3").getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(() => reviewApi.decision("F3").state).toBe("accepted");
    expect(reviewApi.decision("F1").state).toBe("accepted");
  });

  test("when they cannot be loaded, drafts stay read-only and say so", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.failLoads();
    await openShell(page);
    await expect(page.locator("#review-panel")).toContainText(
      "Your drafts and comments could not be loaded.",
    );
    await openFile(page, FILE);
    await showCard(page);
    await expect(card(page)).toContainText("Your decisions could not be loaded");
    await expect(card(page).getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    expect(reviewApi.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe("when things go wrong", () => {
  test("a failed save puts the draft back and says so", async ({ page, reviewApi }) => {
    await open(page);
    reviewApi.failNext(1);
    await card(page).getByRole("button", { name: "Accept", exact: true }).click();
    await expect(toast(page)).toHaveText("Your decision could not be saved. Try again.");
    await expect(card(page).getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    expect(reviewApi.decision("F1")).toEqual({ state: "draft" });
  });

  test("a decision made in another tab wins: the page shows it", async ({ page, reviewApi }) => {
    await open(page);
    reviewApi.set("F1", { state: "dismissed", reason: "not_worth_it" });
    await card(page).getByRole("button", { name: "Accept", exact: true }).click();
    await expect(toast(page)).toHaveText(
      "This draft was decided in another tab. It now shows that decision.",
    );
    await expect(card(page)).toContainText("(Not worth it here)");
  });

  test("a comment the server refuses opens the composer again with the text", async ({
    page,
    reviewApi,
  }) => {
    await open(page);
    reviewApi.failNext(1);
    await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
    await page.getByRole("textbox", { name: "Your comment on line 10" }).fill("Keep me");
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect(toast(page)).toHaveText("Your comment could not be saved. Try again.");
    await expect(page.getByRole("textbox", { name: "Your comment on line 10" })).toHaveValue(
      "Keep me",
    );
  });

  test("state changes carry the CSRF token from the session", async ({ page, reviewApi }) => {
    await open(page);
    await card(page).getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(() => reviewApi.decision("F1").state).toBe("accepted");
    expect(reviewApi.requests).toContain("GET /api/session");
  });
});

test.describe("keyboard", () => {
  test("decide, undo, dismiss and edit a draft without the mouse; focus never drops", async ({
    page,
    reviewApi,
  }) => {
    await open(page);
    const accept = card(page).getByRole("button", { name: "Accept", exact: true });
    await accept.focus();
    await page.keyboard.press("Enter");
    const undo = card(page).getByRole("button", { name: "Undo" });
    await expect(undo).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card(page).getByRole("button", { name: "Accept", exact: true })).toBeFocused();

    // Tab to Dismiss, Enter opens the reasons with the first one focused; Escape cancels.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(card(page).getByRole("button", { name: "Dismiss" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card(page).getByRole("button", { name: "Not a real issue" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card(page).getByRole("button", { name: "Dismiss" })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(card(page).getByRole("button", { name: "Undo" })).toBeFocused();
    expect(reviewApi.decision("F1")).toEqual({ state: "dismissed", reason: "intentional" });
    await page.keyboard.press("Enter");

    // Edit: the textarea takes focus; ⌘/Ctrl+Enter saves and focus lands on Undo.
    await card(page).getByRole("button", { name: "Edit" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type(" Thanks.");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(card(page).getByRole("button", { name: "Undo" })).toBeFocused();
    await expect.poll(() => reviewApi.decision("F1").state).toBe("accepted");
  });
});

test.describe("review panel", () => {
  test("tallies the drafts and moves decided ones; the sidebar dot fades", async ({ page }) => {
    await open(page);
    const panel = page.locator("#review-panel");
    await expect(panel.locator(".panel-title")).toHaveText("Review · 10 AI drafts to decide");
    const dot = page
      .locator('#sidebar button.nav-file[title="src/auth/invitations.ts"] .dot')
      .first();
    await expect(dot).not.toHaveClass(/done/);
    await card(page).getByRole("button", { name: "Accept", exact: true }).click();
    await expect(panel.locator(".panel-title")).toHaveText("Review · 9 AI drafts to decide");
    await expect(panel.locator(".tally")).toHaveText(
      "AI drafts to decide9Your comments1Dismissed0",
    );
    await expect(panel.locator("#decided + ul")).toContainText(F1.title);
    await expect(dot).toHaveClass(/done/);
  });

  test("an item jumps to its draft in another file, which takes the focus ring", async ({
    page,
  }) => {
    await open(page);
    const F4 = byId("F4");
    await page
      .locator("#review-panel")
      .getByRole("button", { name: new RegExp(F4.title) })
      .click();
    await expect(page.locator("#file-title")).toHaveText(F4.path);
    await expect(card(page, "F4")).toBeFocused();
    await expect(card(page, "F4")).toHaveClass(/focus/);
  });

  for (const width of [1024, 375]) {
    test(`at ${width} px the panel is a drawer; a jump closes it and focuses the draft`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openShell(page);
      await reviewReady(page);
      await page.getByRole("button", { name: "Review panel" }).click();
      const drawer = page.getByRole("dialog", { name: "Review panel" });
      await drawer.getByRole("button", { name: new RegExp(F1.title) }).click();
      await expect(drawer).toBeHidden();
      await expect(card(page)).toBeFocused();
    });
  }

  test("trusting the noise says so in a toast", async ({ page }) => {
    await openShell(page);
    await page.locator("#sidebar").getByRole("button", { name: "Trust & mark viewed" }).click();
    await expect(toast(page)).toHaveText("2 noise files marked viewed from the AI summary");
  });
});

test.describe("axe", () => {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      test(`drafts in every state: no serious issues at ${size.width} px ${mode}`, async ({
        page,
        reviewApi,
      }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        reviewApi.set("F3", { state: "dismissed", reason: "intentional" });
        await open(page);
        // F1 accepted, F3 dismissed, F8 open for dismissing; the panel shows all three groups.
        await card(page).getByRole("button", { name: "Accept", exact: true }).click();
        // The toast fades in; axe measures its contrast once it is fully shown.
        await toast(page).evaluate((el) =>
          Promise.all(el.getAnimations().map((animation) => animation.finished)),
        );
        await showCard(page, "F8");
        await card(page, "F8").getByRole("button", { name: "Dismiss" }).click();
        await expect(card(page, "F8").getByRole("group")).toBeVisible();
        expect(await seriousViolations(page)).toEqual([]);
        await card(page, "F8").getByRole("button", { name: "Cancel" }).click();
        await card(page, "F8").getByRole("button", { name: "Edit" }).click();
        expect(await seriousViolations(page)).toEqual([]);
        if (size.width <= 1180) {
          await page.getByRole("button", { name: "Review panel" }).click();
          expect(await seriousViolations(page)).toEqual([]);
        }
      });
    }
  }
});
