import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "./axe.js";
import { CSRF_TOKEN } from "./inbox-support.js";
import {
  entryItem,
  MEMORY_API,
  MEMORY_PAGE,
  memoryEntryId,
  openMemory,
  openMemoryApi,
} from "./memory-support.js";
import { MODES } from "./support.js";

/**
 * P8-3 (ADR 0039): the memory page's behaviour in a browser. Every change goes to the server with
 * the CSRF token and the page shows the server's list afterwards; a member gets no controls; the
 * export is a `context.md` download from the server; the keyboard reaches every control and the
 * dialog keeps focus safe; axe finds nothing serious in any state.
 */

const status = (page: Page) => page.locator(".memory-status");

test.describe("changes go to the server", () => {
  test("edit, switch off, delete and the repository switch, each with the CSRF token", async ({
    page,
  }) => {
    const api = await openMemoryApi(page);
    const first = memoryEntryId(1);
    const opened = api.loads();

    await entryItem(page, 1).getByRole("button", { name: "Edit" }).click();
    await page.getByRole("combobox", { name: "Reason" }).selectOption("not_an_issue");
    await page.getByRole("textbox", { name: "Text" }).fill("Retries cover swallowed errors here.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(status(page)).toHaveText("Saved. The earlier version is kept as history.");

    await entryItem(page, 1).getByRole("button", { name: "Switch off" }).click();
    await expect(status(page)).toContainText("Switched off");

    await entryItem(page, 2).getByRole("button", { name: "Delete…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete entry" }).click();
    await expect(status(page)).toHaveText("Deleted, with 1 earlier version.");

    // The mock answers the same list, so the switch shows the server's state (still on).
    await page.getByRole("switch", { name: /Use project memory/ }).click();
    await expect(status(page)).toContainText("Memory is off");

    expect(api.changes).toEqual([
      {
        method: "POST",
        path: `${MEMORY_API}/entries/${first}/edit`,
        csrf: CSRF_TOKEN,
        body: {
          kind: "dismissal",
          text: "Retries cover swallowed errors here.",
          reason: "not_an_issue",
        },
      },
      {
        method: "PUT",
        path: `${MEMORY_API}/entries/${first}/disabled`,
        csrf: CSRF_TOKEN,
        body: { disabled: true },
      },
      {
        method: "DELETE",
        path: `${MEMORY_API}/entries/${memoryEntryId(2)}`,
        csrf: CSRF_TOKEN,
        body: null,
      },
      { method: "PUT", path: `${MEMORY_API}/enabled`, csrf: CSRF_TOKEN, body: { enabled: false } },
    ]);
    // The page loads the server's list again after each change.
    await expect.poll(() => api.loads() - opened).toBe(4);
  });

  test("a refused change says so and shows the latest list", async ({ page }) => {
    const api = await openMemoryApi(page, { answer: () => 409 });
    const opened = api.loads();
    await entryItem(page, 1).getByRole("button", { name: "Switch off" }).click();
    await expect(entryItem(page, 1).getByRole("alert")).toContainText(
      "Someone changed this entry first",
    );
    await expect.poll(() => api.loads() - opened).toBe(1);
  });

  test("cancelling a delete sends nothing", async ({ page }) => {
    const api = await openMemoryApi(page);
    await entryItem(page, 1).getByRole("button", { name: "Delete…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(api.changes).toEqual([]);
  });

  test("the export is a context.md download from the server", async ({ page }) => {
    await openMemoryApi(page);
    const link = page.getByRole("link", { name: "Export context.md" });
    await expect(link).toHaveAttribute("href", `${MEMORY_API}/export`);
    await expect(link).toHaveAttribute("download", "context.md");
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe("context.md");
  });

  test("a member sees the memory and the export, and no control to change it", async ({ page }) => {
    await openMemory(page, { as: "member" });
    await expect(page.locator(".memory-entry")).toHaveCount(5);
    for (const name of ["Edit", "Switch off", "Switch on", "Delete…"])
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Export context.md" })).toBeVisible();
  });

  test("an address the server does not know, or a signed-out visitor, gets a fixed message", async ({
    page,
  }) => {
    await page.route(`**${MEMORY_API}`, (route) => route.fulfill({ status: 404, json: {} }));
    await page.goto(MEMORY_PAGE);
    await expect(page.getByRole("alert")).toContainText("isn’t in Rocky");
    await page.unroute(`**${MEMORY_API}`);
    await page.route(`**${MEMORY_API}`, (route) => route.fulfill({ status: 401, json: {} }));
    await page.goto(MEMORY_PAGE);
    await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
      "href",
      `/auth/github/login?returnTo=${encodeURIComponent(MEMORY_PAGE)}`,
    );
  });
});

test.describe("keyboard", () => {
  test("edits, switches off and deletes an entry with the keyboard alone", async ({ page }) => {
    await openMemory(page);
    // Reach the first entry's Edit button by Tab from the page start.
    const edit = entryItem(page, 1).getByRole("button", { name: "Edit" });
    for (let i = 0; i < 20 && !(await edit.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press("Tab");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    const text = page.getByRole("textbox", { name: "Text" });
    await expect(text).toBeFocused();
    // Escape cancels and gives focus back to Edit.
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Keep swallowed errors only in retry loops.");
    await page.keyboard.press("Tab"); // Save
    await expect(page.getByRole("button", { name: "Save" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(status(page)).toHaveText("Saved. The earlier version is kept as history.");
    await expect(page.locator("#memory-list-title")).toBeFocused();
    await expect(page.locator(".memory-entry").first()).toContainText(
      "Keep swallowed errors only in retry loops.",
    );

    // Switch off with Space, from the button.
    const off = entryItem(page, 2).getByRole("button", { name: "Switch off" });
    await off.focus();
    await page.keyboard.press("Space");
    await expect(entryItem(page, 2)).toContainText("Switched off");

    // Delete: Cancel is focused first; Escape closes and focus returns to Delete.
    const del = entryItem(page, 4).getByRole("button", { name: "Delete…" });
    await del.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(del).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Delete entry" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(status(page)).toHaveText("Deleted.");
    await expect(entryItem(page, 4)).toHaveCount(0);
  });
});

test.describe("axe", () => {
  for (const mode of MODES) {
    test(`no serious issues in any state, ${mode}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode });
      const found: Record<string, string[]> = {};
      const check = async (state: string) => {
        const violations = await seriousViolations(page);
        if (violations.length > 0) found[state] = violations;
      };
      await openMemory(page);
      await check("admin");
      await page.getByRole("checkbox", { name: /Show earlier versions/ }).check();
      await check("earlier versions");
      await entryItem(page, 1).getByRole("button", { name: "Edit" }).click();
      await check("editing");
      await page.getByRole("button", { name: "Cancel" }).click();
      await entryItem(page, 2).getByRole("button", { name: "Delete…" }).click();
      await check("delete dialog");
      await page.keyboard.press("Escape");
      await page.getByRole("switch", { name: /Use project memory/ }).uncheck();
      await check("memory off");
      await openMemory(page, { as: "member" });
      await check("member");
      expect(found).toEqual({});
    });
  }
});
