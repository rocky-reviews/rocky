import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "./axe.js";
import { openSetup, SETUP_FIXTURES } from "./setup-support.js";
import { MODES, WIDTHS } from "./support.js";

/**
 * P10-2 (ADR 0044): the setup wizard against a mocked setup API. The test call and finish send
 * the setup session's CSRF token; the refusals have fixed messages; the keyboard alone (Tab and
 * Enter) runs the test call and finishes setup, and focus never falls back to the page; axe finds
 * nothing serious in any state, width or mode.
 */

const CSRF = SETUP_FIXTURES.fresh.csrfToken;

const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });

/** Presses Tab until `control` has focus (at most `max` times), then checks it does. */
const tabTo = async (page: Page, control: ReturnType<Page["getByRole"]>, max = 8) => {
  for (let i = 0; i < max; i++) {
    if (await control.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
};

test("the test call posts with the CSRF token and shows each model's answer", async ({ page }) => {
  const api = await openSetup(page);
  await button(page, "Run the test call").click();
  await expect(page.getByRole("status")).toHaveText("The LLM provider answered.");
  expect(api.posts).toEqual([{ path: "/api/setup/llm-test", csrf: CSRF }]);
  const step = page.locator(".setup-step", { has: page.locator("#setup-llm-title") });
  await expect(step.locator(".setup-outcome")).toHaveCount(2);
  await expect(step.locator(".setup-pill")).toHaveText("Done");
});

test("the announcement does not move the steps, and clears itself (fix round, item 5)", async ({
  page,
}) => {
  await openSetup(page);
  // In page coordinates: clicking may scroll.
  const top = () =>
    page
      .locator("#setup-db-title")
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const before = await top();
  await button(page, "Run the test call").click();
  await expect(page.getByRole("status")).toHaveText("The LLM provider answered.");
  expect(await top()).toBe(before);
  await expect(page.getByRole("status")).toHaveText("", { timeout: 10_000 });
});

test("finishing posts with the CSRF token and focuses what to do last", async ({ page }) => {
  const api = await openSetup(page, SETUP_FIXTURES.done);
  await button(page, "Finish setup").click();
  const done = page.getByText("Setup is closed.");
  await expect(done).toBeVisible();
  await expect(page.locator(".setup-finished")).toBeFocused();
  expect(api.posts).toEqual([{ path: "/api/setup/finish", csrf: CSRF }]);
});

test("finished in setup mode: restart without the overlay, no inbox link (fix round)", async ({
  page,
}) => {
  await openSetup(page, SETUP_FIXTURES.fresh);
  await button(page, "Finish setup").click();
  await expect(page.getByText("Setup is closed.")).toBeVisible();
  await expect(page.getByText(/without the setup overlay/)).toBeVisible();
  await expect(page.getByRole("link", { name: /inbox/ })).toHaveCount(0);
  await page.unrouteAll();
  await openSetup(page, SETUP_FIXTURES.done);
  await button(page, "Finish setup").click();
  await expect(page.getByRole("link", { name: "Go to your inbox" })).toBeVisible();
});

test("the create and install links go where they should", async ({ page }) => {
  await openSetup(page);
  await expect(page.getByRole("link", { name: "Create the GitHub App" })).toHaveAttribute(
    "href",
    "/setup/github-app",
  );
  await page.unrouteAll();
  await openSetup(page, SETUP_FIXTURES.done);
  await expect(page.getByRole("link", { name: /Install on a repository/ })).toHaveAttribute(
    "href",
    "https://github.com/apps/rocky-reviews/installations/new",
  );
  await expect(page.getByRole("link", { name: /Open it in Rocky/ })).toHaveAttribute(
    "href",
    "/acme/rocky-app/pull/12",
  );
});

test("without the setup session, or once closed, the page says so", async ({ page }) => {
  await openSetup(page, 403);
  await expect(page.getByRole("alert")).toContainText("one-time setup link");
  await page.unrouteAll();
  await openSetup(page, 404);
  await expect(page.getByRole("alert")).toContainText("Setup is closed on this server");
});

test("checks again on request and picks up a new state", async ({ page }) => {
  const api = await openSetup(page, SETUP_FIXTURES.installed);
  api.setStatus(SETUP_FIXTURES.done);
  await button(page, "Check again").click();
  await expect(page.getByRole("link", { name: /Open it in Rocky/ })).toBeVisible();
});

test("a failed check keeps the wizard and says so inline; a lost session swaps the page (fix round, item 6)", async ({
  page,
}) => {
  const api = await openSetup(page, SETUP_FIXTURES.installed);
  api.setStatus(500);
  await button(page, "Check again").click();
  await expect(page.getByRole("alert")).toContainText("Rocky did not answer the last check");
  await expect(page.locator("#setup-intro-title")).toBeVisible();
  await expect(button(page, "Check again")).toBeFocused();
  api.setStatus(SETUP_FIXTURES.done);
  await button(page, "Check again").click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Open it in Rocky/ })).toBeVisible();
  api.setStatus(403);
  await button(page, "Check again").click();
  await expect(page.getByRole("alert")).toContainText("one-time setup link");
});

