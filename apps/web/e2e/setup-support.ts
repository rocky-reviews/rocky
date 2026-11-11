import type { Page } from "@playwright/test";
import type { SetupStatusResponse } from "@rocky-reviews/core";
import { SETUP_FIXTURES } from "../src/setup/fixtures.js";

export { SETUP_FIXTURES };

export interface SetupApiMock {
  /** Every POST (path and CSRF header), in order. */
  readonly posts: { path: string; csrf: string | null }[];
  /** The next status answers this (the test call and finish change what the server says). */
  setStatus(status: SetupStatusResponse | number): void;
  /** With `holdLlmTest`: lets the held test call answer. */
  releaseLlmTest(): void;
}

export interface SetupApiOptions {
  /** The test call answers this HTTP status (with the server's error body) instead of results. */
  readonly llmTestStatus?: 409 | 429 | 500;
  /** The test call stays in flight until `releaseLlmTest()` (the busy state). */
  readonly holdLlmTest?: boolean;
  /** Finish answers this HTTP status instead of 200. */
  readonly finishStatus?: number;
}

/**
 * Opens `/setup` with the server's setup API answered here (no server): the status (a fixture,
 * or an HTTP status for the refusals), the test call (the `created` fixture's results, a refusal,
 * or held in flight) and finish. P10-2.
 */
export const openSetup = async (
  page: Page,
  initial: SetupStatusResponse | number = SETUP_FIXTURES.fresh,
  options: SetupApiOptions = {},
): Promise<SetupApiMock> => {
  let status = initial;
  const posts: SetupApiMock["posts"] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/setup/status", (route) =>
    typeof status === "number"
      ? route.fulfill({ status, json: { error: "x" } })
      : route.fulfill({ json: status }),
  );
  await page.route("**/api/setup/llm-test", async (route) => {
    posts.push({
      path: "/api/setup/llm-test",
      csrf: route.request().headers()["x-rocky-csrf"] ?? null,
    });
    if (options.holdLlmTest === true) await held;
    if (options.llmTestStatus !== undefined) {
      const error = options.llmTestStatus === 429 ? "too_soon" : "busy";
      return route.fulfill({ status: options.llmTestStatus, json: { error } });
    }
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
    return options.finishStatus === undefined
      ? route.fulfill({ json: { closed: true } })
      : route.fulfill({ status: options.finishStatus, json: { error: "x" } });
  });
  await page.goto("/setup");
  if (typeof initial !== "number") await page.locator("#setup-intro-title").waitFor();
  return {
    posts,
    setStatus: (next) => {
      status = next;
    },
    releaseLlmTest: () => release(),
  };
};
