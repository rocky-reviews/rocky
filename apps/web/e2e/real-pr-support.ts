import type { Page, Request } from "@playwright/test";
import { pr847Diff } from "@rocky-reviews/evals/pr-847/diff";
import pr847 from "../../../packages/schema/fixtures/pr-847.json" with { type: "json" };
import { PR_847_ANALYSIS, PR_847_PULL_REQUEST } from "./review-api.js";
import { FIXTURE_NOW } from "./support.js";

/**
 * H4-2: the server's PR page endpoint (`GET /api/repos/:owner/:repo/pulls/:number`) for the
 * e2e and visual suites, and H4-3: its diff (`GET …/pulls/:number/diff`). The page runs its
 * real HTTP sources; Playwright answers here, in the shape the server sends
 * (apps/server/src/pulls/routes.ts and diff-routes.ts, tested on Postgres there): what the
 * mirror does not hold is null. pr-847's ids are the drafts and posting mock's (review-api.ts).
 */

export const REAL_PR_PATH = "/acme/rocky-app/pull/847";
export const REAL_PR_API = "/api/repos/acme/rocky-app/pulls/847";
export const REAL_PR_DIFF_API = `${REAL_PR_API}/diff`;

/** pr-847's diff as the server answers it (H4-3): the evals package's copy, whole. */
export const serverDiffData = (overrides: Record<string, unknown> = {}) => ({
  headSha: pr847.provenance.head.sha,
  diff: pr847Diff(),
  truncation: null,
  ...overrides,
});

/**
 * GitHub's view of pr-847 as the server's mirror holds it (the fixture source's `PR_847_PULL`,
 * which the e2e suite cannot import: it loads JSON without an import attribute).
 */
const PULL = {
  owner: "acme",
  repo: "rocky-app",
  number: 847,
  title: "Team invitations with expiring links",
  author: "dana-k",
  state: "open",
  headRef: null,
  baseRef: null,
  headSha: pr847.provenance.head.sha,
  additions: 215,
  deletions: 3,
  changedFiles: 9,
  updatedAt: "2026-10-25T12:00:00.000Z",
  approvers: null,
  commentCount: null,
};

/** pr-847 as the server answers it. */
export const serverShellData = (overrides: Record<string, unknown> = {}) => ({
  pullRequestId: PR_847_PULL_REQUEST,
  pull: PULL,
  myReview: null,
  analysis: pr847,
  analysisId: PR_847_ANALYSIS,
  analysisRun: { status: "done" },
  ...overrides,
});

export type Answer = { readonly status: number; readonly body?: unknown };

export interface PullApi {
  /** Every request for the PR's data, in order. */
  readonly requests: Request[];
  /** Holds every answer until the returned function is called. */
  hold(): () => void;
}

/**
 * Answers the PR page endpoint (any PR) with `answer` and its diff endpoint with `diff`
 * (default: pr-847's whole diff), recording each request.
 */
export const mockPullApi = async (
  page: Page,
  answer: Answer | ((path: string) => Answer) = { status: 200, body: serverShellData() },
  diff: Answer | ((path: string) => Answer) = { status: 200, body: serverDiffData() },
): Promise<PullApi> => {
  const requests: Request[] = [];
  let held: Promise<void> | null = null;
  await page.route("**/api/repos/**", async (route) => {
    requests.push(route.request());
    if (held !== null) await held;
    const { pathname } = new URL(route.request().url());
    const chosen = pathname.endsWith("/diff") ? diff : answer;
    const { status, body } = typeof chosen === "function" ? chosen(pathname) : chosen;
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(body ?? { error: "x" }),
    });
  });
  return {
    requests,
    hold: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
  };
};

/** Opens a real PR address with a fixed clock; resolves once the page shows something. */
export const openRealPr = async (page: Page, path = REAL_PR_PATH): Promise<void> => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(path);
  await page.locator("#main").waitFor();
};
