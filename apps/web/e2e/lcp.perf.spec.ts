import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * P6-8 acceptance: "LCP < 1.5 s on the PR page with cached data" (ADR 0032).
 *
 * On the production build (the `perf` project's server), the PR page (pr-847, briefing and
 * change map) is opened once to fill the HTTP cache, then opened RUNS more times; each time a
 * PerformanceObserver (installed before the page's own scripts) records the Largest Contentful
 * Paint. The data is "cached": the PR's data is in the bundle (fixture source) and the drafts
 * API answers at once. Profile, for every measured load:
 * - CPU: Chrome throttled 4x (`PERF_CPU_THROTTLE`), the mid-range laptop of P6-3;
 * - network: 40 ms round trip, 10 Mbit/s down, 5 Mbit/s up (a good home connection);
 * - cache: warm, with the production server's headers: /assets/ immutable, the page and
 *   public files revalidated (`no-cache`). The test checks that no script or stylesheet body
 *   was downloaded again on a measured load.
 *
 * The drafts API and the headers are handled through the DevTools protocol, not `page.route`:
 * Playwright turns the HTTP cache off while any route is set, which would make this a cold load.
 *
 * Asserted: the LCP element is in the briefing (not the loading line), and the median LCP of
 * the runs at 1440 px and at 375 px is below the budget, 1.5 s, and no run is above it by more
 * than 20 % (a single slow sample on a busy machine is noise, a pattern is not).
 * CI (ADR 0032) runs it unthrottled (`PERF_CPU_THROTTLE=1`) to catch gross regressions on a
 * runner whose speed is unknown; `LCP_BUDGET_MS` can move the budget. Evidence:
 * artifacts/perf/P6-8/lcp.json.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/perf/P6-8");

/** A positive number from the environment, or the default; anything else stops the run. */
const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

const BUDGET_MS = envNumber("LCP_BUDGET_MS", 1500);
const RUNS = 5;
const THROTTLE = envNumber("PERF_CPU_THROTTLE", 4);
const NETWORK = {
  offline: false,
  latency: 40,
  downloadThroughput: (10 * 1000 * 1000) / 8,
  uploadThroughput: (5 * 1000 * 1000) / 8,
};

/** A live session: expiry dates in the future of whenever the test runs. */
const session = () => ({
  authenticated: true,
  user: { id: "u1", forgeUserId: 1 },
  orgs: [],
  activeOrgId: null,
  csrfToken: "lcp-csrf-token",
  expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  idleExpiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
});

/** The production server's cache header for hashed files (apps/server/src/web-app.ts). */
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serves like production without touching Playwright's routing (see above): /api/* is answered
 * from the test, and /assets/* (content-hashed) gets the production server's cache header
 * instead of `vite preview`'s `no-cache`. index.html and public files keep `no-cache`, as in
 * production, so each load still asks the server for the page.
 */
const serveLikeProduction = async (cdp: CDPSession): Promise<void> => {
  cdp.on("Fetch.requestPaused", (event) => {
    const { pathname } = new URL(event.request.url);
    if (event.responseStatusCode !== undefined) {
      const headers = (event.responseHeaders ?? []).filter(
        (h) => h.name.toLowerCase() !== "cache-control",
      );
      void cdp
        .send("Fetch.continueResponse", {
          requestId: event.requestId,
          responseCode: event.responseStatusCode,
          responseHeaders: [...headers, { name: "cache-control", value: IMMUTABLE }],
        })
        .catch(() => undefined);
      return;
    }
    const review = /^\/api\/analyses\/([0-9a-f-]{36})\/review$/.exec(pathname);
    const [status, body] =
      pathname === "/api/session"
        ? [200, session()]
        : review !== null && event.request.method === "GET"
          ? [200, { analysisId: review[1], drafts: [], comments: [] }]
          : [404, { error: "not_found" }];
    void cdp
      .send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: status,
        responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "cache-control", value: "no-store" },
        ],
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
      })
      .catch(() => undefined);
  });
  await cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/*", requestStage: "Request" },
      { urlPattern: "*/assets/*", requestStage: "Response" },
    ],
  });
};

/** What the page's observer keeps per LCP entry: tag, id and class, never the text. */
type LcpEntry = { startTime: number; element: string; inBriefing: boolean };

