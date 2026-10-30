import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "./test.js";
import { openFile } from "./diff-support.js";
import { FIXTURE_NOW, MODES, openShell, WIDTHS } from "./support.js";
import { ME, PR_847_HEAD } from "./review-api.js";

/**
 * P6-6 acceptance criteria (ADR 0031): "what's shown == what's posted" and "double-submit
 * impossible", through the real page against the mocked posting API (`review-api.ts`), which
 * builds the plan and checks the click like the server (core `composePostedComment`,
 * `canonicalReviewPlan`, digest and head). The server's own side of the criterion is
 * `apps/server/src/reviews/post-review.db.test.ts` "posts exactly the previewed items…".
 *
 * Also: the warnings, the suggestion and the drafted summary are suggestions only; every
 * refusal and failure is shown honestly and posts nothing; posted items become read-only;
 * nothing posts without the click; axe finds no serious issue with the modal open.
 */

const AUTH = "src/auth/invitations.ts";
const HOSTILE =
  "Use `invite.role` @admin see https://evil.example/x <img src=x onerror=alert(1)> [click](https://evil.example)\n\n```suggestion\nrole: invite.role,\n```";
/** A bidi override and a zero-width space inside the person's own words. */
const BIDI = "Looks \u202Eevil\u202C fine\u200B.";
/** Longer than the list box: the box scrolls and must be focusable (axe). */
const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long comment`).join("\n");

const card = (page: Page, id: string) => page.locator(`[data-finding="${id}"]`);
const toast = (page: Page) => page.locator(".toast");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Finish your review" });
const finishButton = (page: Page) => page.getByRole("button", { name: /^Finish review/ });
const submitButton = (page: Page) =>
  dialog(page).getByRole("button", { name: /Submit review|Submitting/ });
const statusPill = (page: Page) => page.locator(".topbar .status-pill");
const posts = (api: { requests: string[] }) =>
  api.requests.filter(
    (r) => r === "POST /api/pull-requests/00000000-0000-4000-8001-000000000847/review",
  );

const reviewReady = (page: Page) =>
  page.locator("#review-panel .tally").waitFor({ state: "attached" });

const showCard = async (page: Page, id = "F1") => {
  for (let i = 0; i < 30 && (await card(page, id).count()) === 0; i++) {
    await page.locator("#main").evaluate((main) => main.scrollBy({ top: 400 }));
  }
  await card(page, id).scrollIntoViewIfNeeded();
};

const open = async (page: Page) => {
  await openShell(page);
  await reviewReady(page);
};

/** Opens the modal from the top bar and waits for the list. */
const openFinish = async (page: Page) => {
  await finishButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByRole("heading", { name: /Will be posted to GitHub/ }),
  ).toBeVisible();
  await expect(dialog(page)).not.toContainText("Loading what will be posted");
};

/** Waits until Submit is armed (it ignores clicks for a moment after the modal opens). */
const armed = async (page: Page) => {
  await expect(submitButton(page)).toHaveAttribute("data-armed", "true");
};

/** The list as the modal shows it: location, kind and the body text of every item. */
const shownItems = (page: Page) =>
  dialog(page)
    .locator(".post-list > li")
    .evaluateAll((items) =>
      items.map((li) => ({
        kind: li.getAttribute("data-item-kind"),
        loc: li.querySelector(".post-loc")?.textContent ?? "",
        body: li.querySelector(".post-raw")?.textContent ?? "",
      })),
    );

const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

test.describe("what's shown is what's posted (acceptance criterion)", () => {
  test("the modal lists exactly the server's plan, as Markdown source, and the click posts exactly it", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    reviewApi.set("F2", { state: "accepted", edited: true, body: HOSTILE });
    reviewApi.set("F3", { state: "dismissed", reason: "intentional" });
    await open(page);
    await openFile(page, AUTH);
    await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Your comment on line 10" })
      .fill("TTL from config? @admin");
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect(finishButton(page)).toContainText("3");

    await openFinish(page);
    await expect(dialog(page)).toContainText(`Will be posted to GitHub as @${ME.login} (3)`);
    const plan = reviewApi.plan();
    expect(plan.items).toHaveLength(3);
    const shown = await shownItems(page);
    expect(shown).toEqual(
      plan.items.map((item) => ({
        kind: item.kind,
        loc: `${item.path}:${item.startLine === null ? item.line : `${item.startLine}–${item.line}`}`,
        body: item.body,
      })),
    );
    // Model text is shown as its Markdown source: the mention, the link's target, the image and
    // the suggestion fence are all visible, and none of it became an element.
    const list = dialog(page).locator(".post-list");
    await expect(list).toContainText(
      "@admin see https://evil.example/x <img src=x onerror=alert(1)> [click](https://evil.example)",
    );
    await expect(list).toContainText("```suggestion");
    await expect(list.locator("a, img, script")).toHaveCount(0);
    await expect(dialog(page)).toContainText("exactly as GitHub will receive it");

    // Request changes is suggested and pre-selected: F1 is critical.
    const request = dialog(page).getByRole("radio", { name: /Request changes/ });
    await expect(request).toBeChecked();
    await expect(dialog(page)).toContainText(
      "Suggested because you accepted a critical or high finding.",
    );
    await armed(page);
    expect(posts(reviewApi)).toEqual([]);
    await submitButton(page).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page)).toHaveText(`Review submitted to GitHub as @${ME.login}.`);
    await expect(statusPill(page)).toHaveText("Changes requested");
    expect(reviewApi.posted()).toHaveLength(1);
    const review = reviewApi.posted()[0];
    if (review === undefined) throw new Error("nothing posted");
    expect(review.verdict).toBe("request_changes");
    expect(review.headSha).toBe(PR_847_HEAD);
    expect(review.comments).toEqual(
      plan.items.map((i) => ({ path: i.path, line: i.line, startLine: i.startLine, body: i.body })),
    );
    expect(reviewApi.submissions()[0]?.contentSha256).toBe(plan.contentSha256);

    // Posted items are read-only now, and stay so after a reload.
    await expect(finishButton(page)).toContainText("0");
    await showCard(page, "F1");
    await expect(card(page, "F1")).toContainText("Posted");
    await expect(card(page, "F1").getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete your comment on line 10" })).toHaveCount(
      0,
    );
    await expect(page.locator("#review-panel")).toContainText("posted");
    await page.reload();
    await reviewReady(page);
    await expect(finishButton(page)).toContainText("0");
    await expect(statusPill(page)).toHaveText("Changes requested");
    await openFile(page, AUTH);
    await showCard(page, "F1");
    await expect(card(page, "F1")).toContainText("Posted");
    await expect(card(page, "F1").getByRole("button", { name: "Undo" })).toHaveCount(0);

    // Opening Finish again: the posted items are not offered again.
    await openFinish(page);
    await expect(dialog(page)).toContainText("Will be posted to GitHub as @dana-k (0)");
    await expect(dialog(page)).toContainText(
      "You already posted a review from Rocky (Request changes with 3 inline comments",
    );
    await expect(dialog(page)).toContainText("No inline comments.");
  });

  test("a list that changed after the preview is refused and loaded again; new commits too", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await expect(dialog(page).locator(".post-list > li")).toHaveCount(1);
    // Another tab accepts F2 meanwhile: the digest the modal holds is stale.
    reviewApi.set("F2", { state: "accepted", edited: false, body: "y" });
    await armed(page);
    await submitButton(page).click();
    const notice = dialog(page).getByRole("alert");
    await expect(notice).toContainText("Nothing was posted. The list was loaded again");
    await expect(notice).toBeFocused();
    await expect(dialog(page).locator(".post-list > li")).toHaveCount(2);
    expect(reviewApi.posted()).toEqual([]);
    await expect(toast(page)).toHaveCount(0);

    // New commits: head moved. A fresh key per click.
    reviewApi.setHead("1".repeat(40));
    await submitButton(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText("New commits were pushed");
    expect(reviewApi.posted()).toEqual([]);
    expect(posts(reviewApi)).toHaveLength(2);
    // The list is now for the new head; the third click posts.
    await submitButton(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(reviewApi.posted()).toHaveLength(1);
    expect(reviewApi.posted()[0]?.headSha).toBe("1".repeat(40));
  });
});

