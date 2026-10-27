import { describe, expect, it } from "vitest";
import {
  compareReports,
  CRITICAL_RATE_TOLERANCE,
  PlaceholderBaselineError,
  PRECISION_DROP_POINTS,
  RECALL_DROP_POINTS,
} from "./compare.js";
import { parseReport, totalsOf, type EvalReport, type PrResult } from "./report.js";

const pr = (
  id: string,
  matched: number,
  expected = 10,
  over: Partial<PrResult> = {},
): PrResult => ({
  id,
  status: "done",
  failure: null,
  expected,
  produced: matched,
  matched,
  tolerated: 0,
  recall: matched / expected,
  precision: 1,
  criticalProduced: 0,
  criticalFalsePositives: 0,
  criticalFalsePositiveRate: 0,
  missed: [],
  falsePositives: [],
  ...over,
});

const report = (prs: PrResult[], over: Partial<EvalReport> = {}): EvalReport => ({
  format: "rocky-evals-report",
  version: 1,
  kind: "live",
  notice: null,
  createdAt: "2026-10-27T12:00:00.000Z",
  pipelineVersion: "p",
  promptHash: "0".repeat(64),
  models: {},
  options: { maxTokens: 1, injection: false, only: null },
  usage: { byRole: {}, totalTokens: 0, capped: false },
  prs,
  total: totalsOf(prs),
  injection: null,
  ...over,
});

/** A PR with `produced` findings, `matched` of them right. */
const scored = (id: string, matched: number, expected: number, produced: number): PrResult =>
  pr(id, matched, expected, { produced, precision: produced === 0 ? 1 : matched / produced });

