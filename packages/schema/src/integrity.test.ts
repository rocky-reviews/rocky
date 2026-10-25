import { describe, expect, it } from "vitest";
import { integrityIssues, rangeInsideHunks } from "./integrity.js";
import {
  MAX_FILE_REVIEW_MINUTES,
  MAX_REASON_LENGTH,
  MAX_REVIEW_MINUTES,
  MAX_VIEW_DEPTH,
  MAX_VIEWS_TOTAL,
} from "./limits.js";
import { expectAccepted, expectRejected, pr847, PR847_AUTH_LINES } from "./test-helpers.js";

const AUTH = "src/auth/invitations.ts";

describe("rangeInsideHunks", () => {
  const hunks = [
    { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4 },
    { oldStart: 18, oldLines: 4, newStart: 19, newLines: 5 },
    { oldStart: 40, oldLines: 2, newStart: 41, newLines: 0 },
  ];

  it("accepts ranges inside one hunk, context lines included", () => {
    expect(rangeInsideHunks({ start: 3, end: 6 }, hunks)).toBe(true);
    expect(rangeInsideHunks({ start: 19, end: 23 }, hunks)).toBe(true);
    expect(rangeInsideHunks({ start: 21, end: 21 }, hunks)).toBe(true);
  });

  it("rejects ranges outside, spanning two hunks, or in a pure deletion", () => {
    expect(rangeInsideHunks({ start: 2, end: 3 }, hunks)).toBe(false);
    expect(rangeInsideHunks({ start: 6, end: 7 }, hunks)).toBe(false);
    expect(rangeInsideHunks({ start: 6, end: 19 }, hunks)).toBe(false);
    expect(rangeInsideHunks({ start: 41, end: 41 }, hunks)).toBe(false);
    expect(rangeInsideHunks({ start: 1, end: 1 }, [])).toBe(false);
  });
});

describe("integrity: duplicates", () => {
  it("DUPLICATE_ID for findings, with the path of the second occurrence", () => {
    const doc = pr847();
    doc.findings[3]!.id = doc.findings[0]!.id;
    expectRejected(doc, "DUPLICATE_ID", "findings[3].id");
  });

  it.each([
    [
      "graph.lanes[1].id",
      (d: ReturnType<typeof pr847>) => (d.graph!.lanes[1]!.id = d.graph!.lanes[0]!.id),
    ],
    [
      "graph.nodes[2].id",
      (d: ReturnType<typeof pr847>) => (d.graph!.nodes[2]!.id = d.graph!.nodes[0]!.id),
    ],
    [
      "graph.edges[1].id",
      (d: ReturnType<typeof pr847>) => (d.graph!.edges![1]!.id = d.graph!.edges![0]!.id),
    ],
    [
      "graph.flows[0].messages[1].id",
      (d: ReturnType<typeof pr847>) => (d.graph!.flows![0]!.messages[1]!.id = "m1"),
    ],
    [
      "graph.flows[0].participants[1].node",
      (d: ReturnType<typeof pr847>) => (d.graph!.flows![0]!.participants[1]!.node = "page"),
    ],
    [
      "graph.views[0].children[0].id",
      (d: ReturnType<typeof pr847>) => (d.graph!.views![0]!.children![0]!.id = "overview"),
    ],
    [
      "graph.walkthrough.steps[2].id",
      (d: ReturnType<typeof pr847>) => (d.graph!.walkthrough!.steps[2]!.id = "s1"),
    ],
    [
      "findings[1].memory[1].entryId",
      (d: ReturnType<typeof pr847>) =>
        d.findings[1]!.memory!.push({ ...d.findings[1]!.memory![0]! }),
    ],
    [
      "briefing.memoryApplied[1].entryId",
      (d: ReturnType<typeof pr847>) => (d.briefing.memoryApplied![1]!.entryId = "mem-612"),
    ],
  ])("DUPLICATE_ID at %s", (path, mutate) => {
    const doc = pr847();
    mutate(doc);
    expectRejected(doc, "DUPLICATE_ID", path);
  });

  it("duplicate flow ids", () => {
    const doc = pr847();
    const flow = structuredClone(doc.graph!.flows![0]!);
    doc.graph!.flows!.push(flow);
    expectRejected(doc, "DUPLICATE_ID", "graph.flows[1].id");
  });

  it.each([
    ["triage.files[1].path", (d: ReturnType<typeof pr847>) => (d.triage.files[1]!.path = AUTH)],
    [
      "triage.noise[1].path",
      (d: ReturnType<typeof pr847>) => (d.triage.noise![1]!.path = "pnpm-lock.yaml"),
    ],
    [
      "briefing.reviewPath[1].path",
      (d: ReturnType<typeof pr847>) => (d.briefing.reviewPath[1]!.path = AUTH),
    ],
    [
      "provenance.files[1].path",
      (d: ReturnType<typeof pr847>) => (d.provenance.files[1]!.path = AUTH),
    ],
  ])("DUPLICATE_PATH at %s", (path, mutate) => {
    const doc = pr847();
    mutate(doc);
    expectRejected(doc, "DUPLICATE_PATH", path);
  });
});

