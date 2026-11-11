import type { Page } from "@playwright/test";
import type { SetupStatusResponse } from "@rocky-reviews/core";
import { SETUP_FIXTURES } from "../src/setup/fixtures.js";

export { SETUP_FIXTURES };

export interface SetupApiMock {
  /** Every POST (path and CSRF header), in order. */
  readonly posts: { path: string; csrf: string | null }[];
  /** The next status answers this (the test call and finish change what the server says). */
  setStatus(status: SetupStatusResponse | number): void;
}

/**
 * Opens `/setup` with the server's setup API answered here (no server): the status (a fixture,
 * or an HTTP status for the refusals), the test call (the `created` fixture's results) and
 * finish. P10-2.
 */
export const openSetup = async (
  page: Page,
  initial: SetupStatusResponse | number = SETUP_FIXTURES.fresh,
): Promise<SetupApiMock> => {
  let status = initial;
  const posts: SetupApiMock["posts"] = [];
  await page.route("**/api/setup/status", (route) =>
    typeof status === "number"
      ? route.fulfill({ status, json: { error: "x" } })
      : route.fulfill({ json: status }),
  );
  await page.route("**/api/setup/llm-test", (route) => {
    posts.push({
      path: "/api/setup/llm-test",
      csrf: route.request().headers()["x-rocky-csrf"] ?? null,
    });
    const results = SETUP_FIXTURES.created.llm.results;
    if (typeof status !== "number") {
      status = { ...status, llm: { ...status.llm, state: "ok", results } };
    }
    return route.fulfill({ json: { results } });
  });
  await page.route("**/api/setup/finish", (route) => {
    posts.push({
      path: "/api/setup/finish",
      csrf: route.request().headers()["x-rocky-csrf"] ?? null,
    });
    return route.fulfill({ json: { closed: true } });
  });
  await page.goto("/setup");
  if (typeof initial !== "number") await page.locator("#setup-intro-title").waitFor();
  return {
    posts,
    setStatus: (next) => {
      status = next;
    },
  };
};
