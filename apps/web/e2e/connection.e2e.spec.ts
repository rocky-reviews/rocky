import { expect, type Locator, type Page, test } from "@playwright/test";
import { seriousViolations } from "./axe.js";
import {
  CSRF,
  fakeToken,
  INBOX_SYNC,
  mockSetupToken,
  openConnection,
  openTokenInbox,
  SETUP_FIXTURES,
  TOKEN_SAVED,
} from "./connection-support.js";
import { openSetup } from "./setup-support.js";
import { MODES, WIDTHS } from "./support.js";
import { CONNECTION_NO_TOKEN, SYNC_RATE_LIMITED } from "../src/connection/fixtures.js";

/**
 * P10-4 (ADR 0045): token mode against a mocked API. The keyboard alone adds a repository from
 * the picker, syncs, replaces and removes the token (with its confirmation); every change goes
 * with the session's CSRF token; the token is sent once and never appears in the page; the
 * wizard's token step, its App-mode alternative and the inbox's sync bar behave; axe finds
 * nothing serious.
 */

test.use({ timezoneId: "UTC", locale: "en-GB" });

const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });

/** Presses Tab until `control` has focus (at most `max` times), then checks it does. */
const tabTo = async (page: Page, control: Locator, max = 12) => {
  for (let i = 0; i < max; i++) {
    if (await control.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
};

/** The token is nowhere in the page: not in the DOM, not in any field's value. */
const expectNoToken = async (page: Page, token: string) => {
  expect(await page.content()).not.toContain(token);
  const values = await page
    .locator("input")
    .evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
  expect(values.join("\n")).not.toContain(token);
};

test.describe("the connection page", () => {
  test("by keyboard: add a repository from the picker, with the CSRF token", async ({ page }) => {
    const api = await openConnection(page);
    const add = button(page, "Add repository");
    await tabTo(page, add);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add a repository" });
    await expect(dialog).toBeVisible();
    const filter = dialog.getByRole("searchbox", { name: "Filter" });
    await expect(filter).toBeFocused();
    await expect(dialog.getByText("Following")).toHaveCount(2);
    await page.keyboard.type("web");
    await expect(dialog.getByText("Showing 1 of 5")).toBeVisible();
    await tabTo(page, dialog.getByRole("button", { name: "Add acme/web-console" }), 3);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Added acme/web-console" })).toHaveText(
      "Added acme/web-console. Synced: 3 open pull requests, 3 updated, 2 analyses queued.",
    );
    await expect(page.locator(".connection-repo")).toHaveCount(3);
    await expect(add).toBeFocused();
    expect(api.sent).toEqual([
      {
        method: "POST",
        path: "/api/connection/repositories",
        csrf: CSRF,
        body: { forgeRepoId: 81_220_003 },
      },
    ]);
  });

  test("the picker closes on Escape and says when the list is cut", async ({ page }) => {
    const api = await openConnection(page);
    api.answer("GET /api/connection/available", {
      status: 200,
      json: { repositories: [], truncated: true },
    });
    await button(page, "Add repository").click();
    const dialog = page.getByRole("dialog", { name: "Add a repository" });
    await expect(
      dialog.getByText("Showing the first 500 repositories this token can see."),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(button(page, "Add repository")).toBeFocused();
    expect(api.sent).toEqual([]);
  });

  test("by keyboard: sync now, then a rate limit with its reset time", async ({ page }) => {
    const api = await openConnection(page);
    const sync = button(page, /Sync now/);
    await tabTo(page, sync, 20);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Synced:" })).toBeVisible();
    api.answer("POST /api/connection/sync", { status: 200, json: SYNC_RATE_LIMITED });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      "GitHub's rate limit for this token is used up. Try again after 12:40.",
    );
    expect(api.sent.map((s) => [s.method, s.path, s.csrf, s.body])).toEqual([
      ["POST", "/api/connection/sync", CSRF, {}],
      ["POST", "/api/connection/sync", CSRF, {}],
    ]);
  });

  test("a sync GitHub refuses links to replacing the token", async ({ page }) => {
    const api = await openConnection(page);
    api.answer("POST /api/connection/sync", {
      status: 200,
      json: { ...SYNC_RATE_LIMITED, outcome: "token_rejected", retryAt: null },
    });
    await button(page, /Sync now/).click();
    await page.getByRole("link", { name: "Replace the token" }).click();
    await expect(page.getByLabel("New personal access token")).toBeFocused();
  });

  test("by keyboard: replace the token; it is sent once and never shown", async ({ page }) => {
    const api = await openConnection(page);
    const token = fakeToken();
    const replace = button(page, "Replace token");
    await tabTo(page, replace);
    await page.keyboard.press("Enter");
    await expect(replace).toHaveAttribute("aria-expanded", "true");
    const field = page.getByLabel("New personal access token");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("type", "password");
    // A refusal first: the field is emptied anyway, the reason is fixed text.
    api.answer("PUT /api/connection/token", {
      status: 422,
      json: { error: "token_rejected", retryAt: null },
    });
    await page.keyboard.type(token);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      "GitHub did not accept this token: it may be mistyped, expired or revoked.",
    );
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await expectNoToken(page, token);
    api.answer("PUT /api/connection/token", null);
    await page.keyboard.type(token);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Token saved" })).toBeVisible();
    await expect(field).toBeHidden();
    await expect(page.locator("#token-title")).toBeFocused();
    await expectNoToken(page, token);
    expect(api.sent).toEqual([
      { method: "PUT", path: "/api/connection/token", csrf: CSRF, body: { token } },
      { method: "PUT", path: "/api/connection/token", csrf: CSRF, body: { token } },
    ]);
  });

  test("by keyboard: remove the token after confirming; Escape sends nothing", async ({ page }) => {
    const api = await openConnection(page);
    const remove = button(page, "Remove token");
    await tabTo(page, remove);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Remove the token?" });
    await expect(dialog).toContainText("stops reading GitHub and cannot post reviews");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
    expect(api.sent).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    // Tab stays in the dialog.
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Remove token" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("No token is saved")).toBeVisible();
    await expect(page.locator("#token-title")).toBeFocused();
    expect(api.sent).toEqual([
      { method: "DELETE", path: "/api/connection/token", csrf: CSRF, body: null },
    ]);
  });

  test("stop following a repository after confirming", async ({ page }) => {
    const api = await openConnection(page);
    await button(page, "Stop following acme/billing-api").click();
    const dialog = page.getByRole("dialog", { name: "Stop following acme/billing-api?" });
    await dialog.getByRole("button", { name: "Stop following" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".connection-repo")).toHaveCount(1);
    await expect(page.locator("#repos-title")).toBeFocused();
    expect(api.sent.map((s) => `${s.method} ${s.path} ${s.csrf}`)).toEqual([
      `DELETE /api/connection/repositories/00000000-0000-4000-8009-000000000002 ${CSRF}`,
    ]);
  });

  test("without a token: save one from the page", async ({ page }) => {
    const api = await openConnection(page, CONNECTION_NO_TOKEN);
    const token = fakeToken("classic");
    await page.getByRole("textbox", { name: "Personal access token" }).fill(token);
    await button(page, "Save token").click();
    await expect(page.getByRole("status").filter({ hasText: "Token saved" })).toBeVisible();
    await expectNoToken(page, token);
    expect(api.sent).toHaveLength(1);
  });

  test("on an App server there is nothing to manage", async ({ page }) => {
    await page.route("**/api/connection", (route) =>
      route.fulfill({ status: 404, json: { error: "not_found" } }),
    );
    await page.goto("/connection");
    await expect(page.getByText("through the GitHub App")).toBeVisible();
  });
});