test.describe("double-submit is impossible (acceptance criterion)", () => {
  test("clicks, Enter and a double-click while the request runs post exactly once", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await armed(page);
    const release = reviewApi.holdSubmits();
    await submitButton(page).click();
    await expect(submitButton(page)).toHaveText("Submitting…");
    await expect(submitButton(page)).toBeDisabled();
    await submitButton(page).click({ force: true });
    await submitButton(page).dblclick({ force: true });
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+Enter");
    // While sending nothing closes it: Escape and Keep reviewing are inert.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Keep reviewing" })).toBeDisabled();
    expect(posts(reviewApi)).toHaveLength(1);
    release();
    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page)).toContainText("Review submitted");
    expect(posts(reviewApi)).toHaveLength(1);
    expect(reviewApi.posted()).toHaveLength(1);
  });

  test("Submit is inert right after the modal opens (a double-click on the opener)", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await submitButton(page).click({ force: true });
    expect(posts(reviewApi)).toEqual([]);
    await armed(page);
    await submitButton(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(posts(reviewApi)).toHaveLength(1);
  });

  test("every click carries a fresh idempotency key, the list's digest and head", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await armed(page);
    const digest = reviewApi.plan().contentSha256;
    reviewApi.scriptSubmit({ status: 502, body: { error: "post_failed", reason: "rejected" } });
    await submitButton(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText("GitHub rejected the review");
    await submitButton(page).click();
    await expect(dialog(page)).toHaveCount(0);
    const clicks = reviewApi.clicks();
    expect(clicks).toHaveLength(2);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const click of clicks) {
      expect(click.key).toMatch(UUID);
      expect(click.contentSha256).toBe(digest);
      expect(click.headSha).toBe(PR_847_HEAD);
      expect(click.verdict).toBe("request_changes");
    }
    expect(clicks[0]?.key).not.toBe(clicks[1]?.key);
    expect(reviewApi.posted()).toHaveLength(1);
  });
});

