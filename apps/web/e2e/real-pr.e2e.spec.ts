import { seriousViolations } from "./axe.js";
import { openFile } from "./diff-support.js";
import { openInboxApi } from "./inbox-support.js";
import {
  mockPullApi,
  openRealPr,
  REAL_PR_API,
  REAL_PR_DIFF_API,
  REAL_PR_PATH,
  serverDiffData,
  serverShellData,
  type Answer,
} from "./real-pr-support.js";
import { PR_847_ANALYSIS, PR_847_PULL_REQUEST } from "./review-api.js";
import { expect, test, type Page } from "./test.js";

/**
 * H4-2 acceptance (e2e): a real PR address loads the PR from the server (answered here, in the
 * server's shape); the inbox reads the server by default and its rows open that address; the
 * page explains loading, signed out (sign in, then back here), not found and "repository access
 * isn't available yet", and renders every analysis state the briefing has from server data.
 * The fixtures stay behind explicit switches (`/?fixture=pr-847`, `/inbox?source=fixture`).
 * H4-3: the diff comes from the server too, so drafts, own comments and Finish review work on
 * a real PR; every state the diff endpoint can answer has its fixed text.
 */

const FILE = "src/auth/invitations.ts";
const card = (page: Page, id: string) => page.locator(`[data-finding="${id}"]`);

/** The drafts API has answered: the panel's tally only renders then. */
const reviewReady = (page: Page) =>
  page.locator("#review-panel .tally").waitFor({ state: "attached" });

/** Scrolls the main column until the (virtualised) draft card is rendered, then shows it. */
const showCard = async (page: Page, id: string) => {
  for (let i = 0; i < 30 && (await card(page, id).count()) === 0; i++) {
    await page.locator("#main").evaluate((main) => main.scrollBy({ top: 400 }));
  }
  await card(page, id).scrollIntoViewIfNeeded();
};

/** Opens the file without waiting for diff lines (the diff may be in another state). */
const openFileHead = async (page: Page) => {
  const width = page.viewportSize()?.width ?? 1440;
  if (width <= 760) await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.locator(`#sidebar button.nav-file[title="${FILE}"]`).click();
  await page.locator(".file-head").waitFor();
};