test.describe("the setup wizard in token mode", () => {
  test("connect: the token goes once with the setup CSRF token, then the step is done", async ({
    page,
  }) => {
    let calls = 0;
    const sent = await mockSetupToken(
      page,
      () =>
        ++calls === 1
          ? { status: 422, json: { error: "token_user_mismatch", retryAt: null } }
          : TOKEN_SAVED,
      () => api.setStatus(SETUP_FIXTURES["token-connected"]),
    );
    const api = await openSetup(page, SETUP_FIXTURES["token-required"]);
    const token = fakeToken();
    const field = page.getByLabel("Personal access token");
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toHaveAttribute("autocomplete", "off");
    await tabTo(page, field, 30);
    await page.keyboard.type(token);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      "This token belongs to another GitHub user than the one Rocky is connected to.",
    );
    await expect(field).toHaveValue("");
    await expectNoToken(page, token);
    await page.keyboard.type(token);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("link", { name: "Add repositories", exact: true })).toHaveAttribute(
      "href",
      "/connection",
    );
    await expect(page.getByText("@sam-r")).toBeVisible();
    await expectNoToken(page, token);
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/api/setup/token",
        csrf: SETUP_FIXTURES.fresh.csrfToken,
        body: { token },
      },
      {
        method: "POST",
        path: "/api/setup/token",
        csrf: SETUP_FIXTURES.fresh.csrfToken,
        body: { token },
      },
    ]);
  });

  test("a rate limit says when to try again, in local time", async ({ page }) => {
    await mockSetupToken(page, () => ({
      status: 429,
      json: { error: "rate_limited", retryAt: "2026-10-25T12:40:00.000Z" },
    }));
    await openSetup(page, SETUP_FIXTURES["token-required"]);
    await page.getByLabel("Personal access token").fill(fakeToken());
    await button(page, "Connect").click();
    await expect(page.getByRole("alert")).toHaveText(
      "GitHub's rate limit for this token is used up. Try again after 12:40.",
    );
  });

  test("App mode: the token alternative is collapsed, opens by keyboard, links the guide", async ({
    page,
  }) => {
    await openSetup(page, SETUP_FIXTURES.fresh);
    const summary = page.getByText("Can’t install a GitHub App? Use a personal token instead");
    await expect(page.getByText("Reviews are posted as you")).toBeHidden();
    await tabTo(page, summary, 20);
    await page.keyboard.press("Enter");
    await expect(page.getByText("Reviews are posted as you")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Plan B: a personal access token" }),
    ).toHaveAttribute("href", /setup\.md#plan-b-a-personal-access-token$/);
  });
});