test.describe("warnings, suggestions and the summary are suggestions only", () => {
  test("coverage and undecided warnings, then the success line", async ({ page, reviewApi }) => {
    await open(page);
    await openFinish(page);
    await expect(dialog(page)).toContainText(
      "4 high-risk files not marked viewed: src/auth/invitations.ts, src/api/routes/invitations.ts, db/migrations/20261020_add_invitations.sql, src/jobs/sendInviteEmail.ts",
    );
    await expect(dialog(page)).toContainText(
      "10 AI drafts still undecided. They won't be posted. Only what you accepted goes out.",
    );
    await expect(dialog(page)).toContainText("No inline comments.");
    // Nothing to post and no verdict: Submit stays off, and says why.
    await expect(submitButton(page)).toBeDisabled();
    await expect(dialog(page)).toContainText("Pick a verdict to submit.");
    await dialog(page)
      .getByRole("radio", { name: /^Comment/ })
      .check();
    await expect(dialog(page)).toContainText("Write a summary or pick Approve to submit");
    await expect(submitButton(page)).toBeDisabled();
    await dialog(page)
      .getByRole("textbox", { name: "Overall comment (optional)" })
      .fill("Looks fine overall.");
    await expect(submitButton(page)).toBeEnabled();
    await dialog(page).getByRole("button", { name: "Keep reviewing" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(posts(reviewApi)).toEqual([]);

    // Mark every high-risk file viewed (the sidebar's checkboxes): the success line.
    for (const path of [
      AUTH,
      "src/api/routes/invitations.ts",
      "db/migrations/20261020_add_invitations.sql",
      "src/jobs/sendInviteEmail.ts",
    ]) {
      await page.getByRole("checkbox", { name: `Viewed ${path}` }).check();
    }
    await openFinish(page);
    await expect(dialog(page)).toContainText("✓ You reviewed every Critical and Important file.");
    await expect(dialog(page)).toContainText("10 AI drafts still undecided.");
  });

  test("Approve is suggested but never pre-selected; the person picks it", async ({
    page,
    reviewApi,
  }) => {
    for (const f of ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"])
      reviewApi.set(f, { state: "dismissed", reason: "not_an_issue" });
    await open(page);
    for (const path of [
      AUTH,
      "src/api/routes/invitations.ts",
      "db/migrations/20261020_add_invitations.sql",
      "src/jobs/sendInviteEmail.ts",
    ]) {
      await page.getByRole("checkbox", { name: `Viewed ${path}` }).check();
    }
    await openFinish(page);
    await expect(dialog(page)).not.toContainText("still undecided");
    const approve = dialog(page).getByRole("radio", { name: /Approve/ });
    await expect(approve).not.toBeChecked();
    await expect(dialog(page).locator(".verdict-opts .suggested")).toContainText("Approve");
    await expect(dialog(page)).toContainText("Pick it to confirm.");
    await expect(submitButton(page)).toBeDisabled();
    await approve.check();
    await armed(page);
    await submitButton(page).click();
    await expect(statusPill(page)).toHaveText("Approved");
    expect(reviewApi.posted()[0]).toMatchObject({ verdict: "approve", body: "", comments: [] });
  });

  test("the drafted summary comes from the comments, can be edited or cleared, and only the click posts", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    reviewApi.set("F5", { state: "accepted", edited: true, body: "Add `on delete cascade`." });
    await open(page);
    await openFinish(page);
    const box = dialog(page).getByRole("textbox", { name: "Overall comment (optional)" });
    await dialog(page).getByRole("button", { name: "Draft a summary from my comments" }).click();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(
      [
        "Before merge, please look at:",
        "",
        "1. Invitee can choose their own role, e.g. admin (`src/auth/invitations.ts:28`)",
        "2. Deleting an org won't remove its invitations (`db/migrations/20261020_add_invitations.sql:3`)",
        "",
        "Details are in the inline comments.",
      ].join("\n"),
    );
    await expect(dialog(page)).toContainText(
      "A suggestion from your comments: edit it, or clear it.",
    );
    await box.fill("My own words.");
    await expect(
      dialog(page).getByRole("button", { name: "Replace with a draft from my comments" }),
    ).toBeVisible();
    await box.fill("");
    expect(posts(reviewApi)).toEqual([]);
    // Request changes is pre-selected (F1 is critical); the person may still pick Comment.
    await dialog(page)
      .getByRole("radio", { name: /^Comment/ })
      .check();
    await box.fill("Two things before merge.");
    await armed(page);
    await submitButton(page).click();
    await expect(statusPill(page)).toHaveText("Commented");
    expect(reviewApi.posted()[0]).toMatchObject({
      verdict: "comment",
      body: "Two things before merge.",
    });
    expect(reviewApi.posted()[0]?.comments).toHaveLength(2);
  });
});

test.describe("every answer is shown honestly and posts nothing by itself", () => {
  test("GitHub refused (post_failed): the reason, the items stay listed, a retry posts once", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await armed(page);
    reviewApi.scriptSubmit({ status: 502, body: { error: "post_failed", reason: "forbidden" } });
    await submitButton(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText(
      "Nothing was posted. GitHub refused the request (no write access",
    );
    await expect(dialog(page).locator(".post-list > li")).toHaveCount(1);
    await expect(statusPill(page)).toHaveText("Open");
    await submitButton(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(reviewApi.posted()).toHaveLength(1);
  });

  test("no answer from GitHub (post_unknown): says the review may exist, links to GitHub, shows the attempt in flight", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await armed(page);
    reviewApi.scriptSubmit({ status: 502, body: { error: "post_unknown", submissionId: "x" } });
    reviewApi.addInFlight();
    reviewApi.markPosted({ findingId: "F1" }, "posting");
    await submitButton(page).click();
    const notice = dialog(page).getByRole("alert");
    await expect(notice).toContainText(
      "may or may not have been posted. Check the pull request on GitHub.",
    );
    await expect(notice.getByRole("link", { name: /Open on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/rocky-app/pull/847",
    );
    await expect(dialog(page)).toContainText(
      "An earlier attempt is still being confirmed with GitHub",
    );
    await expect(dialog(page)).toContainText("Will be posted to GitHub as @dana-k (0)");
    await expect(statusPill(page)).toHaveText("Open");
    await expect(toast(page)).toHaveCount(0);
    // The carried draft is read-only meanwhile.
    await dialog(page).getByRole("button", { name: "Keep reviewing" }).click();
    await openFile(page, AUTH);
    await showCard(page, "F1");
    await expect(card(page, "F1")).toContainText("Posting…");
    await expect(card(page, "F1").getByRole("button", { name: "Undo" })).toHaveCount(0);
  });

  test("in_progress, no_revision, token_unavailable, empty_review, 503 and 404: fixed words, nothing posted", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await armed(page);
    for (const [answer, words] of [
      [{ status: 409, body: { error: "in_progress" } }, "still being confirmed with GitHub"],
      [{ status: 409, body: { error: "no_revision" } }, "not mirrored this commit yet"],
      [{ status: 409, body: { error: "token_unavailable" } }, "Sign in again to post"],
      [{ status: 400, body: { error: "invalid_request", reason: "empty_review" } }, "pick Approve"],
      [{ status: 503, body: { error: "posting_unavailable" } }, "not available on this server"],
      [{ status: 404, body: { error: "not_found" } }, "no longer available to you"],
      [{ status: 403, body: { error: "csrf" } }, "refused the request (403)"],
    ] as const) {
      reviewApi.scriptSubmit(answer);
      await submitButton(page).click();
      await expect(dialog(page).getByRole("alert")).toContainText(words);
      await expect(dialog(page).getByRole("alert")).toContainText(/[Nn]othing (was|can be) posted/);
    }
    expect(reviewApi.posted()).toEqual([]);
    await expect(statusPill(page)).toHaveText("Open");
  });

  test("no usable answer (a 500, an unparseable 200, a dropped connection) is never 'not posted'; the retry reuses the key and never double-posts (B1)", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await armed(page);
    for (const answer of [
      { status: 500, body: "<html>bad gateway</html>" },
      { status: 200, body: { status: "ok" } },
      { status: 502, body: "<html>" },
    ]) {
      reviewApi.scriptSubmit(answer);
      await submitButton(page).click();
      const notice = dialog(page).getByRole("alert");
      await expect(notice).toContainText("may or may not have been posted");
      await expect(notice).not.toContainText("Nothing was posted");
      await expect(notice.getByRole("link", { name: /Open on GitHub/ })).toBeVisible();
    }
    // Every retry so far was the same click: one key.
    expect(new Set(reviewApi.clicks().map((c) => c.key)).size).toBe(1);
    expect(reviewApi.posted()).toEqual([]);

    // The server posts, but the answer never arrives: the page says it may have, reloads, and
    // the posted attempt shows above a list that no longer offers the carried item. Nothing is
    // posted twice: the list changed, so a further click would be a new, empty one.
    reviewApi.dropNextAnswer();
    await submitButton(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText("may or may not have been posted");
    expect(reviewApi.posted()).toHaveLength(1);
    await expect(dialog(page)).toContainText("You already posted a review from Rocky");
    await expect(dialog(page)).toContainText("Will be posted to GitHub as @dana-k (0)");
    await expect(submitButton(page)).toBeDisabled();
    await expect(statusPill(page)).toHaveText("Open");
    await dialog(page).getByRole("button", { name: "Keep reviewing" }).click();
    await page.reload();
    await reviewReady(page);
    await expect(statusPill(page)).toHaveText("Changes requested");
    expect(reviewApi.posted()).toHaveLength(1);
  });

  test("the same list after a dropped request that did not post: the same key posts once", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await armed(page);
    await page.route("**/api/pull-requests/*/review", (route) =>
      route.request().method() === "POST" ? route.abort("connectionreset") : route.fallback(),
    );
    await submitButton(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText("The request did not complete");
    await page.unroute("**/api/pull-requests/*/review");
    await submitButton(page).click();
    await expect(dialog(page)).toHaveCount(0);
    const keys = reviewApi.clicks().map((c) => c.key);
    expect(keys).toHaveLength(1);
    expect(reviewApi.submissions()[0]?.key).toBe(keys[0]);
    expect(reviewApi.posted()).toHaveLength(1);
  });

  test("the session's CSRF token cannot be read: nothing is sent, and it says so", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await armed(page);
    await page.route("**/api/session", (route) => route.fulfill({ status: 500, body: "" }));
    await submitButton(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText("nothing was sent");
    expect(posts(reviewApi)).toEqual([]);
  });

  test("the list could not be loaded: Submit stays off; Try again loads it", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await page.route("**/api/pull-requests/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"posting_unavailable"}',
      }),
    );
    await open(page);
    await finishButton(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText(
      "Posting is not available on this server yet.",
    );
    await expect(submitButton(page)).toBeDisabled();
    await page.unroute("**/api/pull-requests/**");
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    await expect(dialog(page).locator(".post-list > li")).toHaveCount(1);
    expect(reviewApi.posted()).toEqual([]);
  });

  test("a draft posted from another tab: the page learns it on the refusal and shows it read-only", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFile(page, AUTH);
    await showCard(page, "F1");
    reviewApi.markPosted({ findingId: "F1" });
    await card(page, "F1").getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toHaveText(
      "This was already posted to GitHub, so it can no longer be changed.",
    );
    await expect(card(page, "F1")).toContainText("Posted");
    await expect(card(page, "F1").getByRole("button", { name: "Undo" })).toHaveCount(0);
    expect(reviewApi.decision("F1").state).toBe("accepted");
  });
});