test.describe("a real PR address reads the server", () => {
  test("loads pr-847 from the server: briefing, top bar without what the mirror lacks", async ({
    page,
  }) => {
    const api = await mockPullApi(page);
    await openRealPr(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Team invitations with expiring links",
    );
    await expect(page.locator("#briefing-title")).toBeVisible();
    // StrictMode loads twice in development; every request is the one GET.
    expect(new Set(api.requests.map((r) => `${r.method()} ${new URL(r.url()).pathname}`))).toEqual(
      new Set([`GET ${REAL_PR_API}`]),
    );
    const bar = page.locator("header.topbar");
    await expect(bar).toContainText("acme/rocky-app");
    await expect(bar).toContainText("+215 −3 · 9 files");
    await expect(bar).not.toContainText("wants to merge");
    await expect(bar).not.toContainText("approval");
  });

  test("drafts and posting use the server's ids: Finish review posts a stored decision", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: true, body: "Expire the link after use." });
    await mockPullApi(page);
    await openRealPr(page);
    await page.locator("#review-panel .tally").waitFor({ state: "attached" });
    await page.getByRole("button", { name: /^Finish review/ }).click();
    const dialog = page.getByRole("dialog", { name: "Finish your review" });
    await expect(dialog.getByRole("heading", { name: /Will be posted to GitHub/ })).toBeVisible();
    const submit = dialog.getByRole("button", { name: /Submit review/ });
    await expect(submit).toHaveAttribute("data-armed", "true");
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(reviewApi.posted()).toHaveLength(1);
    expect(reviewApi.requests).toContain(`GET /api/analyses/${PR_847_ANALYSIS}/review`);
    expect(reviewApi.requests).toContain(`POST /api/pull-requests/${PR_847_PULL_REQUEST}/review`);
  });

  test("H4-3: opening a file reads the diff from the server once and shows its lines", async ({
    page,
  }) => {
    const api = await mockPullApi(page);
    await openRealPr(page);
    await openFile(page, FILE);
    await expect(page.locator(".diff .ln").first()).toBeVisible();
    await expect(page.locator("#main")).toContainText("INVITE_TTL_MS");
    // StrictMode loads twice in development; every request is one of the two GETs.
    expect(new Set(api.requests.map((r) => `${r.method()} ${new URL(r.url()).pathname}`))).toEqual(
      new Set([`GET ${REAL_PR_API}`, `GET ${REAL_PR_DIFF_API}`]),
    );
    expect(api.requests.every((r) => r.headers()["accept"] === "application/json")).toBe(true);
  });

  test("the status pill shows the review the server says the person posted", async ({ page }) => {
    await mockPullApi(page, { status: 200, body: serverShellData({ myReview: "approved" }) });
    await openRealPr(page);
    await expect(page.locator(".status-pill")).toHaveText("Approved");
  });

  test("every analysis state the briefing renders, from server data", async ({ page }) => {
    const states: [Record<string, unknown>, string][] = [
      [{ analysis: null, analysisId: null, analysisRun: { status: "none" } }, "No analysis yet"],
      [
        { analysis: null, analysisId: null, analysisRun: { status: "queued" } },
        "Queued for analysis",
      ],
      [
        { analysis: null, analysisId: null, analysisRun: { status: "running" } },
        "Analysing this pull request",
      ],
      [
        {
          analysis: null,
          analysisId: null,
          analysisRun: {
            status: "awaiting_approval",
            estimatedTokens: 210000,
            limitTokens: 150000,
          },
        },
        "Waiting for approval",
      ],
      [
        {
          analysis: null,
          analysisId: null,
          analysisRun: { status: "failed", code: "provider_error" },
        },
        "Code: provider_error",
      ],
      [
        {
          analysis: null,
          analysisId: null,
          analysisRun: { status: "failed", code: "superseded" },
        },
        "Analysis out of date",
      ],
    ];
    let current: Record<string, unknown> = {};
    await mockPullApi(page, () => ({ status: 200, body: serverShellData(current) }));
    for (const [overrides, text] of states) {
      current = overrides;
      await openRealPr(page);
      await expect(page.locator("#main"), text).toContainText(text);
    }
  });

  test("an older push's document is shown out of date while the head is analysed", async ({
    page,
  }) => {
    const pull = serverShellData().pull;
    await mockPullApi(page, {
      status: 200,
      body: serverShellData({
        pull: { ...pull, headSha: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d" },
        analysisRun: { status: "running" },
      }),
    });
    await openRealPr(page);
    await expect(page.locator("#main")).toContainText("1c2d3e4");
  });
});

