import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_OUTPUT_TOKENS } from "./outputs.js";
import { analyzePullRequest } from "./pipeline.js";
import { STAGE_CALLS } from "./stages.js";
import { scriptedRoles, stageOf, type ScriptedCall } from "./testing.js";

/** P4-8: the stage table the CLI estimates from matches what the pipeline really sends. */

const lines = ["const a = 1;", "export { a };"];
const file = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");

const triage = {
  score: 90,
  level: "critical",
  reviewMinutes: 2,
  reason: "Reason.",
  whatChanged: "What changed.",
  whyThisLevel: "Why.",
  flags: [],
};

const answer = (call: ScriptedCall) => {
  if (call.role === "triage") return { value: triage };
  if (call.role === "review" && call.part("file_path") !== undefined) {
    return {
      value: {
        findings: [
          {
            severity: "high",
            confidence: 80,
            range: { start: 1, end: 1 },
            title: "A problem",
            body: "Body.",
            agentPrompt: "Fix it.",
          },
        ],
      },
    };
  }
  if (call.role === "review") {
    return {
      value: {
        summary: "Adds a.",
        verdict: { level: "high", reason: "A high finding." },
        reviewPath: [{ path: "src/a.ts", why: "First." }],
        checkedOk: [],
      },
    };
  }
  if (stageOf(call) === "flows") {
    return {
      value: {
        flows: [
          {
            id: "f",
            title: "A to B",
            participants: [{ node: "n1" }, { node: "n2" }],
            messages: [{ id: "m1", from: "n1", to: "n2", label: "write", delta: "added" }],
          },
        ],
      },
    };
  }
  if (stageOf(call) === "walkthrough") {
    const step = (id: string) => ({ id, heading: "Stop", body: "Here.", focus: { nodes: ["n1"] } });
    return { value: { steps: [step("s1"), step("s2"), step("s3")] } };
  }
  return {
    value: {
      lanes: [{ id: "api", label: "API", order: 0 }],
      nodes: [
        { id: "n1", lane: "api", kind: "ui", delta: "added", label: "A" },
        { id: "n2", lane: "api", kind: "datastore", delta: "unchanged", label: "B" },
      ],
    },
  };
};

describe("STAGE_CALLS", () => {
  it("names each stage's role, instructions, output and cap as the pipeline sends them", async () => {
    const llm = scriptedRoles(answer);
    const outcome = await analyzePullRequest(
      {
        repo: { owner: "acme", name: "api" },
        pullRequest: { number: 1, title: "T" },
        base: { sha: "a".repeat(40) },
        head: { sha: "b".repeat(40) },
        diff: file("src/a.ts"),
        diffTruncated: false,
      },
      {
        llm: llm.roles,
        clock: { now: () => new Date("2026-10-27T00:00:00Z") },
        sha256Hex: (text) => createHash("sha256").update(text).digest("hex"),
        generator: { name: "rocky" },
      },
    );
    expect(outcome.status).toBe("done");
    // triage, review, graph, flows, walkthrough, briefing (H4-7).
    expect(llm.calls).toHaveLength(6);
    expect(llm.calls.map(stageOf)).toEqual([
      "triage",
      "review",
      "graph",
      "flows",
      "walkthrough",
      "briefing",
    ]);
    const stages = Object.values(STAGE_CALLS);
    for (const call of llm.calls) {
      const stage = stages.find((s) => s.instructions === call.instructions);
      expect(stage, call.role).toBeDefined();
      expect(stage?.role).toBe(call.role);
      expect(stage?.maxOutputTokens).toBe(call.maxOutputTokens);
    }
    expect(STAGE_CALLS.triage.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS.triage);
    expect(STAGE_CALLS.briefing.role).toBe("review");
    expect(STAGE_CALLS.flows.role).toBe("graph");
    expect(STAGE_CALLS.walkthrough.role).toBe("graph");
  });
});
