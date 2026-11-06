import type { Page, Request } from "@playwright/test";
import { MEMORY_FIXTURE, memoryEntryId } from "../src/memory/fixtures.js";
import { CSRF_TOKEN } from "./inbox-support.js";
import { FIXTURE_NOW } from "./support.js";

export { MEMORY_FIXTURE, memoryEntryId };

export const MEMORY_PAGE = "/acme/rocky-app/memory";
export const MEMORY_API = "/api/repos/acme/rocky-app/memory";

/** Opens the memory page on the fixture source (no server; `?source=fixture`), fixed clock. */
export const openMemory = async (
  page: Page,
  options: { readonly as?: "member" } = {},
): Promise<void> => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(`${MEMORY_PAGE}?source=fixture${options.as === "member" ? "&as=member" : ""}`);
  await page.locator("#memory-page-title").waitFor();
};

export interface MemoryApiMock {
  /** Every change sent to the memory API (method, path, CSRF header, body), in order. */
  readonly changes: { method: string; path: string; csrf: string | null; body: unknown }[];
  readonly loads: () => number;
}

/**
 * Opens the memory page on the HTTP source (the default) with the server's routes answered
 * here: the session (for the CSRF token), the list (the fixture, or `list`), each change (200),
 * and the export (a `context.md` download).
 */
export const openMemoryApi = async (
  page: Page,
  options: { readonly list?: unknown; readonly answer?: (request: Request) => number } = {},
): Promise<MemoryApiMock> => {
  const changes: MemoryApiMock["changes"] = [];
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: "u1", forgeUserId: 1 },
        orgs: [],
        activeOrgId: null,
        csrfToken: CSRF_TOKEN,
        expiresAt: "2026-10-26T00:00:00.000Z",
        idleExpiresAt: "2026-10-26T00:00:00.000Z",
      },
    }),
  );
  let loads = 0;
  await page.route(`**${MEMORY_API}`, (route) => {
    loads += 1;
    return route.fulfill({ json: options.list ?? MEMORY_FIXTURE });
  });
  await page.route(`**${MEMORY_API}/export`, (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": 'attachment; filename="context.md"',
      },
      body: "# Project memory: acme/rocky-app\n\nFormat: rocky-memory-export 1\n\nNo entries.\n",
    }),
  );
  await page.route(`**${MEMORY_API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/export")) return route.fallback();
    changes.push({
      method: request.method(),
      path,
      csrf: (await request.headerValue("x-rocky-csrf")) ?? null,
      body: request.postData() === null ? null : request.postDataJSON(),
    });
    const status = options.answer?.(request) ?? 200;
    await route.fulfill({ status, json: status === 200 ? {} : { error: "already_superseded" } });
  });
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(MEMORY_PAGE);
  await page.locator("#memory-page-title").waitFor();
  return { changes, loads: () => loads };
};

/** The list item of one fixture entry. */
export const entryItem = (page: Page, n: number) =>
  page.locator(`.memory-entry[data-entry="${memoryEntryId(n)}"]`);