test.describe("H4-3: reviewing a real PR end to end", () => {
  test("accept, edit and dismiss drafts, add an own comment, then Finish review posts them", async ({
    page,
    reviewApi,
  }) => {
    await mockPullApi(page);
    await openRealPr(page);
    await reviewReady(page);
    await openFile(page, FILE);

    await showCard(page, "F1");
    await card(page, "F1").getByRole("button", { name: "Accept", exact: true }).click();
    await expect(card(page, "F1")).toContainText(/Pending\s*· from AI draft/);
    await expect.poll(() => reviewApi.decision("F1").state).toBe("accepted");

    await showCard(page, "F3");
    await card(page, "F3").getByRole("button", { name: "Edit" }).click();
    const box = page.getByRole("textbox", { name: "Your comment, edited from the AI draft" });
    await box.fill("Please check the role before adding the membership.");
    await card(page, "F3").getByRole("button", { name: "Save as my comment" }).click();
    await expect
      .poll(() => reviewApi.decision("F3"))
      .toEqual({
        state: "accepted",
        edited: true,
        body: "Please check the role before adding the membership.",
      });

    await showCard(page, "F8");
    await card(page, "F8").getByRole("button", { name: "Dismiss" }).click();
    await card(page, "F8")
      .getByRole("group", { name: /Why\?/ })
      .getByRole("button", { name: "Intentional" })
      .click();
    await expect
      .poll(() => reviewApi.decision("F8"))
      .toEqual({
        state: "dismissed",
        reason: "intentional",
      });

    await page.locator("#main").evaluate((main) => main.scrollTo({ top: 0 }));
    await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
    await page.getByRole("textbox", { name: "Your comment on line 10" }).fill("TTL from config?");
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect.poll(() => reviewApi.comments().length).toBe(1);

    await page.getByRole("button", { name: /^Finish review/ }).click();
    const dialog = page.getByRole("dialog", { name: "Finish your review" });
    await expect(dialog.getByRole("heading", { name: /Will be posted to GitHub/ })).toBeVisible();
    await expect(dialog.locator(".post-list > li")).toHaveCount(3);
    const submit = dialog.getByRole("button", { name: /Submit review/ });
    await expect(submit).toHaveAttribute("data-armed", "true");
    await submit.click();
    await expect(dialog).toHaveCount(0);
    const posted = reviewApi.posted();
    expect(posted).toHaveLength(1);
    // Accepted drafts in finding order (F1 at line 28, F3 at 23), then the own comment.
    expect(posted[0]?.comments.map((c) => [c.path, c.line])).toEqual([
      [FILE, 28],
      [FILE, 23],
      [FILE, 10],
    ]);
    expect(reviewApi.requests).toContain(`POST /api/pull-requests/${PR_847_PULL_REQUEST}/review`);
  });

  test("a truncated diff says so on the file and still takes decisions", async ({
    page,
    reviewApi,
  }) => {
    await mockPullApi(page, undefined, {
      status: 200,
      body: serverDiffData({ truncation: "max_bytes" }),
    });
    await openRealPr(page);
    await reviewReady(page);
    await openFile(page, FILE);
    await expect(page.locator(".diff-status[role='note']")).toContainText(
      "only its first part is shown",
    );
    await showCard(page, "F1");
    await card(page, "F1").getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(() => reviewApi.decision("F1").state).toBe("accepted");
  });

  test("every state the diff endpoint can answer, with fixed text and no content", async ({
    page,
  }) => {
    let diff: Answer = { status: 200, body: serverDiffData() };
    await mockPullApi(page, undefined, () => diff);
    const states: [Answer, string][] = [
      [{ status: 404, body: { error: "not_found" } }, "This diff isn’t available"],
      [{ status: 409, body: { error: "head_moved" } }, "changed on GitHub since Rocky last saw it"],
      [{ status: 413, body: { error: "diff_too_large" } }, "GitHub won’t render a diff this large"],
      [
        { status: 503, body: { error: "access_check_unavailable" } },
        "Repository access isn’t available yet",
      ],
      [{ status: 502, body: { error: "forge_unavailable" } }, "GitHub didn’t answer"],
      [{ status: 429, body: { error: "rate_limited" } }, "Too many diff requests"],
      [{ status: 401, body: { error: "unauthenticated" } }, "Your session ended"],
      // An answer that fails validation: a plain failure, showing none of it.
      [{ status: 200, body: { headSha: "Zebra", diff: "Zebra" } }, "The diff could not be loaded."],
    ];
    for (const [answer, text] of states) {
      diff = answer;
      await openRealPr(page);
      await openFileHead(page);
      const status = page.locator(".diff-status");
      await expect(status, text).toContainText(text);
      await expect(status, text).toHaveAttribute("role", "alert");
      await expect(page.locator("#main"), text).not.toContainText("Zebra");
    }
    // The too-large state links to the whole diff on GitHub, reachable by keyboard.
    diff = { status: 413, body: { error: "diff_too_large" } };
    await openRealPr(page);
    await openFileHead(page);
    const link = page.getByRole("link", { name: "Read it on GitHub" });
    await expect(link).toHaveAttribute("href", "https://github.com/acme/rocky-app/pull/847/files");
    await page.locator("#file-title").focus();
    for (let i = 0; i < 12 && !(await link.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(link).toBeFocused();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("loading: a status until the server answers the diff", async ({ page }) => {
    const api = await mockPullApi(page);
    await openRealPr(page);
    const release = api.hold();
    await openFileHead(page);
    await expect(page.locator(".diff-status")).toHaveText("Loading the diff…");
    release();
    await expect(page.locator(".diff .ln").first()).toBeVisible();
  });
});

test.describe("when the PR cannot be shown", () => {
  test("loading: a status until the server answers", async ({ page }) => {
    const api = await mockPullApi(page);
    const release = api.hold();
    await openRealPr(page);
    await expect(page.getByRole("status")).toHaveText("Loading…");
    release();
    await expect(page.locator("#briefing-title")).toBeVisible();
  });

  test("signed out: Sign in with GitHub comes back to this PR, by keyboard too", async ({
    page,
  }) => {
    await mockPullApi(page, { status: 401, body: { error: "unauthenticated" } });
    await openRealPr(page);
    const link = page.getByRole("link", { name: "Sign in with GitHub" });
    await expect(link).toHaveAttribute(
      "href",
      `/auth/github/login?returnTo=${encodeURIComponent(REAL_PR_PATH)}`,
    );
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("not found: a fixed explanation and the way back to the inbox", async ({ page }) => {
    await mockPullApi(page, { status: 404, body: { error: "not_found" } });
    await openRealPr(page);
    await expect(page.getByRole("alert")).toContainText("This pull request isn’t in Rocky");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Go to your inbox" })).toBeFocused();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("503: repository access isn't available yet", async ({ page }) => {
    await mockPullApi(page, { status: 503, body: { error: "access_check_unavailable" } });
    await openRealPr(page);
    await expect(page.getByRole("alert")).toContainText("Repository access isn’t available yet");
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("an answer that fails validation is a plain failure, showing none of it", async ({
    page,
  }) => {
    await mockPullApi(page, {
      status: 200,
      body: serverShellData({ pull: { ...serverShellData().pull, title: "" } }),
    });
    await openRealPr(page);
    await expect(page.getByRole("alert")).toHaveText("This pull request could not be loaded.");
  });

  test("an address that cannot name a PR never asks the server", async ({ page }) => {
    const api = await mockPullApi(page);
    await page.goto("/acme/rocky-app/pull/0");
    await expect(page.locator("#main")).toContainText("There is no page at this address.");
    expect(api.requests).toEqual([]);
  });
});

test.describe("inbox and fixtures", () => {
  test("the inbox reads the server by default, and its rows open the real PR address", async ({
    page,
  }) => {
    const pulls = await mockPullApi(page);
    await openInboxApi(page);
    await page
      .getByRole("region", { name: /Needs your review/ })
      .getByRole("link", { name: "Team invitations with expiring links" })
      .click();
    await expect(page).toHaveURL(REAL_PR_PATH);
    await expect(page.locator("#briefing-title")).toBeVisible();
    expect(new Set(pulls.requests.map((r) => new URL(r.url()).pathname))).toEqual(
      new Set([REAL_PR_API]),
    );
  });

  test("`/` goes to the inbox; the fixtures need their explicit switch", async ({ page }) => {
    const pulls = await mockPullApi(page);
    await page.route("**/api/inbox", (route) => route.fulfill({ status: 401, json: {} }));
    await page.goto("/");
    await expect(page).toHaveURL(/\/inbox$/);
    await page.goto("/?fixture=pr-847");
    await expect(page.locator("#briefing-title")).toBeVisible();
    await page.goto("/inbox?source=fixture");
    await page.locator("#inbox-title").waitFor();
    expect(pulls.requests).toEqual([]);
  });
});
