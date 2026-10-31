import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openFile } from "./diff-support.js";
import {
  mockPullApi,
  openRealPr,
  serverDiffData,
  type Answer,
  type PullApi,
} from "./real-pr-support.js";
import { MODES, settle, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * H4-2 acceptance (screenshots): a real PR address read from the server (the shell with what
 * the mirror lacks left out), and the states before it can be shown: loading, signed out, not
 * found, repository access not available yet; plus the inbox's 503 and an address that names no
 * page. H4-3: the file view with the diff from the server, truncated, and each state the diff
 * endpoint can answer (not found, head moved, commits unavailable, too large, access
 * unavailable, GitHub failed, rate limited, signed out).
 * 375/1024/1440 px x light/dark. Baselines in e2e/__screenshots__/, copies for the PR in
 * artifacts/screenshots/H4-2/ and artifacts/screenshots/H4-3/.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/H4-2");
const OUT_DIFF = join(ROOT, "artifacts/screenshots/H4-3");

const FILE = "src/auth/invitations.ts";

type State = {
  id: string;
  answer?: Answer;
  /** H4-3: the diff endpoint's answer (default: pr-847's whole diff). */
  diff?: Answer;
  path?: string;
  /** Viewport only (the shell scrolls inside its columns). */
  viewport?: boolean;
  run?: (page: Page, api: PullApi) => Promise<void>;
};

/** Opens the file and waits for the diff's status line (its lines, or a state's text). */
const openFileState = async (page: Page) => {
  const width = page.viewportSize()?.width ?? 1440;
  if (width <= 760) await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.locator(`#sidebar button.nav-file[title="${FILE}"]`).click();
  await page.locator(".file-head").waitFor();
  await page.locator(".diff-status").waitFor();
};

const diffState = (id: string, diff: Answer): State => ({
  id,
  diff,
  viewport: true,
  run: openFileState,
});

const STATES: State[] = [
  {
    id: "real-pr",
    viewport: true,
    run: async (page) => {
      await page.locator("#main .map-scroll svg").waitFor();
    },
  },
  {
    id: "real-pr-loading",
    run: async (page) => {
      await expect(page.getByRole("status")).toHaveText("Loading…");
    },
  },
  { id: "real-pr-signed-out", answer: { status: 401, body: { error: "unauthenticated" } } },
  { id: "real-pr-not-found", answer: { status: 404, body: { error: "not_found" } } },
  {
    id: "real-pr-unavailable",
    answer: { status: 503, body: { error: "access_check_unavailable" } },
  },
  {
    id: "inbox-unavailable",
    path: "/inbox",
    run: async (page) => {
      await expect(page.getByRole("alert")).toContainText("Repository access");
    },
  },
  { id: "no-page", path: "/acme/rocky-app/pulls/847" },
  // H4-3: the file view on a real PR, from the server's diff.
  {
    id: "real-pr-diff",
    viewport: true,
    run: async (page) => {
      await openFile(page, FILE);
    },
  },
  diffState("real-pr-diff-truncated", {
    status: 200,
    body: serverDiffData({ truncation: "max_bytes" }),
  }),
  diffState("real-pr-diff-not-found", { status: 404, body: { error: "not_found" } }),
  diffState("real-pr-diff-head-moved", { status: 409, body: { error: "head_moved" } }),
  diffState("real-pr-diff-commits-unavailable", {
    status: 409,
    body: { error: "commits_unavailable" },
  }),
  diffState("real-pr-diff-too-large", { status: 413, body: { error: "diff_too_large" } }),
  diffState("real-pr-diff-unavailable", {
    status: 503,
    body: { error: "access_check_unavailable" },
  }),
  diffState("real-pr-diff-failed", { status: 502, body: { error: "forge_unavailable" } }),
  diffState("real-pr-diff-rate-limited", { status: 429, body: { error: "rate_limited" } }),
  diffState("real-pr-diff-signed-out", { status: 401, body: { error: "unauthenticated" } }),
];

for (const state of STATES) {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        const api = await mockPullApi(page, state.answer, state.diff);
        await page.route("**/api/inbox", (route) =>
          route.fulfill({ status: 503, json: { error: "access_check_unavailable" } }),
        );
        if (state.id === "real-pr-loading") api.hold();
        await openRealPr(page, state.path);
        await settle(page);
        if (state.answer !== undefined && state.answer.status !== 200)
          await page.locator("#main p").waitFor();
        await state.run?.(page, api);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
        const fullPage = state.viewport !== true;
        await expect(page).toHaveScreenshot(`${name}.png`, { fullPage });
        const out = state.id.startsWith("real-pr-diff") ? OUT_DIFF : OUT;
        await mkdir(out, { recursive: true });
        await page.screenshot({ path: join(out, `${name}.png`), fullPage });
      });
    }
  }
}
