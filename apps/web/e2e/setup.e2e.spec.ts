import { expect, test } from "@playwright/test";
import { seriousViolations } from "./axe.js";
import { openSetup, SETUP_FIXTURES } from "./setup-support.js";
import { MODES, WIDTHS } from "./support.js";

/**
 * P10-2 (ADR 0044): the setup wizard against a mocked setup API. The test call and finish send
 * the setup session's CSRF token; the refusals have fixed messages; the keyboard alone runs the
 * test call and finishes setup; axe finds nothing serious in any state, width or mode.
 */

const CSRF = SETUP_FIXTURES.fresh.csrfToken;

test("the test call posts with the CSRF token and shows each model's answer", async ({ page }) => {
  const api = await openSetup(page);
  await page.getByRole("button", { name: "Run the test call" }).click();
  await expect(page.getByRole("status")).toHaveText("The LLM provider answered.");
  expect(api.posts).toEqual([{ path: "/api/setup/llm-test", csrf: CSRF }]);
  const step = page.locator(".setup-step", { has: page.locator("#setup-llm-title") });
  await expect(step.locator(".setup-outcome")).toHaveCount(2);
  await expect(step.locator(".setup-pill")).toHaveText("Done");
});

test("finishing posts with the CSRF token and says what to do last", async ({ page }) => {
  const api = await openSetup(page, SETUP_FIXTURES.done);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByText("Setup is closed.")).toBeVisible();
  expect(api.posts).toEqual([{ path: "/api/setup/finish", csrf: CSRF }]);
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
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("link", { name: /Open it in Rocky/ })).toBeVisible();
});

test("the keyboard alone runs the test call and finishes setup", async ({ page }) => {
  const api = await openSetup(page);
  // The skip link first, then the theme toggle, then the page's own controls in order.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  // The page's controls come in reading order, each reached by Tab within a few presses.
  const order = [
    page.getByRole("button", { name: "Check again" }),
    page.getByRole("link", { name: "Create the GitHub App" }),
    page.getByRole("button", { name: "Run the test call" }),
  ];
  for (const control of order) {
    for (let i = 0; i < 6; i++) {
      if (await control.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(control).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("The LLM provider answered.");
  await page.getByRole("button", { name: "Finish setup" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Setup is closed.")).toBeVisible();
  expect(api.posts.map((p) => p.path)).toEqual(["/api/setup/llm-test", "/api/setup/finish"]);
});

test.describe("axe", () => {
  for (const mode of MODES) {
    for (const size of WIDTHS) {
      test(`no serious issues in any state, ${size.width} ${mode}`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        for (const [name, status] of Object.entries(SETUP_FIXTURES)) {
          await page.unrouteAll();
          await openSetup(page, status);
          expect(await seriousViolations(page), name).toEqual([]);
        }
      });
    }
  }
});
