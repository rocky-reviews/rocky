import { seriousViolations } from "./axe.js";
import { openInboxApi } from "./inbox-support.js";
import {
  mockPullApi,
  openRealPr,
  REAL_PR_API,
  REAL_PR_PATH,
  serverShellData,
} from "./real-pr-support.js";
import { PR_847_ANALYSIS, PR_847_PULL_REQUEST } from "./review-api.js";
import { expect, test } from "./test.js";

/**
 * H4-2 acceptance (e2e): a real PR address loads the PR from the server (answered here, in the
 * server's shape); the inbox reads the server by default and its rows open that address; the
 * page explains loading, signed out (sign in, then back here), not found and "repository access
 * isn't available yet", and renders every analysis state the briefing has from server data.
 * The fixtures stay behind explicit switches (`/?fixture=pr-847`, `/inbox?source=fixture`).
 */

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

  test("the server does not serve diffs yet: a file says so instead of showing a fixture", async ({
    page,
  }) => {
    await mockPullApi(page);
    await openRealPr(page);
    await page.getByRole("button", { name: "Open src/auth/invitations.ts" }).first().click();
    await expect(page.locator(".diff-status")).toHaveText("The diff could not be loaded.");
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