type Sample = {
  lcpMs: number;
  fcpMs: number;
  lcpElement: string;
  /** The LCP element is inside the briefing card. */
  lcpInBriefing: boolean;
  /** Scripts and stylesheets whose body came over the network on this load. */
  downloaded: string[];
};

/** Opens the PR page and reads its LCP once the page has settled. */
const measure = async (page: Page): Promise<Sample> => {
  await page.goto("/", { waitUntil: "load" });
  await page.locator("#briefing-title").waitFor();
  await page.locator("#main .map-scroll svg").waitFor();
  // LCP is final once nothing larger paints; at 4x CPU everything has painted well before this.
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const w = window as unknown as { __lcp: LcpEntry[] };
    const last = w.__lcp.at(-1);
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const downloaded = performance
      .getEntriesByType("resource")
      .filter((e): e is PerformanceResourceTiming => e instanceof PerformanceResourceTiming)
      .filter((e) => e.initiatorType === "script" || e.initiatorType === "link")
      // A body came over the network: a cache hit has no transfer, a 304 no body.
      .filter((e) => e.transferSize > 0 && e.encodedBodySize > 0)
      .map((e) => new URL(e.name).pathname);
    return {
      lcpMs: Math.round(last?.startTime ?? Number.POSITIVE_INFINITY),
      fcpMs: Math.round(fcp?.startTime ?? Number.POSITIVE_INFINITY),
      lcpElement: last?.element ?? "none",
      lcpInBriefing: last?.inBriefing ?? false,
      downloaded,
    };
  });
};

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
};

const results: Record<string, { medianLcpMs: number; samples: Sample[] }> = {};

test.afterAll(async () => {
  await mkdir(OUT, { recursive: true });
  const profile = { cpuThrottle: THROTTLE, network: NETWORK, runs: RUNS, budgetMs: BUDGET_MS };
  await writeFile(join(OUT, "lcp.json"), `${JSON.stringify({ profile, results }, null, 2)}\n`);
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test(`PR page LCP with cached data is under ${BUDGET_MS} ms at ${size.width} px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: LcpEntry[] };
      w.__lcp = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { element?: Element })[]) {
          const el = entry.element;
          // Tag, id and class only: never the element's text.
          const name = el ? `${el.tagName.toLowerCase()}#${el.id}.${el.getAttribute("class")}` : "";
          w.__lcp.push({
            startTime: entry.startTime,
            element: name,
            inBriefing: el?.closest("#main .brief") != null,
          });
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
    const cdp = await page.context().newCDPSession(page);
    await serveLikeProduction(cdp);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", NETWORK);

    // Fill the cache, then measure with the CPU throttled.
    const cold = await measure(page);
    expect(cold.downloaded.length, "the first load downloads the app").toBeGreaterThan(0);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    const samples: Sample[] = [];
    for (let i = 0; i < RUNS; i++) samples.push(await measure(page));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

    const lcp = samples.map((s) => s.lcpMs);
    results[`${size.width}px`] = { medianLcpMs: median(lcp), samples };

    for (const sample of samples) {
      expect(sample.downloaded, "warm cache").toEqual([]);
      // The paint measured is the briefing's content, not the "Loading…" line or an error.
      expect(sample.lcpInBriefing, `LCP element ${sample.lcpElement}`).toBe(true);
    }
    expect(median(lcp), `median LCP of ${lcp.join(", ")} ms`).toBeLessThan(BUDGET_MS);
    expect(Math.max(...lcp), "slowest run").toBeLessThan(BUDGET_MS * 1.2);
  });
}