describe("integrity: graph references", () => {
  it.each([
    ["graph.nodes[0].lane", (d: ReturnType<typeof pr847>) => (d.graph!.nodes[0]!.lane = "ghost")],
    ["graph.edges[0].from", (d: ReturnType<typeof pr847>) => (d.graph!.edges![0]!.from = "ghost")],
    ["graph.edges[0].to", (d: ReturnType<typeof pr847>) => (d.graph!.edges![0]!.to = "ghost")],
    [
      "graph.flows[0].participants[0].node",
      (d: ReturnType<typeof pr847>) => (d.graph!.flows![0]!.participants[0]!.node = "ghost"),
    ],
    [
      "graph.flows[0].messages[0].from",
      (d: ReturnType<typeof pr847>) => (d.graph!.flows![0]!.messages[0]!.from = "job"),
    ],
    [
      "graph.flows[0].messages[0].to",
      (d: ReturnType<typeof pr847>) => (d.graph!.flows![0]!.messages[0]!.to = "job"),
    ],
    [
      "graph.views[0].children[0].scope.nodes[1]",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.views![0]!.children![0]!.scope as { nodes: string[] }).nodes[1] = "ghost"),
    ],
    [
      "graph.views[0].children[0].scope.edges[0]",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.views![0]!.children![0]!.scope as { edges: string[] }).edges[0] = "ghost"),
    ],
    [
      "graph.views[0].children[0].scope.flows[0]",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.views![0]!.children![0]!.scope as { flows: string[] }).flows[0] = "ghost"),
    ],
    [
      "graph.views[0].children[0].scope.lanes[0]",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.views![0]!.children![0]!.scope as { lanes: string[] }).lanes = ["ghost"]),
    ],
    [
      "graph.walkthrough.steps[1].stage.flow",
      (d: ReturnType<typeof pr847>) =>
        (d.graph!.walkthrough!.steps[1]!.stage = { kind: "flow", flow: "ghost" }),
    ],
    [
      "graph.walkthrough.steps[1].stage.view",
      (d: ReturnType<typeof pr847>) =>
        (d.graph!.walkthrough!.steps[1]!.stage = { kind: "view", view: "ghost" }),
    ],
    [
      "graph.walkthrough.steps[0].focus.nodes[0]",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.walkthrough!.steps[0]!.focus as { nodes: string[] }).nodes[0] = "ghost"),
    ],
    [
      "graph.walkthrough.steps[0].focus.edges[0]",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.walkthrough!.steps[0]!.focus as { edges: string[] }).edges[0] = "ghost"),
    ],
    [
      "graph.walkthrough.steps[2].focus.lanes[0]",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.walkthrough!.steps[2]!.focus as { lanes: string[] }).lanes[0] = "ghost"),
    ],
    [
      "graph.walkthrough.steps[1].focus.messages[0]",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.walkthrough!.steps[1]!.focus as { messages: string[] }).messages[0] = "ghost"),
    ],
    [
      "graph.walkthrough.steps[0].focus.messages",
      (d: ReturnType<typeof pr847>) =>
        ((d.graph!.walkthrough!.steps[0]!.focus as { messages: string[] }).messages = ["m1"]),
    ],
  ])("BROKEN_REFERENCE at %s", (path, mutate) => {
    const doc = pr847();
    mutate(doc);
    expectRejected(doc, "BROKEN_REFERENCE", path);
  });

  it("a message focus on a view stage is checked against the flows that view scopes", () => {
    const doc = pr847();
    doc.graph!.walkthrough!.steps[1]!.stage = { kind: "view", view: "auth-path" };
    expectAccepted(doc);
    (doc.graph!.views![0]!.children![0]!.scope as { flows: string[] }).flows = [];
    (doc.graph!.views![0]!.children![0]!.scope as { nodes: string[] }).nodes = ["route"];
    expectRejected(doc, "BROKEN_REFERENCE", "graph.walkthrough.steps[1].focus.messages[0]");
    doc.graph!.walkthrough!.steps[1]!.stage = { kind: "view", view: "overview" };
    expectAccepted(doc);
  });

  it("an unknown stage is reported once, not again per focused message", () => {
    const doc = pr847();
    doc.graph!.walkthrough!.steps[1]!.stage = { kind: "flow", flow: "ghost" };
    const issues = expectRejected(doc, "BROKEN_REFERENCE", "graph.walkthrough.steps[1].stage.flow");
    expect(
      issues.filter((issue) => issue.path.startsWith("graph.walkthrough.steps[1]")),
    ).toHaveLength(1);
  });

  it("LIMIT_EXCEEDED for too many views in the tree", () => {
    const doc = pr847();
    doc.graph!.views![0]!.children = Array.from({ length: 32 }, (_, i) => ({
      id: `c${i}`,
      title: "c",
      children: Array.from({ length: 2 }, (_, j) => ({ id: `c${i}-${j}`, title: "c" })),
    }));
    expect(doc.graph!.views![0]!.children.length * 3 + 1).toBeGreaterThan(MAX_VIEWS_TOTAL);
    expectRejected(doc, "LIMIT_EXCEEDED", "graph.views");
  });

  it("LIMIT_EXCEEDED for a view tree nested too deep", () => {
    const doc = pr847();
    let leaf = doc.graph!.views![0]!;
    let path = "graph.views[0]";
    for (let depth = 2; depth <= MAX_VIEW_DEPTH + 1; depth += 1) {
      const child = { id: `d${depth}`, title: "d", children: [] };
      leaf.children = [child];
      leaf = child;
      path += ".children[0]";
    }
    expectRejected(doc, "LIMIT_EXCEEDED", path);
  });
});

