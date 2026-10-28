import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { describe, expect, it } from "vitest";
import { PR_847_PULL } from "../data/fixture-source.js";
import { parseShellData, ShellDataError } from "../data/shell-data.js";
import { parseAnalysisRun } from "./analysis-run.js";

describe("parseAnalysisRun", () => {
  it.each([
    [{ status: "none" }],
    [{ status: "queued" }],
    [{ status: "running" }],
    [{ status: "awaiting_approval", estimatedTokens: 212_000, limitTokens: 150_000 }],
    [{ status: "failed", code: "diff_truncated" }],
  ])("accepts %j without a document", (run) => {
    expect(parseAnalysisRun(run, false)).toEqual(run);
  });

  it("defaults to done with a document and none without one", () => {
    expect(parseAnalysisRun(undefined, true)).toEqual({ status: "done" });
    expect(parseAnalysisRun(undefined, false)).toEqual({ status: "none" });
    expect(parseAnalysisRun(null, false)).toEqual({ status: "none" });
  });

  it.each([
    ["a document with a run that is not done", { status: "running" }, true],
    ["done without a document", { status: "done" }, false],
    ["a code that is not a fixed code", { status: "failed", code: "Bad Code <x>" }, false],
    ["a code that is too long", { status: "failed", code: `a${"b".repeat(64)}` }, false],
    ["an unknown status", { status: "paused" }, false],
    ["an extra field", { status: "queued", message: "boom" }, false],
    [
      "a negative estimate",
      { status: "awaiting_approval", estimatedTokens: -1, limitTokens: 1 },
      false,
    ],
  ])("refuses %s", (_name, run, hasDocument) => {
    expect(parseAnalysisRun(run, hasDocument)).toBeUndefined();
  });
});

describe("parseShellData with an analysis run", () => {
  const valid = { pull: PR_847_PULL, myReview: null, analysis: pr847 };

  it("carries the run state", () => {
    expect(parseShellData(valid).analysisRun).toEqual({ status: "done" });
    const failed = {
      ...valid,
      analysis: null,
      analysisRun: { status: "failed", code: "superseded" },
    };
    expect(parseShellData(failed).analysisRun).toEqual({ status: "failed", code: "superseded" });
  });

  it("refuses a run state without echoing it", () => {
    let error: unknown;
    try {
      parseShellData({ ...valid, analysis: null, analysisRun: { status: "failed", code: "<x>" } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(new ShellDataError("invalid analysis state"));
  });
});