test.describe("the list is shown as source, with nothing hidden", () => {
  test("invisible characters (a bidi override, a zero-width space) show as markers and are named", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: true, body: BIDI });
    await open(page);
    await openFinish(page);
    const item = dialog(page).locator(".post-list > li").first();
    await expect(item).toContainText("Contains invisible characters: U+202E, U+202C, U+200B");
    await expect(item.locator(".invisible-char")).toHaveText(["U+202E", "U+202C", "U+200B"]);
    await expect(item.locator(".invisible-char").first()).toHaveAttribute(
      "aria-label",
      "invisible character U+202E",
    );
    // The text itself is untouched: what is posted is the plan's body.
    const plan = reviewApi.plan();
    expect(plan.items[0]?.body).toContain("\u202Eevil\u202C");
    await armed(page);
    await submitButton(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(reviewApi.posted()[0]?.comments[0]?.body).toBe(plan.items[0]?.body);
  });

  test("a list GitHub would refuse (over 100 comments) is shown, and Submit is off with the reason", async ({
    page,
    reviewApi,
  }) => {
    // A preview the server would never build (it caps at 100), as a hostile or buggy one.
    await page.route("**/api/pull-requests/*/review", (route) =>
      route.request().method() !== "GET"
        ? route.fallback()
        : route.fulfill({
            json: {
              pullRequestId: "00000000-0000-4000-8001-000000000847",
              number: 847,
              headSha: PR_847_HEAD,
              revisionKnown: true,
              contentSha256: "a".repeat(64),
              items: Array.from({ length: 101 }, (_, i) => ({
                kind: "comment",
                id: `00000000-0000-4000-8009-${String(i + 1).padStart(12, "0")}`,
                path: "src/auth/invitations.ts",
                line: i + 1,
                startLine: null,
                body: `Comment ${i + 1}`,
              })),
              inFlight: null,
              latestSubmission: null,
            },
          }),
    );
    await open(page);
    await openFinish(page);
    await expect(dialog(page)).toContainText("Will be posted to GitHub as @dana-k (101)");
    await expect(dialog(page).locator(".post-list > li")).toHaveCount(101);
    await expect(dialog(page)).toContainText("GitHub takes at most 100 comments in one review");
    await expect(submitButton(page)).toBeDisabled();
    expect(posts(reviewApi)).toEqual([]);
  });

  test("axe: no serious issues with a long body (a scrolling box) and while sending", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: true, body: LONG });
    await open(page);
    await openFinish(page);
    const box = dialog(page).locator(".post-scroll");
    await expect(box).toHaveAttribute("tabindex", "0");
    expect(await seriousViolations(page)).toEqual([]);
    await armed(page);
    const release = reviewApi.holdSubmits();
    await submitButton(page).click();
    await expect(submitButton(page)).toHaveText("Submitting…");
    await expect(
      dialog(page).getByRole("status").filter({ hasText: "Submitting to GitHub" }),
    ).toBeFocused();
    expect(await seriousViolations(page)).toEqual([]);
    release();
    await expect(dialog(page)).toHaveCount(0);
  });

  test("at phone width the Finish button keeps its count and its label, and the title stays", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page);
    await expect(finishButton(page)).toHaveAccessibleName(/Finish review.*0 comments to post/);
    await expect(finishButton(page).locator(".count")).toBeVisible();
    // P6-9 (D2): the label is shown, not only read out.
    await expect(finishButton(page).locator(".label")).toBeVisible();
    await expect(page.locator(".topbar .pr-title")).toBeVisible();
    const bar = await page.locator("header.topbar").boundingBox();
    expect(bar?.height ?? 999).toBeLessThan(130);
  });
});