describe("compareReports: the gate (README: Gate)", () => {
  it(`passes a recall drop of exactly ${RECALL_DROP_POINTS} points and fails anything more`, () => {
    expect(RECALL_DROP_POINTS).toBe(5);
    const baseline = report([pr("a", 16, 20), pr("b", 4, 20)]); // 50%
    expect(compareReports(baseline, report([pr("a", 14, 20), pr("b", 4, 20)])).ok).toBe(true); // 45%
    const failed = compareReports(baseline, report([pr("a", 13, 20), pr("b", 4, 20)])); // 42.5%
    expect(failed.ok).toBe(false);
    expect(failed.reasons).toEqual(["total recall dropped 7.5 points (50.0% → 42.5%; limit 5)"]);
  });

  it("recall that rises or holds passes", () => {
    const baseline = report([pr("a", 5)]);
    expect(compareReports(baseline, report([pr("a", 5)])).ok).toBe(true);
    expect(compareReports(baseline, report([pr("a", 9)])).ok).toBe(true);
  });

  it("fails when the critical false-positive rate rises at all", () => {
    expect(CRITICAL_RATE_TOLERANCE).toBeLessThan(1e-6);
    const baseline = report([pr("a", 5, 10, { criticalProduced: 4, criticalFalsePositives: 1 })]);
    const same = report([pr("a", 5, 10, { criticalProduced: 8, criticalFalsePositives: 2 })]);
    expect(compareReports(baseline, same).ok).toBe(true);
    const worse = compareReports(
      baseline,
      report([pr("a", 5, 10, { criticalProduced: 4, criticalFalsePositives: 2 })]),
    );
    expect(worse.ok).toBe(false);
    expect(worse.reasons).toEqual(["critical false-positive rate rose (25.0% → 50.0%)"]);
  });

  it("a PR new in the report is noted; totals cover the baseline's PRs", () => {
    const baseline = report([pr("a", 8)]);
    const result = compareReports(baseline, report([pr("a", 8), pr("new", 0)]));
    expect(result.ok).toBe(true);
    expect(result.common).toEqual(["a"]);
    expect(result.notes).toContain("only in the report: new");
  });

  it("fails when a baseline PR is missing from the report (review round 1)", () => {
    const baseline = report([pr("a", 8), pr("hard", 0)]);
    const result = compareReports(baseline, report([pr("a", 8)]));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("missing from the report: hard");
  });

  it("fails a report that ran only some seeded PRs (--only)", () => {
    const baseline = report([pr("a", 8)]);
    const partial = report([pr("a", 8)], {
      options: { maxTokens: 1, injection: false, only: ["a"] },
    });
    expect(compareReports(baseline, partial).reasons).toContain(
      "the report ran only some seeded PRs (--only)",
    );
  });

  it.each([
    [
      "capped",
      report([pr("a", 8, 10, { status: "capped" })], {
        usage: { byRole: {}, totalTokens: 9, capped: true },
      }),
    ],
    ["--only", report([pr("a", 8)], { options: { maxTokens: 1, injection: false, only: ["a"] } })],
    ["a failed PR", report([pr("a", 0, 10, { status: "failed", failure: "llm_auth" })])],
  ])("refuses a baseline that is not a complete run: %s", (_, baseline) => {
    const result = compareReports(baseline, report([pr("a", 8)]));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/^the baseline is not a complete run/);
  });

  it(`fails a precision drop of more than ${PRECISION_DROP_POINTS} points; exactly ${PRECISION_DROP_POINTS} passes`, () => {
    expect(PRECISION_DROP_POINTS).toBe(10);
    const baseline = report([scored("a", 10, 10, 20)]); // 50%
    expect(compareReports(baseline, report([scored("a", 10, 10, 25)])).ok).toBe(true); // 40%
    const worse = compareReports(baseline, report([scored("a", 10, 10, 26)])); // 38.5%
    expect(worse.ok).toBe(false);
    expect(worse.reasons).toEqual([
      "total precision dropped 11.5 points (50.0% → 38.5%; limit 10)",
    ]);
  });

  it("a drop of exactly 5 points passes despite float error (16/20 → 15/20)", () => {
    expect((16 / 20 - 15 / 20) * 100).toBeGreaterThan(5);
    expect(compareReports(report([pr("a", 16, 20)]), report([pr("a", 15, 20)])).ok).toBe(true);
  });

  it("a drop of 5.5 points fails (100/200 → 89/200)", () => {
    const result = compareReports(report([pr("a", 100, 200)]), report([pr("a", 89, 200)]));
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["total recall dropped 5.5 points (50.0% → 44.5%; limit 5)"]);
  });

  it("a failed PR counts as finding nothing", () => {
    const baseline = report([pr("a", 8)]);
    const failed = pr("a", 0, 10, { status: "failed", failure: "llm_auth" });
    expect(compareReports(baseline, report([failed])).ok).toBe(false);
  });

  it("fails an incomplete report (stopped by the token cap)", () => {
    const baseline = report([pr("a", 8)]);
    const capped = report([pr("a", 8)], { usage: { byRole: {}, totalTokens: 9, capped: true } });
    const result = compareReports(baseline, capped);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("the report is incomplete: the token cap stopped the run");
  });

  it("fails when nothing is in common or the kinds differ", () => {
    expect(compareReports(report([pr("a", 1)]), report([pr("b", 1)])).reasons).toContain(
      "no seeded PR in common",
    );
    expect(
      compareReports(report([pr("a", 1)], { kind: "fake" }), report([pr("a", 1)])).reasons,
    ).toContain("a live report cannot be compared with a fake baseline");
  });

  it("the helpers build reports that parse (so the cases above are realistic)", () => {
    expect(parseReport(report([pr("a", 8), scored("b", 3, 4, 6)])).ok).toBe(true);
  });

  it("refuses a placeholder baseline", () => {
    const placeholder = report([], { kind: "placeholder", notice: "NOT A REAL-MODEL RESULT" });
    expect(() => compareReports(placeholder, report([pr("a", 1)]))).toThrow(
      PlaceholderBaselineError,
    );
  });

  it("notes prompt, pipeline and model changes", () => {
    const baseline = report([pr("a", 5)], {
      models: { review: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" } },
    });
    const result = compareReports(
      baseline,
      report([pr("a", 5)], {
        promptHash: "1".repeat(64),
        pipelineVersion: "q",
        models: { review: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" } },
      }),
    );
    expect(result.notes).toEqual(
      expect.arrayContaining([
        "prompt hash changed",
        "pipeline version p → q",
        "review: anthropic/claude-opus-5-5 (high) → anthropic/claude-sonnet-5-5 (high)",
      ]),
    );
  });
});
