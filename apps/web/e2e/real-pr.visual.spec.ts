import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mockPullApi, openRealPr, type Answer, type PullApi } from "./real-pr-support.js";
import { MODES, settle, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * H4-2 acceptance (screenshots): a real PR address read from the server (the shell with what
 * the mirror lacks left out), and the states before it can be shown: loading, signed out, not
 * found, repository access not available yet; plus the inbox's 503 and an address that names no
 * page. 375/1024/1440 px x light/dark. Baselines in e2e/__screenshots__/, copies for the PR in
 * artifacts/screenshots/H4-2/.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/H4-2");

type State = {
  id: string;
  answer?: Answer;
  path?: string;
  /** Viewport only (the shell scrolls inside its columns). */
  viewport?: boolean;
  run?: (page: Page, api: PullApi) => Promise<void>;
};

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
];

for (const state of STATES) {
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        const api = await mockPullApi(page, state.answer);
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
        await mkdir(OUT, { recursive: true });
        await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
      });
    }
  }
}
