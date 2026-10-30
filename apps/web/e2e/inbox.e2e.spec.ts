import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { CSRF_TOKEN, headOf, idOf, openInbox, openInboxApi, numbered } from "./inbox-support.js";
import { MODES, WIDTHS } from "./support.js";

/**
 * P6-7 acceptance (e2e): the inbox lists PRs across repositories sorted by risk, filters them,
 * groups the ones Rocky offers for bulk approval, and approves a batch only after the person
 * confirms that exact batch: nothing is sent on load, on selection, on opening the dialog, on
 * Cancel or on Escape; one confirmation sends one request naming each PR at the commit shown.
 */

const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

const reviewRegion = (page: Page) => page.getByRole("region", { name: /Needs your review/ });
const safeRegion = (page: Page) => page.getByRole("region", { name: /Safe to bulk-approve/ });
/** The PR numbers of a region's rows, in order. */
const numbers = async (page: Page, region: ReturnType<typeof reviewRegion>) =>
  (await region
    .locator("[data-number]")
    .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-number"))))) as number[];

test.describe("list and sorting", () => {
  test("lists open PRs across repositories, riskiest first", async ({ page }) => {
    await openInbox(page);
    await expect(page.getByText("11 open pull requests in 5 repositories")).toBeVisible();
    // Critical, high, medium, not analysed (longest waiting first), then low.
    expect(await numbers(page, reviewRegion(page))).toEqual([
      847, 312, 851, 77, 208, 210, 850, 201,
    ]);
    const first = reviewRegion(page).locator("[data-number]").first();
    await expect(first).toContainText("Critical");
    await expect(first).toContainText("acme/rocky-app");
    await expect(first).toContainText("Team invitations with expiring links");
    await expect(first).toContainText("+215 −3");
    // Each row opens the PR's real review page (H4-2).
    await expect(
      first.getByRole("link", { name: "Team invitations with expiring links" }),
    ).toHaveAttribute("href", "/acme/rocky-app/pull/847");
  });

  test("states why a PR has no current analysis, and why a low-risk PR is not offered", async ({
    page,
  }) => {
    await openInbox(page);
    const row = (n: number) => reviewRegion(page).locator(`[data-number="${n}"]`);
    await expect(row(208)).toContainText("Analysing");
    await expect(row(77)).toContainText("Analysis failed");
    await expect(row(201)).toContainText("Analysis out of date");
    await expect(row(850)).toContainText("1 AI finding");
    await expect(row(210)).toContainText("Your pull request");
  });

  test("groups the PRs Rocky offers for bulk approval, none selected", async ({ page }) => {
    await openInbox(page);
    expect(await numbers(page, safeRegion(page))).toEqual([41, 309, 205]);
    for (const box of await safeRegion(page).getByRole("checkbox").all()) {
      await expect(box).not.toBeChecked();
    }
    await expect(page.getByRole("button", { name: /^Approve/ })).toBeDisabled();
  });
});

test.describe("filters", () => {
  test("by repository, by risk and by search, with a count and a reset", async ({ page }) => {
    await openInbox(page);
    await page.getByRole("combobox", { name: "Repository" }).selectOption("acme/web");
    expect(await numbers(page, reviewRegion(page))).toEqual([208, 210, 201]);
    expect(await numbers(page, safeRegion(page))).toEqual([205]);
    await expect(page.getByText("Showing 4 of 11")).toBeVisible();

    await page.getByRole("combobox", { name: "Repository" }).selectOption("");
    await page.getByRole("combobox", { name: "Risk" }).selectOption("critical");
    expect(await numbers(page, reviewRegion(page))).toEqual([847]);
    await expect(safeRegion(page)).toContainText("No pull request here matches the filters.");

    await page.getByRole("combobox", { name: "Risk" }).selectOption("");
    await page.getByRole("searchbox", { name: "Search" }).fill(`#${312}`);
    expect(await numbers(page, reviewRegion(page))).toEqual([312]);

    await page.getByRole("button", { name: "Clear filters" }).click();
    expect(await numbers(page, reviewRegion(page))).toHaveLength(8);
    await expect(page.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeHidden();
  });

  test("a filter keeps the batch to what is shown: hidden selections are not sent", async ({
    page,
  }) => {
    const api = await openInboxApi(page);
    await safeRegion(page).getByRole("button", { name: "Select all 3" }).click();
    await page.getByRole("combobox", { name: "Repository" }).selectOption("acme/docs");
    await page.getByRole("button", { name: "Approve 1 selected…" }).click();
    await expect(page.getByRole("dialog").getByRole("listitem")).toHaveCount(1);
    await page.getByRole("button", { name: "Approve 1 pull request" }).click();
    await expect(page.getByRole("dialog")).toContainText("Approved 1 pull request on GitHub");
    expect(api.posts.map((p) => p.postDataJSON() as unknown)).toEqual([
      { pullRequests: [{ id: idOf(41), headSha: headOf(41) }] },
    ]);
  });
});

test.describe("bulk approval needs an explicit confirmation per batch", () => {
  test("nothing is sent on load, on select, on opening the dialog, on Cancel or Escape", async ({
    page,
  }) => {
    const api = await openInboxApi(page);
    await safeRegion(page)
      .getByRole("checkbox", { name: numbered(41) })
      .check();
    await safeRegion(page)
      .getByRole("checkbox", { name: numbered(205) })
      .check();
    const open = page.getByRole("button", { name: "Approve 2 selected…" });

    await open.click();
    const dialog = page.getByRole("dialog", { name: "Approve 2 pull requests?" });
    await expect(dialog).toBeVisible();
    // Exactly the batch, with the commits it will be pinned to.
    await expect(dialog.getByRole("listitem")).toHaveCount(2);
    await expect(dialog).toContainText("acme/docs #41");
    await expect(dialog).toContainText("Update the README badges");
    await expect(dialog).toContainText(headOf(205).slice(0, 7));
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await open.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(api.posts).toHaveLength(0);
  });

  test("one confirmation sends one request: each PR at the commit shown, with the CSRF token", async ({
    page,
  }) => {
    const api = await openInboxApi(page);
    await safeRegion(page)
      .getByRole("checkbox", { name: numbered(41) })
      .check();
    await safeRegion(page)
      .getByRole("checkbox", { name: numbered(309) })
      .check();
    await page.getByRole("button", { name: "Approve 2 selected…" }).click();
    await page
      .getByRole("dialog", { name: "Approve 2 pull requests?" })
      .getByRole("button", { name: "Approve 2 pull requests" })
      .click();
    // The heading now gives the outcome.
    const dialog = page.getByRole("dialog", { name: "Batch approved" });
    await expect(dialog).toContainText("Approved 2 pull requests on GitHub");
    expect(api.posts).toHaveLength(1);
    const [post] = api.posts;
    if (post === undefined) throw new Error("no POST");
    expect(post.method()).toBe("POST");
    expect(await post.headerValue("x-rocky-csrf")).toBe(CSRF_TOKEN);
    expect(post.postDataJSON()).toEqual({
      pullRequests: [
        { id: idOf(41), headSha: headOf(41) },
        { id: idOf(309), headSha: headOf(309) },
      ],
    });

    await dialog.getByRole("button", { name: "Close" }).click();
    // The approved PRs leave the group; the rest stay unselected.
    expect(await numbers(page, safeRegion(page))).toEqual([205]);
    await expect(page.getByRole("status")).toContainText("Approved 2 pull requests");
    expect(api.posts).toHaveLength(1);
  });

  test("a click on confirm right after the dialog opens does nothing (it is still arming)", async ({
    page,
  }) => {
    const api = await openInboxApi(page);
    await safeRegion(page)
      .getByRole("checkbox", { name: numbered(41) })
      .check();
    await page.getByRole("button", { name: "Approve 1 selected…" }).click();
    const confirm = page.getByRole("button", { name: "Approve 1 pull request" });
    // A raw pointer click at once, without waiting for the button to be enabled.
    const box = await confirm.boundingBox();
    if (box === null) throw new Error("confirm not visible");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    await expect(confirm).toBeEnabled();
    expect(api.posts).toHaveLength(0);
    await expect(page.getByRole("dialog")).toContainText("Approve 1 pull request?");
  });

  test("a double-click on the opener never confirms, even where the confirm button appears (375 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const api = await openInboxApi(page);
    await safeRegion(page).getByRole("button", { name: "Select all 3" }).click();
    const opener = page.getByRole("button", { name: "Approve 3 selected…" });
    // Find where the confirm button appears, then scroll the opener under it.
    await opener.click();
    const confirmBox = await page
      .getByRole("button", { name: "Approve 3 pull requests" })
      .boundingBox();
    await page.getByRole("button", { name: "Cancel" }).click();
    if (confirmBox === null) throw new Error("confirm not visible");
    const openerBox = await opener.boundingBox();
    if (openerBox === null) throw new Error("opener not visible");
    await page.evaluate(
      (dy) => window.scrollBy(0, dy),
      openerBox.y + openerBox.height / 2 - (confirmBox.y + confirmBox.height / 2),
    );
    const at = await opener.boundingBox();
    if (at === null) throw new Error("opener not visible");
    const x = Math.max(
      at.x + 4,
      Math.min(at.x + at.width - 4, confirmBox.x + confirmBox.width / 2),
    );
    await page.mouse.dblclick(x, at.y + at.height / 2);
    await expect(page.getByRole("dialog", { name: "Approve 3 pull requests?" })).toBeVisible();
    await page.waitForTimeout(800);
    expect(api.posts).toHaveLength(0);
    await expect(page.getByRole("dialog")).not.toContainText("approved on GitHub");
  });

  test("while sending, confirm is disabled and Escape cannot dismiss the dialog", async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = await openInboxApi(page);
    await page.unroute("**/api/inbox/approvals");
    await page.route("**/api/inbox/approvals", async (route) => {
      api.posts.push(route.request());
      await gate;
      await route.fulfill({ json: { results: [{ id: idOf(41), outcome: "approved" }] } });
    });
    await safeRegion(page)
      .getByRole("checkbox", { name: numbered(41) })
      .check();
    await page.getByRole("button", { name: "Approve 1 selected…" }).click();
    const confirm = page.getByRole("button", { name: "Approve 1 pull request" });
    await confirm.click();
    await expect(page.getByRole("button", { name: "Approving…" })).toBeDisabled();
    // Focus stays in the dialog, on a live status.
    const sending = page.locator("[data-sending]");
    await expect(sending).toBeFocused();
    await expect(sending).toHaveAttribute("role", "status");
    await expect(sending).toContainText("Approving…");
    await page.getByRole("button", { name: "Approving…" }).click({ force: true });
    // Twice: a browser may force-close on a repeated Escape; the dialog comes back.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    release();
    await expect(page.getByRole("dialog")).toContainText("Approved 1 pull request on GitHub");
    expect(api.posts).toHaveLength(1);
  });

  test("a PR whose live head moved on GitHub is not approved, reported, and the inbox reloads", async ({
    page,
  }) => {
    const api = await openInboxApi(page, (body) => ({
      status: 200,
      body: {
        results: body.pullRequests.map((p) => ({
          id: p.id,
          outcome: p.id === idOf(205) ? "head_moved" : "approved",
        })),
      },
    }));
    await safeRegion(page).getByRole("button", { name: "Select all 3" }).click();
    await page.getByRole("button", { name: "Approve 3 selected…" }).click();
    await page.getByRole("button", { name: "Approve 3 pull requests" }).click();
    const dialog = page.getByRole("dialog", { name: "Batch partly approved" });
    await expect(dialog).toContainText("Approved 2 pull requests on GitHub");
    await expect(dialog).toContainText("1 had new commits on GitHub since you looked");
    await expect(dialog).toContainText(`acme/web #${205}`);
    const before = api.loads();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect.poll(api.loads).toBe(before + 1);
    expect(await numbers(page, safeRegion(page))).toEqual([205]);
    await expect(safeRegion(page).getByRole("checkbox", { name: numbered(205) })).not.toBeChecked();
  });

  test("an unclear answer reloads the inbox before anything can be confirmed again", async ({
    page,
  }) => {
    const api = await openInboxApi(page, () => ({ status: 500, body: { error: "internal" } }));
    await safeRegion(page)
      .getByRole("checkbox", { name: numbered(41) })
      .check();
    await page.getByRole("button", { name: "Approve 1 selected…" }).click();
    await page.getByRole("button", { name: "Approve 1 pull request" }).click();
    await expect(page.getByRole("dialog")).toContainText("Rocky could not confirm what happened");
    const before = api.loads();
    await page.getByRole("button", { name: "Close" }).click();
    await expect.poll(api.loads).toBe(before + 1);
    await expect(page.getByRole("button", { name: "Approve selected…" })).toBeDisabled();
    expect(api.posts).toHaveLength(1);
  });

  test("a refused batch approves nothing and says which PR changed", async ({ page }) => {
    await openInboxApi(page, () => ({
      status: 409,
      body: { error: "batch_refused", refusals: [{ id: idOf(205), reason: "head_moved" }] },
    }));
    await safeRegion(page).getByRole("button", { name: "Select all 3" }).click();
    await page.getByRole("button", { name: "Approve 3 selected…" }).click();
    await page.getByRole("button", { name: "Approve 3 pull requests" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Nothing was approved");
    await expect(dialog).toContainText(`acme/web #${205}`);
    await expect(dialog).toContainText("New commits since you looked");
    await dialog.getByRole("button", { name: "Close" }).click();
    // Nothing left the group, and the inbox was loaded again.
    expect(await numbers(page, safeRegion(page))).toEqual([41, 309, 205]);
    await expect(page.getByRole("status")).toHaveText("");
  });

  test("a server without bulk approval says so and approves nothing", async ({ page }) => {
    await openInboxApi(page, () => ({ status: 503, body: { error: "approve_unavailable" } }));
    await safeRegion(page)
      .getByRole("checkbox", { name: numbered(41) })
      .check();
    await page.getByRole("button", { name: "Approve 1 selected…" }).click();
    await page.getByRole("button", { name: "Approve 1 pull request" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "Bulk approval is not available on this server yet. Nothing was approved.",
    );
    await page.getByRole("button", { name: "Close" }).click();
    expect(await numbers(page, safeRegion(page))).toEqual([41, 309, 205]);
    await expect(page.getByRole("status")).toHaveText("");
  });

  test("a PR the forge did not approve is reported and stays in the group", async ({ page }) => {
    await openInboxApi(page, (body) => ({
      status: 200,
      body: {
        results: body.pullRequests.map((p, i) => ({
          id: p.id,
          outcome: i === 0 ? "failed" : "approved",
        })),
      },
    }));
    await safeRegion(page).getByRole("button", { name: "Select all 3" }).click();
    await page.getByRole("button", { name: "Approve 3 selected…" }).click();
    await page.getByRole("button", { name: "Approve 3 pull requests" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Approved 2 pull requests on GitHub");
    await expect(dialog).toContainText("1 could not be approved");
    await dialog.getByRole("button", { name: "Close" }).click();
    expect(await numbers(page, safeRegion(page))).toEqual([41]);
  });
});

test.describe("keyboard", () => {
  test("filters, selects and confirms a batch with the keyboard alone", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const api = await openInboxApi(page);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /Switch to (dark|light) mode/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: "Repository" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: "Risk" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("searchbox", { name: "Search" })).toBeFocused();
    await page.keyboard.type("badges");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(safeRegion(page).getByRole("button", { name: "Select all 1" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(safeRegion(page).getByRole("checkbox", { name: numbered(41) })).toBeFocused();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Update the README badges" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Approve 1 selected…" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    const confirm = page.getByRole("button", { name: "Approve 1 pull request" });
    await expect(confirm).toBeFocused();
    expect(api.posts).toHaveLength(0);
    await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText("Approved 1 pull request on GitHub");
    expect(api.posts).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeHidden();
    // The opener is gone with the approved PR: focus stays with the group, not on <body>.
    await expect(page.locator("#safe-title")).toBeFocused();
  });
});

test.describe("axe and layout", () => {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      test(`no serious issues at ${size.width} px ${mode}`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openInbox(page);
        expect(await seriousViolations(page)).toEqual([]);
        await safeRegion(page).getByRole("button", { name: "Select all 3" }).click();
        await page.getByRole("button", { name: "Approve 3 selected…" }).click();
        expect(await seriousViolations(page)).toEqual([]);
      });
      test(`no serious issues in the outcome states at ${size.width} px ${mode}`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openInboxApi(page, (body) => ({
          status: 200,
          body: {
            results: body.pullRequests.map((p, i) => ({
              id: p.id,
              outcome: i === 0 ? "failed" : "approved",
            })),
          },
        }));
        await safeRegion(page).getByRole("button", { name: "Select all 3" }).click();
        expect(await seriousViolations(page)).toEqual([]);
        await page.getByRole("button", { name: "Approve 3 selected…" }).click();
        await page.getByRole("button", { name: "Approve 3 pull requests" }).click();
        await expect(page.getByRole("dialog")).toContainText("1 could not be approved");
        expect(await seriousViolations(page)).toEqual([]);
        await page.getByRole("button", { name: "Close" }).click();
        expect(await seriousViolations(page)).toEqual([]);
        await page.getByRole("searchbox", { name: "Search" }).fill("nothing matches this");
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
    test(`no horizontal page scroll at ${size.width} px, list and dialog`, async ({ page }) => {
      await page.setViewportSize(size);
      await openInbox(page);
      const overflow = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      expect(await overflow()).toBeLessThanOrEqual(0);
      await safeRegion(page).getByRole("button", { name: "Select all 3" }).click();
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.getByRole("button", { name: "Approve 3 selected…" }).click();
      expect(await overflow()).toBeLessThanOrEqual(0);
    });
  }
});
