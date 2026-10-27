import { describe, expect, it } from "vitest";
import {
  parseReport,
  PLACEHOLDER_NOTICE,
  totalsOf,
  type EvalReport,
  type PrResult,
} from "./report.js";

const pr = (over: Partial<PrResult> = {}): PrResult => ({
  id: "pr-1",
  status: "done",
  failure: null,
  expected: 4,
  produced: 5,
  matched: 3,
  tolerated: 0,
  recall: 0.75,
  precision: 0.6,
  criticalProduced: 2,
  criticalFalsePositives: 1,
  criticalFalsePositiveRate: 0.5,
  missed: ["S4"],
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
  options: { maxTokens: 10, injection: false, only: null },
  usage: { byRole: {}, totalTokens: 0, capped: false },
  prs,
  total: totalsOf(prs),
  injection: null,
  ...over,
});

const issues = (value: unknown, options?: Parameters<typeof parseReport>[1]) => {
  const parsed = parseReport(value, options);
  return parsed.ok ? [] : parsed.issues;
};

describe("parseReport consistency (review round 1)", () => {
  it("accepts a consistent report", () => {
    expect(issues(report([pr()]))).toEqual([]);
  });

  it.each([
    ["matched above expected", { matched: 5, recall: 1, produced: 5, precision: 1 }],
    ["matched above produced", { matched: 3, produced: 2, precision: 1 }],
    ["recall that is not matched / expected", { recall: 0.5 }],
    ["precision that is not matched / produced", { precision: 0.9 }],
    [
      "critical false positives above criticals produced",
      { criticalFalsePositives: 3, criticalFalsePositiveRate: 1 },
    ],
    ["a critical rate that is not the ratio", { criticalFalsePositiveRate: 0.1 }],
  ])("rejects %s", (_, over) => {
    const bad = pr(over as Partial<PrResult>);
    expect(issues(report([bad])).length).toBeGreaterThan(0);
  });

  it("rejects totals that are not the sums of the PRs", () => {
    const r = report([pr()]);
    expect(issues({ ...r, total: { ...r.total, matched: 4, recall: 1 } }).length).toBeGreaterThan(
      0,
    );
  });

  it("rejects a capped flag that disagrees with the PR statuses", () => {
    expect(
      issues(report([pr()], { usage: { byRole: {}, totalTokens: 1, capped: true } })).length,
    ).toBeGreaterThan(0);
    expect(issues(report([pr({ status: "capped" })])).length).toBeGreaterThan(0);
  });
});

describe("parseReport for gating", () => {
  const capped = report([pr({ status: "capped" })], {
    usage: { byRole: {}, totalTokens: 11, capped: true },
  });
  const only = report([pr()], { options: { maxTokens: 10, injection: false, only: ["pr-1"] } });
  const failed = report([pr({ status: "failed", failure: "llm_auth" })]);

  it("a baseline must be a complete run: not capped, no --only, every PR done", () => {
    expect(issues(capped, { purpose: "baseline" })).toContain(
      "usage.capped: a baseline cannot be capped",
    );
    expect(issues(only, { purpose: "baseline" })).toContain(
      "options.only: a baseline must run every seeded PR",
    );
    expect(issues(failed, { purpose: "baseline" })).toContain(
      "prs.0.status: every baseline PR must be done",
    );
    expect(issues(report([pr()]), { purpose: "baseline" })).toEqual([]);
  });

  it("a gated report may hold failed PRs but not be capped or partial", () => {
    expect(issues(failed, { purpose: "report" })).toEqual([]);
    expect(issues(capped, { purpose: "report" }).length).toBeGreaterThan(0);
    expect(issues(only, { purpose: "report" }).length).toBeGreaterThan(0);
  });

  it("a placeholder still parses as a baseline, so compare can refuse it with its own exit code", () => {
    const placeholder = report([], { kind: "placeholder", notice: PLACEHOLDER_NOTICE });
    expect(issues(placeholder, { purpose: "baseline" })).toEqual([]);
  });
});