test("while a test call runs, nothing else can start, and focus stays put (fix round)", async ({
  page,
}) => {
  const api = await openSetup(page, SETUP_FIXTURES.fresh, { holdLlmTest: true });
  await button(page, "Run the test call").click();
  const busy = button(page, "Testing…");
  await expect(busy).toHaveAttribute("aria-disabled", "true");
  await expect(busy).toBeFocused();
  await expect(button(page, "Check again")).toHaveAttribute("aria-disabled", "true");
  await expect(button(page, "Finish setup")).toHaveAttribute("aria-disabled", "true");
  // Playwright refuses to click an aria-disabled button; a person's click still reaches it.
  await button(page, "Finish setup").click({ force: true });
  await busy.click({ force: true });
  api.releaseLlmTest();
  await expect(page.getByRole("status")).toHaveText("The LLM provider answered.");
  await expect(button(page, "Test again")).toBeFocused();
  expect(api.posts.map((p) => p.path)).toEqual(["/api/setup/llm-test"]);
});

test("a test call too soon after the last one says so by the button (fix round)", async ({
  page,
}) => {
  await openSetup(page, SETUP_FIXTURES.fresh, { llmTestStatus: 429 });
  await button(page, "Run the test call").click();
  await expect(page.getByRole("alert")).toHaveText("Wait a few seconds before testing again.");
  await expect(button(page, "Run the test call")).toBeFocused();
});

test("a failed finish says so and keeps focus on the button (fix round, item 4)", async ({
  page,
}) => {
  await openSetup(page, SETUP_FIXTURES.done, { finishStatus: 500 });
  await button(page, "Finish setup").click();
  await expect(page.getByRole("alert")).toHaveText(
    "Setup could not be closed. Reload and try again.",
  );
  await expect(button(page, "Finish setup")).toBeFocused();
});

test("the keyboard alone runs the test call and finishes setup; focus never drops to the page", async ({
  page,
}) => {
  const api = await openSetup(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  // Check again keeps focus once the status is back.
  await tabTo(page, button(page, "Check again"));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Status updated.");
  await expect(button(page, "Check again")).toBeFocused();
  await tabTo(page, page.getByRole("link", { name: "Create the GitHub App" }));
  await tabTo(page, button(page, "Run the test call"));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("The LLM provider answered.");
  await expect(button(page, "Test again")).toBeFocused();
  await tabTo(page, button(page, "Finish setup"));
  await page.keyboard.press("Enter");
  await expect(page.getByText("Setup is closed.")).toBeVisible();
  await expect(page.locator(".setup-finished")).toBeFocused();
  expect(api.posts.map((p) => p.path)).toEqual(["/api/setup/llm-test", "/api/setup/finish"]);
});

test.describe("axe", () => {
  for (const mode of MODES) {
    for (const size of WIDTHS) {
      test(`no serious issues in any state, ${size.width} ${mode}`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        for (const [name, status] of Object.entries(SETUP_FIXTURES)) {
          await page.unrouteAll();
          await openSetup(page, status);
          expect(await seriousViolations(page), name).toEqual([]);
        }
        // The refusal pages, a failed check, the inline problems, the busy state and the end.
        for (const code of [403, 404, 500]) {
          await page.unrouteAll();
          await openSetup(page, code);
          await expect(page.getByRole("alert")).toBeVisible();
          expect(await seriousViolations(page), `status ${code}`).toEqual([]);
        }
        await page.unrouteAll();
        await openSetup(page, SETUP_FIXTURES.fresh, { holdLlmTest: true });
        await button(page, "Run the test call").click();
        await expect(button(page, "Testing…")).toBeVisible();
        expect(await seriousViolations(page), "testing").toEqual([]);
        // The held test call is never answered; leaving the page drops it.
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await openSetup(page, SETUP_FIXTURES.done, { llmTestStatus: 429, finishStatus: 500 });
        await button(page, "Test again").click();
        await expect(page.getByRole("alert")).toBeVisible();
        expect(await seriousViolations(page), "too soon").toEqual([]);
        await button(page, "Finish setup").click();
        await expect(page.getByRole("alert")).toContainText("could not be closed");
        expect(await seriousViolations(page), "finish failed").toEqual([]);
        await page.unrouteAll();
        const failing = await openSetup(page, SETUP_FIXTURES.installed);
        failing.setStatus(500);
        await button(page, "Check again").click();
        await expect(page.getByRole("alert")).toBeVisible();
        expect(await seriousViolations(page), "check failed").toEqual([]);
        await page.unrouteAll();
        await openSetup(page, SETUP_FIXTURES.fresh);
        await button(page, "Finish setup").click();
        await expect(page.locator(".setup-finished")).toBeVisible();
        expect(await seriousViolations(page), "finished").toEqual([]);
      });
    }
  }
});
