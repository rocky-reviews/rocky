import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * P6-3 acceptance: a 5,000-line diff scrolls at 60 fps on a mid-range laptop.
 *
 * On the production build, the page opens the generated 5,000-line fixture
 * (`?fixture=large-diff`); Chrome's CPU is throttled to stand in for a mid-range laptop
 * (`PERF_CPU_THROTTLE`, default 4x); and the main column is scrolled from the top of the diff to
 * its end at a fixed speed, one step per animation frame, while a Chrome performance trace
 * records. Moving `scrollTop` from requestAnimationFrame keeps the main thread in every frame
 * (rows must be rendered as they arrive), which is stricter than a compositor-only wheel scroll.
 *
 * No Playwright clock is installed: it would replace requestAnimationFrame with a 16 ms timer
 * (the test checks rAF is native before measuring). The "updated N ago" text is not asserted.
 *
 * Asserted:
 * - Chrome's own frame accounting in the trace (PipelineReporter, main frames only: FORKED
 *   reports duplicate a frame's sequence number and are skipped, and frames are deduplicated by
 *   sequence): at most 2 % dropped, at most 5 % presented partially, and at least 95 % as many
 *   presented frames as rAF callbacks;
 * - frame intervals seen by requestAnimationFrame: mean rate ≥ 58 fps and at most 5 % of
 *   intervals over 1.5 frames (25 ms);
 * - no long task (over 50 ms) on the renderer main thread while scrolling;
 * - the viewport never shows a gap where rows should be, and the DOM holds a bounded slice of
 *   the rows, never the whole file.
 *
 * Evidence: artifacts/perf/P6-3/diff-scroll-trace.json (load it in Chrome DevTools' Performance
 * panel or ui.perfetto.dev) and diff-scroll-summary.json beside it.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/perf/P6-3");
const TRACE = join(OUT, "diff-scroll-trace.json");
const SUMMARY = join(OUT, "diff-scroll-summary.json");

const THROTTLE = Number(process.env.PERF_CPU_THROTTLE ?? 4);
/** Pixels per frame: about 7,200 px/s at 60 fps, a fast flick held for the whole file. */
const SPEED = 120;
const FRAME_MS = 1000 / 60;
const START = "p6-3-scroll-start";
const END = "p6-3-scroll-end";

type TraceEvent = {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: {
    name?: string;
    data?: { message?: string };
    frame_reporter?: FrameReport;
    chrome_frame_reporter?: FrameReport;
  };
};

type FrameReport = { state?: string; frame_type?: string; frame_sequence?: number };

const round = (n: number) => Math.round(n * 10) / 10;

/** Frame states and long tasks of the renderer between the two console.timeStamp markers. */
const analyseTrace = (events: readonly TraceEvent[]) => {
  const marker = (message: string) =>
    events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === message);
  const start = marker(START);
  const end = marker(END);
  if (start === undefined || end === undefined) throw new Error("scroll markers missing");
  const inWindow = (e: TraceEvent) => e.ts >= start.ts && e.ts <= end.ts;
  const renderer = start.pid;

  // One report per main frame: FORKED reports repeat a sequence number for a forked pipeline.
  const bySequence = new Map<number, string>();
  for (const e of events) {
    if (e.name !== "PipelineReporter" || e.ph !== "b" || e.pid !== renderer || !inWindow(e))
      continue;
    const report = e.args?.frame_reporter ?? e.args?.chrome_frame_reporter;
    if (report === undefined || report.frame_type === "FORKED") continue;
    const sequence = report.frame_sequence ?? -bySequence.size - 1;
    if (!bySequence.has(sequence)) bySequence.set(sequence, report.state ?? "?");
  }
  const states = new Map<string, number>();
  for (const state of bySequence.values()) states.set(state, (states.get(state) ?? 0) + 1);
  const all = states.get("STATE_PRESENTED_ALL") ?? 0;
  const partial = states.get("STATE_PRESENTED_PARTIAL") ?? 0;
  const dropped = states.get("STATE_DROPPED") ?? 0;
  const counted = Math.max(1, all + partial + dropped);

  const longTasks = events
    .filter(
      (e) =>
        e.name === "RunTask" &&
        e.pid === renderer &&
        e.tid === start.tid &&
        inWindow(e) &&
        (e.dur ?? 0) > 50_000,
    )
    .map((e) => (e.dur ?? 0) / 1000);

  return {
    traceDurationMs: Math.round((end.ts - start.ts) / 1000),
    frameStates: Object.fromEntries(states),
    framesPresented: all + partial,
    framesPresentedPartial: partial,
    framesDropped: dropped,
    droppedRatio: Math.round((dropped / counted) * 1000) / 1000,
    partialRatio: Math.round((partial / counted) * 1000) / 1000,
    longTasks: longTasks.length,
    longestTaskMs: Math.round(Math.max(0, ...longTasks)),
  };
};