test.describe("the inbox in token mode", () => {
  test("while the sync runs it asks again, then stops once it is done", async ({ page }) => {
    const api = await openTokenInbox(page, INBOX_SYNC.running);
    await expect(page.getByText("Syncing with GitHub…")).toBeVisible();
    const before = api.loads();
    // Asked again about every 3 s while it runs.
    await expect.poll(() => api.loads(), { timeout: 8_000 }).toBeGreaterThan(before);
    api.setSync(INBOX_SYNC.synced);
    await expect(page.getByText("Last synced 3 min ago")).toBeVisible({ timeout: 6_000 });
    const done = api.loads();
    await page.waitForTimeout(3_500);
    expect(api.loads()).toBe(done);
  });

  test("Sync posts with the CSRF token and loads the inbox again", async ({ page }) => {
    const api = await openTokenInbox(page, INBOX_SYNC.synced);
    const before = api.loads();
    const sync = page.getByRole("button", { name: "Sync", exact: true });
    await tabTo(page, sync, 6);
    await page.keyboard.press("Enter");
    await expect(page.locator(".sync-bar [role=status]")).toHaveText("Synced with GitHub.");
    await expect.poll(() => api.loads()).toBe(before + 1);
    expect(api.sent).toEqual([
      { method: "POST", path: "/api/connection/sync", csrf: CSRF, body: {} },
    ]);
  });

  test("a refused token is an alert linking to the connection page", async ({ page }) => {
    await openTokenInbox(page, INBOX_SYNC.tokenRejected);
    await expect(page.getByRole("alert")).toContainText("GitHub no longer accepts the token");
    await expect(page.getByRole("link", { name: "Replace the token" })).toHaveAttribute(
      "href",
      "/connection",
    );
  });

  test("signed out in token mode: the one-time link from the log, no GitHub login", async ({
    page,
  }) => {
    await page.route("**/api/session", (route) =>
      route.fulfill({ status: 401, json: { authenticated: false, signIn: "token_link" } }),
    );
    await page.route("**/api/inbox", (route) =>
      route.fulfill({ status: 401, json: { error: "unauthenticated" } }),
    );
    await page.goto("/inbox");
    await expect(page.getByText("Open the one-time sign-in link")).toBeVisible();
    await expect(
      page.getByText("docker compose logs server | grep /auth/token/start"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveCount(0);
  });
});

test.describe("axe", () => {
  for (const mode of MODES) {
    for (const size of WIDTHS) {
      test(`no serious issues in token mode, ${size.width} ${mode}`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openConnection(page);
        expect(await seriousViolations(page), "connection").toEqual([]);
        await button(page, "Add repository").click();
        await expect(page.getByText("Following").first()).toBeVisible();
        expect(await seriousViolations(page), "picker").toEqual([]);
        await page.keyboard.press("Escape");
        await button(page, "Replace token").click();
        expect(await seriousViolations(page), "replace").toEqual([]);
        await page.unrouteAll();
        await openSetup(page, SETUP_FIXTURES.fresh);
        await page.locator(".setup-alt summary").click();
        expect(await seriousViolations(page), "app-mode alternative").toEqual([]);
        await page.unrouteAll();
        await openTokenInbox(page, INBOX_SYNC.running);
        expect(await seriousViolations(page), "inbox running").toEqual([]);
        await page.unrouteAll();
        await openTokenInbox(page, INBOX_SYNC.rateLimited);
        expect(await seriousViolations(page), "inbox rate limited").toEqual([]);
      });
    }
  }
});