describe("integrity: triage", () => {
  it("TRIAGE_COVERAGE when a PR file is neither triaged nor noise", () => {
    const doc = pr847();
    doc.triage.files.pop();
    expectRejected(doc, "TRIAGE_COVERAGE", "triage");
  });

  it("TRIAGE_COVERAGE when a file is both triaged and noise", () => {
    const doc = pr847();
    doc.triage.noise!.push({ path: AUTH, summary: "trust me" });
    expectRejected(doc, "TRIAGE_COVERAGE", "triage.noise[2].path");
  });

  it("UNKNOWN_FILE for triage entries outside the PR", () => {
    const triaged = pr847();
    triaged.triage.files[6]!.path = "src/not-in-pr.ts";
    expectRejected(triaged, "UNKNOWN_FILE", "triage.files[6].path");

    const noise = pr847();
    noise.triage.noise![0]!.path = "vendor/blob.js";
    expectRejected(noise, "UNKNOWN_FILE", "triage.noise[0].path");
  });

  it("SCORE_LEVEL_MISMATCH when a score leaves its level's band", () => {
    const doc = pr847();
    doc.triage.files[6]!.score = 95; // level low
    expectRejected(doc, "SCORE_LEVEL_MISMATCH", "triage.files[6].score");
    const edge = pr847();
    edge.triage.files[6]!.score = 19;
    expectAccepted(edge);
  });

  it("LINE_OUTSIDE_DIFF for a flag outside the file's hunks", () => {
    const doc = pr847();
    doc.triage.files[0]!.flags![0]!.range = { start: 34, end: 34 };
    expectRejected(doc, "LINE_OUTSIDE_DIFF", "triage.files[0].flags[0].range");
  });

  it("flags in a modified file must sit inside one hunk", () => {
    const doc = pr847();
    const index = doc.triage.files.find((file) => file.path === "src/api/index.ts")!;
    index.flags = [{ range: { start: 4, end: 4 }, kind: "look", text: "new import" }];
    expectAccepted(doc);
    index.flags = [{ range: { start: 6, end: 19 }, kind: "look", text: "spans two hunks" }];
    expectRejected(doc, "LINE_OUTSIDE_DIFF", "triage.files[6].flags[0].range");
  });
});