test("a 5,000-line diff scrolls at 60 fps (Chrome trace, CPU throttled)", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?fixture=large-diff");
  // Measure real frames: requestAnimationFrame must be the browser's, not a fake timer.
  const rafSource = await page.evaluate(() =>
    Function.prototype.toString.call(requestAnimationFrame),
  );
  expect(rafSource).toMatch(/\[native code\]/);
  await page
    .locator("#sidebar")
    .getByRole("button", { name: "src/billing/ledger-rules.ts" })
    .click();
  await page.locator(".diff .ln").first().waitFor();
  const fullHeight = await page.evaluate(
    () => document.querySelector<HTMLElement>(".diff")?.offsetHeight ?? 0,
  );
  expect(fullHeight, "the diff is laid out at full height").toBeGreaterThan(100_000);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  await mkdir(OUT, { recursive: true });
  await browser.startTracing(page, {
    path: TRACE,
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "toplevel",
      "cc",
    ],
  });

  const inPage = await page.evaluate(
    async ({ speed, start, end }) => {
      const main = document.querySelector<HTMLElement>("#main");
      const diff = document.querySelector<HTMLElement>(".diff");
      if (main === null || diff === null) throw new Error("no diff");
      main.scrollTop = 0;
      const last = diff.offsetTop + diff.offsetHeight - main.clientHeight;
      let gaps = 0;
      let maxRows = 0;
      const times: number[] = [];
      // eslint-disable-next-line no-console -- a trace marker inside the page, not logging
      console.timeStamp(start);
      await new Promise<void>((done) => {
        const step = (now: number) => {
          times.push(now);
          main.scrollTop = Math.min(main.scrollTop + speed, last);
          // Every 10th frame: is there a row under the middle of the column, and how many exist?
          if (times.length % 10 === 0) {
            const box = main.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const hit = document.elementFromPoint(x, box.top + box.height / 2);
            if (hit === null || hit.closest(".diff [data-vkey]") === null) gaps++;
            maxRows = Math.max(maxRows, diff.querySelectorAll("[data-vkey]").length);
          }
          if (main.scrollTop >= last - 1) done();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      // eslint-disable-next-line no-console -- a trace marker inside the page, not logging
      console.timeStamp(end);
      return { gaps, maxRows, scrolledPx: Math.round(main.scrollTop), times };
    },
    { speed: SPEED, start: START, end: END },
  );

  await browser.stopTracing();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  const { times, ...page_ } = inPage;
  const intervals = times.slice(1).map((t, i) => t - (times[i] ?? t));
  const sorted = intervals.toSorted((a, b) => a - b);
  const elapsed = (times.at(-1) ?? 0) - (times[0] ?? 0);
  const raf = {
    frames: times.length,
    meanFps: round((intervals.length / elapsed) * 1000),
    slowFrames: intervals.filter((d) => d > FRAME_MS * 1.5).length,
    p95FrameMs: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    maxFrameMs: round(sorted.at(-1) ?? 0),
  };
  const trace = JSON.parse(await readFile(TRACE, "utf8")) as { traceEvents: TraceEvent[] };
  const chrome = analyseTrace(trace.traceEvents);
  const summary = {
    cpuThrottle: THROTTLE,
    pxPerFrame: SPEED,
    diffHeightPx: fullHeight,
    ...page_,
    raf,
    chrome,
  };
  await writeFile(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  await testInfo.attach("diff-scroll-summary", {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json",
  });

  expect(page_.scrolledPx, "scrolled the whole diff").toBeGreaterThan(100_000);
  expect(page_.gaps, "rows under the viewport at every sample").toBe(0);
  expect(page_.maxRows, "only a slice of the 5,000 rows is in the DOM").toBeLessThan(300);
  expect(raf.frames).toBeGreaterThan(500);
  expect(raf.meanFps, "requestAnimationFrame rate").toBeGreaterThanOrEqual(58);
  expect(raf.slowFrames, "frame intervals over 25 ms").toBeLessThanOrEqual(
    Math.floor(raf.frames * 0.05),
  );
  expect(
    chrome.framesPresented,
    "Chrome presented a frame for (nearly) every rAF step",
  ).toBeGreaterThanOrEqual(Math.floor(raf.frames * 0.95));
  expect(chrome.droppedRatio, "share of frames Chrome dropped").toBeLessThanOrEqual(0.02);
  expect(chrome.partialRatio, "share of frames presented partially").toBeLessThanOrEqual(0.05);
  expect(chrome.longTasks, "main-thread tasks over 50 ms while scrolling").toBe(0);
});
