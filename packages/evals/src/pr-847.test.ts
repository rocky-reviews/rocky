import { createHash } from "node:crypto";
import {
  analyzePullRequest,
  parseUnifiedDiff,
  type AnalysisDeps,
  type AnalysisOutcome,
  type AnalysisRequest,
} from "@rocky-reviews/core";
import { scriptedRoles } from "@rocky-reviews/core/testing";
import { parseAnalysisDocument } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import { pr847Diff, ROUTES_PUSH_2 } from "./pr-847/diff.js";
import { PR847, pr847Script, REPAIRED_PATH } from "./pr-847/script.js";
import { scoreFindings } from "./score.js";

/**
 * P4-3 acceptance criteria, against the scripted model (no network, no spending, deterministic):
 *
 * 1. the pr-847 fixture yields at least 8 of its 10 seeded findings, with no critical false
 *    positive, through the real pipeline (rules → triage → review of critical/important files →
 *    graph → briefing → validate/repair);
 * 2. a second push that changes one file re-analyses exactly that file.
 *
 * The script answers like a good model would; what is measured is the pipeline's wiring. Real
 * model quality is P4-7 (evals) and P4-8 (CLI on a real PR with a key).
 */

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

const request = (diff: string, previous?: AnalysisRequest["previous"]): AnalysisRequest => ({
  repo: { owner: "acme", name: "rocky-app" },
  pullRequest: { number: 847, title: "Team invitations" },
  base: { sha: PR847.provenance.base.sha, ref: "main" },
  head: { sha: PR847.provenance.head.sha, ref: "feat/team-invites" },
  diff,
  diffTruncated: false,
  previous,
});

const run = async (diff: string, previous?: AnalysisRequest["previous"]) => {
  const llm = scriptedRoles(pr847Script);
  const deps: AnalysisDeps = {
    llm: llm.roles,
    clock: { now: () => new Date("2026-10-27T12:00:00.000Z") },
    sha256Hex,
    generator: { name: "rocky", version: "0.0.0" },
    unitKeySalt: "triage:scripted|review:scripted",
  };
  const outcome = await analyzePullRequest(request(diff, previous), deps);
  return { outcome, calls: llm.calls };
};

const done = (outcome: AnalysisOutcome) => {
  if (outcome.status !== "done") throw new Error(`analysis failed: ${outcome.code}`);
  return outcome;
};

describe("pr-847 through the pipeline (P4-3)", () => {
  it("the seeded diff reproduces the fixture's known facts exactly", () => {
    const parsed = parseUnifiedDiff(pr847Diff());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const facts = parsed.files.map(({ path, status, additions, deletions, hunks }) => ({
      path,
      status,
      additions,
      deletions,
      hunks,
    }));
    expect(facts).toEqual(PR847.provenance.files);
  });

  it("yields at least 8 of the 10 seeded findings with no critical false positive", async () => {
    const { outcome } = await run(pr847Diff());
    const { document } = done(outcome);
    const score = scoreFindings(PR847.findings, document.findings);
    expect(score.expected).toBe(10);
    expect(score.matched).toBeGreaterThanOrEqual(8);
    expect(score.criticalFalsePositives).toBe(0);
    expect(score.falsePositives).toEqual([]);
    // By design, review runs on critical and important files only: the two low findings in
    // normal files (the invite page and the tests) are not drafted.
    expect([...score.missed].sort()).toEqual(["F10", "F9"]);
  });

  it("stores what passed validation whole: the document parses and matches the fixture's triage", async () => {
    const { outcome } = await run(pr847Diff());
    const { document, units, stats } = done(outcome);
    expect(parseAnalysisDocument(JSON.parse(JSON.stringify(document))).ok).toBe(true);
    expect(document.provenance.files).toEqual(PR847.provenance.files);
    expect(document.triage.files.map((f) => [f.path, f.level, f.score])).toEqual(
      PR847.triage.files.map((f) => [f.path, f.level, f.score]),
    );
    expect(document.triage.noise.map((f) => f.path)).toEqual([
      "pnpm-lock.yaml",
      "src/generated/api-types.ts",
    ]);
    expect(document.briefing.verdict.level).toBe("critical");
    expect(document.briefing.estimatedReviewMinutes).toBe(7);
    expect(document.graph).toEqual(PR847.graph);
    expect(document.provenance.unanalysed).toEqual([]);
    expect(document.provenance.generator.roles.map((r) => r.role)).toEqual([
      "triage",
      "review",
      "graph",
    ]);
    expect(units.map((u) => u.path).sort()).toEqual(PR847.triage.files.map((f) => f.path).sort());
    expect(stats).toMatchObject({
      files: 9,
      noise: 2,
      analysed: 7,
      reviewed: 4,
      reused: 0,
      repairs: 1,
    });
  });

  it("noise and files below important never reach the review model", async () => {
    const { calls } = await run(pr847Diff());
    const triaged = calls.filter((c) => c.role === "triage").map((c) => c.part("file_path"));
    const reviewed = calls
      .filter((c) => c.role === "review" && c.part("file_path") !== undefined)
      .map((c) => c.part("file_path"));
    expect(triaged).not.toContain("pnpm-lock.yaml");
    expect(triaged).not.toContain("src/generated/api-types.ts");
    expect(new Set(reviewed)).toEqual(
      new Set([
        "src/auth/invitations.ts",
        "src/api/routes/invitations.ts",
        "db/migrations/20261020_add_invitations.sql",
        "src/jobs/sendInviteEmail.ts",
      ]),
    );
  });

  it("a finding outside the diff goes back for one repair round and comes back fixed", async () => {
    const { outcome, calls } = await run(pr847Diff());
    const repairs = calls.filter((c) => c.repair);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.part("file_path")).toBe(REPAIRED_PATH);
    // Paths and codes only: no message, so no value from the answer or the diff.
    expect(repairs[0]!.part("validation_issues")!.split("\n")).toEqual([
      "findings[0].range: LINE_OUTSIDE_DIFF",
      "findings[0].range.end: SUGGESTION_RANGE_OUTSIDE_FILE",
    ]);
    const fixed = done(outcome).document.findings.filter((f) => f.path === REPAIRED_PATH);
    expect(fixed.map((f) => f.range.start)).toEqual([9]);
  });

  it("a second push that changes 1 file re-analyses exactly 1 file", async () => {
    const first = done((await run(pr847Diff())).outcome);
    const previous = { document: first.document, units: first.units };

    const second = await run(pr847Diff(ROUTES_PUSH_2), previous);
    const { document, stats } = done(second.outcome);
    const unitCalls = second.calls.filter((c) => c.part("file_path") !== undefined);
    expect(new Set(unitCalls.map((c) => c.part("file_path")))).toEqual(
      new Set(["src/api/routes/invitations.ts"]),
    );
    expect(second.calls.filter((c) => c.role === "triage")).toHaveLength(1);
    expect(stats).toMatchObject({ analysed: 1, reused: 6, reviewed: 1 });
    // Reused files keep their triage and findings; the document is whole and valid.
    expect(scoreFindings(PR847.findings, document.findings).matched).toBeGreaterThanOrEqual(8);
    expect(document.triage.files.map((f) => f.path)).toEqual(PR847.triage.files.map((f) => f.path));

    // Nothing changed: nothing is re-analysed.
    const third = await run(pr847Diff(ROUTES_PUSH_2), {
      document,
      units: done(second.outcome).units,
    });
    expect(done(third.outcome).stats).toMatchObject({ analysed: 0, reused: 7 });
  });
});