describe("integrity: findings", () => {
  it("UNKNOWN_FILE for a finding outside the PR", () => {
    const doc = pr847();
    doc.findings[0]!.path = "src/elsewhere.ts";
    expectRejected(doc, "UNKNOWN_FILE", "findings[0].path");
  });

  it("FINDING_IN_NOISE_FILE for a finding in a noise file", () => {
    const doc = pr847();
    doc.findings[8]!.path = "pnpm-lock.yaml";
    doc.findings[8]!.range = { start: 1190, end: 1190 };
    expectRejected(doc, "FINDING_IN_NOISE_FILE", "findings[8].path");
  });

  it("LINE_OUTSIDE_DIFF for a finding past the hunk", () => {
    const doc = pr847();
    doc.findings[0]!.range = { start: 30, end: 40 };
    expectRejected(doc, "LINE_OUTSIDE_DIFF", "findings[0].range");
  });

  it("SEVERITY_LEVEL_MISMATCH for a high finding in a low file", () => {
    const doc = pr847();
    doc.findings[1]!.path = "src/api/index.ts";
    doc.findings[1]!.range = { start: 21, end: 21 };
    delete doc.findings[1]!.suggestion;
    expectRejected(doc, "SEVERITY_LEVEL_MISMATCH", "findings[1].severity");
    doc.findings[1]!.severity = "medium";
    expectAccepted(doc);
  });
});

describe("integrity: suggestions", () => {
  const withAuth = { newFileLines: { [AUTH]: PR847_AUTH_LINES } };

  it("pr-847 suggestions apply cleanly to the auth file's content", () => {
    expectAccepted(pr847(), withAuth);
  });

  it("SUGGESTION_CONTEXT_IMPOSSIBLE when a context line is given at line 1", () => {
    const doc = pr847();
    doc.findings[0]!.range = { start: 1, end: 1 };
    expectRejected(doc, "SUGGESTION_CONTEXT_IMPOSSIBLE", "findings[0].suggestion.context");
  });

  it("SUGGESTION_CONTEXT_MISMATCH when content is available and the context differs", () => {
    const doc = pr847();
    doc.findings[0]!.suggestion!.context = "    userId: someoneElse.id,";
    expectAccepted(doc); // nothing to compare against without content
    expectRejected(doc, "SUGGESTION_CONTEXT_MISMATCH", "findings[0].suggestion.context", withAuth);
  });

  it("SUGGESTION_RANGE_OUTSIDE_FILE when the range runs past the content", () => {
    const doc = pr847();
    doc.provenance.files[0]!.hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 60 }];
    doc.findings[0]!.range = { start: 40, end: 41 };
    delete doc.findings[0]!.suggestion!.context;
    expectAccepted(doc);
    expectRejected(doc, "SUGGESTION_RANGE_OUTSIDE_FILE", "findings[0].range.end", withAuth);
  });

  it("SUGGESTION_NOOP when the replacement equals the original lines", () => {
    const doc = pr847();
    doc.findings[0]!.suggestion!.lines = [PR847_AUTH_LINES[27]!];
    expectAccepted(doc);
    expectRejected(doc, "SUGGESTION_NOOP", "findings[0].suggestion.lines", withAuth);
  });

  it("a deletion (empty replacement) is a valid suggestion", () => {
    const doc = pr847();
    doc.findings[0]!.suggestion!.lines = [];
    expectAccepted(doc, withAuth);
  });

  it("content for other files does not affect a finding's checks", () => {
    const doc = pr847();
    expectAccepted(doc, { newFileLines: { "web/src/pages/InvitePage.tsx": ["x"] } });
  });
});

