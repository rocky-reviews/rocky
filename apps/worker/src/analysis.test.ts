import { ANALYSIS_MAX_RETRY_DELAY_MS } from "@rocky-reviews/db";
import { describe, expect, it } from "vitest";
import { analysisRetryDelayMs } from "./analysis.js";

/** P4-6: the analysis retry delay (ADR 0017 §3). The runs themselves are in *.e2e.test.ts. */

describe("analysisRetryDelayMs", () => {
  it("backs off from 30 s, doubling, to at most an hour", () => {
    expect([1, 2, 3, 4, 8, 20].map((a) => analysisRetryDelayMs(a))).toEqual([
      30_000, 60_000, 120_000, 240_000, 3_600_000, 3_600_000,
    ]);
  });

  it("is never sooner than the provider asks, and never more than the store accepts", () => {
    expect(analysisRetryDelayMs(1, 90_000.2)).toBe(90_001);
    expect(analysisRetryDelayMs(1, 10 * 3_600_000)).toBe(ANALYSIS_MAX_RETRY_DELAY_MS);
  });

  it("review round 1, N5: a hint that is not a finite number is ignored, never thrown on", () => {
    for (const hint of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(analysisRetryDelayMs(1, hint)).toBe(30_000);
    }
    expect(analysisRetryDelayMs(2, -5)).toBe(60_000);
  });
});
