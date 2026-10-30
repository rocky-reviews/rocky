import { test as base } from "@playwright/test";
import { mockReviewApi, type ReviewApi } from "./review-api.js";

/**
 * Playwright's `test` with the drafts API answered for every page (P6-4): the app reads and
 * writes the reviewer's drafts over HTTP, and the e2e and visual suites have no server.
 */
export const test = base.extend<{ reviewApi: ReviewApi }>({
  reviewApi: [
    async ({ page }, use) => {
      await use(await mockReviewApi(page));
    },
    { auto: true },
  ],
});

export { expect, type Page } from "@playwright/test";