describe("integrity: briefing", () => {
  it("UNKNOWN_FILE for a review-path step naming a noise or foreign file", () => {
    const noise = pr847();
    noise.briefing.reviewPath[0]!.path = "pnpm-lock.yaml";
    expectRejected(noise, "UNKNOWN_FILE", "briefing.reviewPath[0].path");
    const foreign = pr847();
    foreign.briefing.reviewPath[0]!.path = "src/nope.ts";
    expectRejected(foreign, "UNKNOWN_FILE", "briefing.reviewPath[0].path");
  });

  it("VERDICT_TOO_LOW with a critical finding and any verdict but critical (H2 #5)", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const doc = pr847();
      doc.briefing.verdict.level = level;
      expectRejected(doc, "VERDICT_TOO_LOW", "briefing.verdict.level");
    }
    const doc = pr847();
    doc.briefing.verdict.level = "critical";
    expectAccepted(doc);
  });

  it("a critical finding forces the verdict whatever its confidence or file level", () => {
    const doc = pr847();
    doc.briefing.verdict.level = "high";
    doc.findings[0]!.confidence = 0;
    expectRejected(doc, "VERDICT_TOO_LOW", "briefing.verdict.level");
    // Only the finding's severity counts, not the triage level of the file it sits in.
    const normal = pr847();
    normal.briefing.verdict.level = "high";
    normal.findings = [{ ...normal.findings[8]!, severity: "critical" }]; // InvitePage, normal
    expectRejected(normal, "VERDICT_TOO_LOW", "briefing.verdict.level");
  });

  it("the schema has no dismissed or decided state a model could use to lower the floor", () => {
    // Accept/edit/dismiss decisions are the human's and live outside the document (ADR 0004).
    for (const field of ["state", "dismissed", "decided", "status"]) {
      const doc = pr847();
      doc.briefing.verdict.level = "high";
      Object.assign(doc.findings[0]!, { [field]: "dismissed" });
      expectRejected(doc, "INVALID_SHAPE", "findings[0]");
    }
  });

  it("VERDICT_TOO_LOW with a high finding and a low verdict", () => {
    const doc = pr847();
    doc.findings = doc.findings.filter((finding) => finding.severity !== "critical");
    doc.briefing.verdict.level = "low";
    expectRejected(doc, "VERDICT_TOO_LOW", "briefing.verdict.level");
    doc.briefing.verdict.level = "medium";
    expectAccepted(doc);
  });

  it("a low verdict is fine with only medium and low findings, or none", () => {
    const doc = pr847();
    doc.findings = doc.findings.filter(
      (finding) => finding.severity === "medium" || finding.severity === "low",
    );
    doc.briefing.verdict.level = "low";
    expectAccepted(doc);
    doc.findings = [];
    expectAccepted(doc);
  });
});

describe("integrity: review minutes (H2 #9)", () => {
  const perFileTotal = (doc: ReturnType<typeof pr847>) =>
    doc.triage.files.reduce((sum, file) => sum + file.reviewMinutes, 0);

  it("pr-847's files add up to its estimate", () => {
    const doc = pr847();
    expect(perFileTotal(doc)).toBe(doc.briefing.estimatedReviewMinutes);
  });

  it("REVIEW_MINUTES_TOO_LOW when the PR estimate is below the sum of its files", () => {
    const doc = pr847();
    doc.briefing.estimatedReviewMinutes = perFileTotal(doc) - 1;
    expectRejected(doc, "REVIEW_MINUTES_TOO_LOW", "briefing.estimatedReviewMinutes");
  });

  it("the PR estimate may exceed the sum: the briefing and noise take time too", () => {
    const doc = pr847();
    doc.briefing.estimatedReviewMinutes = perFileTotal(doc) + 5;
    expectAccepted(doc);
  });

  it("a file may take zero minutes, and the estimate may equal the sum", () => {
    const doc = pr847();
    for (const file of doc.triage.files) file.reviewMinutes = 0;
    doc.triage.files[0]!.reviewMinutes = MAX_FILE_REVIEW_MINUTES;
    doc.briefing.estimatedReviewMinutes = MAX_FILE_REVIEW_MINUTES;
    expectAccepted(doc);
  });

  it.each([-1, MAX_FILE_REVIEW_MINUTES + 1, 1.5, -0, "3", null, undefined])(
    "INVALID_SHAPE for reviewMinutes %s",
    (value) => {
      const doc = pr847();
      Object.assign(doc.triage.files[0]!, { reviewMinutes: value });
      expectRejected(doc, "INVALID_SHAPE", "triage.files[0].reviewMinutes");
    },
  );

  it("the per-file cap is the PR cap: a larger value could never pass the sum check", () => {
    expect(MAX_FILE_REVIEW_MINUTES).toBe(MAX_REVIEW_MINUTES);
  });
});

