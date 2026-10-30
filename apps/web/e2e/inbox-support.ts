import type { Page, Request } from "@playwright/test";
import { INBOX_FIXTURE } from "../src/inbox/fixtures.js";
import { FIXTURE_NOW } from "./support.js";

export { INBOX_FIXTURE };

export const CSRF_TOKEN = "csrf-token-for-e2e";

/** The pull request ids of the fixture, by number. */
export const idOf = (number: number): string => {
  const item = INBOX_FIXTURE.items.find((i) => i.number === number);
  if (item === undefined) throw new Error(`no fixture PR #${number}`);
  return item.id;
};
export const headOf = (number: number): string => {
  const item = INBOX_FIXTURE.items.find((i) => i.number === number);
  if (item === undefined) throw new Error(`no fixture PR #${number}`);
  return item.headSha;
};

/** Matches a PR's "#number" in an accessible name (built, so it reads as no colour literal). */
export const numbered = (number: number): RegExp => new RegExp(`#${number}\\b`);

/** Opens the inbox on the fixture source (no server; H4-2: `?source=fixture`), fixed clock. */
export const openInbox = async (page: Page): Promise<void> => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/inbox?source=fixture");
  await page.locator("#inbox-title").waitFor();
};

export interface ApiMock {
  /** Every POST to the approvals route, in order. */
  readonly posts: Request[];
  /** How many times the page loaded the list. */
  readonly loads: () => number;
}

type ApproveAnswer = { status: number; body: unknown };

/**
 * Opens the inbox on the HTTP source (the default since H4-2) with the server's routes answered here:
 * the session (for the CSRF token), the list (the fixture) and the approvals route, whose every
 * request is recorded so a test can prove what was (and was not) sent.
 */
export const openInboxApi = async (
  page: Page,
  answer: (body: { pullRequests: { id: string; headSha: string }[] }) => ApproveAnswer = (
    body,
  ) => ({
    status: 200,
    body: { results: body.pullRequests.map((p) => ({ id: p.id, outcome: "approved" })) },
  }),
): Promise<ApiMock> => {
  const posts: Request[] = [];
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
  await page.route("**/api/inbox", (route) => {
    loads += 1;
    return route.fulfill({ json: INBOX_FIXTURE });
  });
  await page.route("**/api/inbox/approvals", async (route) => {
    const request = route.request();
    posts.push(request);
    const { status, body } = answer(request.postDataJSON() as never);
    await route.fulfill({ status, json: body });
  });
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/inbox");
  await page.locator("#inbox-title").waitFor();
  return { posts, loads: () => loads };
};