/** P6-9 (parity audit D3–D5): the verdict and Submit are in view when the modal opens. */
test.describe("the modal fits", () => {
  /** True when `el` is wholly inside the modal's visible area, between its head and foot. */
  const inView = (page: Page, selector: string) =>
    dialog(page)
      .locator(selector)
      .evaluate((el) => {
        const modal = el.closest(".finish-modal");
        if (modal === null) return false;
        const head = modal.querySelector(".modal-head")?.getBoundingClientRect();
        const foot = modal.querySelector(".modal-foot")?.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const view = modal.getBoundingClientRect();
        const top = Math.max(view.top, head?.bottom ?? view.top);
        const bottom = Math.min(view.bottom, foot?.top ?? view.bottom, window.innerHeight);
        return box.top >= top - 1 && box.bottom <= bottom + 1;
      });

  const cases = [
    { name: "1440 × 900, one comment", size: { width: 1440, height: 900 }, two: false },
    { name: "1440 × 900, two comments", size: { width: 1440, height: 900 }, two: true },
    { name: "375 × 812, one comment", size: { width: 375, height: 812 }, two: false },
  ];
  for (const c of cases) {
    test(`the suggested verdict and Submit are in view on open (${c.name})`, async ({
      page,
      reviewApi,
    }) => {
      await page.setViewportSize(c.size);
      reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
      if (c.two)
        reviewApi.set("F5", { state: "accepted", edited: true, body: "Add `on delete cascade`." });
      await open(page);
      await openFinish(page);
      await expect(dialog(page).getByRole("radio", { name: /Request changes/ })).toBeChecked();
      expect(await inView(page, ".verdict-opts label:has(input:checked)")).toBe(true);
      expect(await inView(page, ".verdict-opts")).toBe(true);
      await expect(submitButton(page)).toBeInViewport();
      // Every comment is still whole: the list scrolls in its own box, nothing is cut.
      const list = dialog(page).getByRole("region", { name: "Comments to post" });
      await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await expect(dialog(page).locator(".post-list > li").last()).toBeInViewport();
      for (const raw of await dialog(page).locator(".post-raw").all()) {
        expect(await raw.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      }
    });
  }

  test("phone: the title and Close stay in view while the modal scrolls", async ({
    page,
    reviewApi,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    await dialog(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(
      dialog(page).getByRole("heading", { name: "Finish your review" }),
    ).toBeInViewport();
    await expect(dialog(page).getByRole("button", { name: "Close" })).toBeInViewport();
  });

  test("the login is shown as written in the upper-case heading", async ({ page, reviewApi }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await openFinish(page);
    const who = dialog(page).locator("#finish-list-title bdi");
    await expect(who).toHaveText(`@${ME.login}`);
    expect(await who.evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
  });
});

test.describe("the modal", () => {
  test("Escape and Keep reviewing close it without posting; focus returns; shortcuts are off while it is open", async ({
    page,
    reviewApi,
  }) => {
    reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
    await open(page);
    await finishButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("k");
    await expect(page.locator("#file-title")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(finishButton(page)).toBeFocused();
    await finishButton(page).click();
    await dialog(page).getByRole("button", { name: "Keep reviewing" }).click();
    await expect(dialog(page)).toHaveCount(0);
    // A click outside closes it too.
    await finishButton(page).click();
    await page.mouse.click(5, 300);
    await expect(dialog(page)).toHaveCount(0);
    expect(posts(reviewApi)).toEqual([]);
    expect(reviewApi.posted()).toEqual([]);
  });

  for (const size of WIDTHS) {
    for (const mode of MODES) {
      test(`axe: no serious issues with it open at ${size.width} px ${mode}`, async ({
        page,
        reviewApi,
      }) => {
        reviewApi.set("F1", { state: "accepted", edited: false, body: "x" });
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await page.clock.setFixedTime(FIXTURE_NOW);
        await open(page);
        await openFinish(page);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  }
});