describe("integrity: change map unavailable (H2 #2)", () => {
  it("a document may lack a graph and say why, from the pipeline", () => {
    const doc = pr847();
    delete doc.graph;
    doc.provenance.graphUnavailable = {
      reason: "analysis-failed",
      detail: "The graph role's output failed validation twice.",
    };
    const value = expectAccepted(doc);
    expect(value.graph).toBeUndefined();
    expect(value.provenance.graphUnavailable?.reason).toBe("analysis-failed");
  });

  it("the reason is optional: a graph that was never attempted has none", () => {
    const doc = pr847();
    delete doc.graph;
    expectAccepted(doc);
  });

  it("a graph and a reason for its absence cannot both be present", () => {
    const doc = pr847();
    doc.provenance.graphUnavailable = { reason: "timeout" };
    expectRejected(doc, "INVALID_SHAPE", "provenance.graphUnavailable");
  });

  it("the reason is an enum; the detail is bounded, prose-checked text", () => {
    const reason = pr847();
    delete reason.graph;
    Object.assign(reason.provenance, { graphUnavailable: { reason: "<b>see console</b>" } });
    expectRejected(reason, "INVALID_SHAPE", "provenance.graphUnavailable.reason");

    const hidden = pr847();
    delete hidden.graph;
    hidden.provenance.graphUnavailable = { reason: "timeout", detail: "Retry‮ later" };
    expectRejected(hidden, "INVALID_SHAPE", "provenance.graphUnavailable.detail");

    const long = pr847();
    delete long.graph;
    long.provenance.graphUnavailable = {
      reason: "timeout",
      detail: "x".repeat(MAX_REASON_LENGTH + 1),
    };
    expectRejected(long, "INVALID_SHAPE", "provenance.graphUnavailable.detail");

    const extra = pr847();
    delete extra.graph;
    Object.assign(extra.provenance, { graphUnavailable: { reason: "timeout", retry: true } });
    expectRejected(extra, "INVALID_SHAPE", "provenance.graphUnavailable");
  });

  it("the reason lives in provenance only; the model cannot place it elsewhere", () => {
    const top = pr847();
    delete top.graph;
    Object.assign(top, { graphUnavailable: { reason: "timeout" } });
    expectRejected(top, "INVALID_SHAPE", "");

    const inBriefing = pr847();
    delete inBriefing.graph;
    Object.assign(inBriefing.briefing, { graphUnavailable: { reason: "timeout" } });
    expectRejected(inBriefing, "INVALID_SHAPE", "briefing");
  });
});

describe("integrityIssues on a parsed document", () => {
  it("returns no issues for a valid document and lists every problem otherwise", () => {
    const valid = expectAccepted(pr847());
    expect(integrityIssues(valid)).toEqual([]);
    const broken = structuredClone(valid);
    broken.findings[0]!.id = "F2";
    broken.graph!.edges[0]!.to = "ghost";
    const issues = integrityIssues(broken);
    expect(issues.map((issue) => issue.code).sort()).toEqual(["BROKEN_REFERENCE", "DUPLICATE_ID"]);
  });
});
