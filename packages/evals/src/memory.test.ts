import { createHash } from "node:crypto";
import {
  analyzePullRequest,
  MEMORY_CANARY_MARKER,
  type AnalysisRequest,
} from "@rocky-reviews/core";
import { scriptedRoles, type Script, type ScriptedCall } from "@rocky-reviews/core/testing";
import { describe, expect, it } from "vitest";
import { MEMORY_RUN_1, MEMORY_RUN_2, memoryFakeScript } from "./memory/case.js";
import { MEMORY_EVAL_ENTRY_ID, runMemoryEval, type MemoryStep } from "./memory/run.js";
import { storedViolations } from "./injection/check.js";
import { scoreFindings } from "./score.js";
import { fakeModel } from "./seeded/fake-model.js";

/**
 * P8-2 acceptance: a pattern dismissed as intentional is not raised again on the next run. On the
 * `--fake` roles (no network, deterministic), through the real pipeline and the real learning
 * rules: run 1 raises the pattern, the reviewer dismisses it as intentional, Rocky learns a
 * dismissal entry, and run 2 on a similar pull request in the same directory does not raise it,
 * cites the entry and still finds the real bug.
 */

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

const analyseWith =
  (scriptFor: (step: MemoryStep) => Script, calls: Map<MemoryStep, ScriptedCall[]> = new Map()) =>
  async (step: MemoryStep, request: AnalysisRequest) => {
    const llm = scriptedRoles(scriptFor(step));
    calls.set(step, llm.calls);
    return analyzePullRequest(request, {
      llm: llm.roles,
      clock: { now: () => new Date("2026-11-05T12:00:00Z") },
      sha256Hex,
      generator: { name: "rocky-evals" },
      unitKeySalt: "evals:fake",
    });
  };

const fake = (step: MemoryStep) => memoryFakeScript(step === "learn" ? MEMORY_RUN_1 : MEMORY_RUN_2);

describe("the project-memory eval (P8-2)", () => {
  it("a pattern dismissed as intentional is not raised again on the next run, and the entry is cited", async () => {
    const calls = new Map<MemoryStep, ScriptedCall[]>();
    const result = await runMemoryEval(analyseWith(fake, calls));
    expect(result).toEqual({
      status: "done",
      run1Raised: true,
      learned: true,
      controlRaised: true,
      run2Raised: false,
      run2Cited: true,
      run2BugFound: true,
      pass: true,
    });
    // Run 2's review got the learned entry as the memory part, behind its canary, as data.
    const review = calls.get("apply")!.find((c) => c.labels.includes("memory"))!;
    const block = JSON.parse(review.part("memory")!) as {
      marker: string;
      entries: { id: string; kind: string; reason: string; path: string; text: string }[];
    };
    expect(block).toEqual({
      marker: MEMORY_CANARY_MARKER,
      entries: [
        {
          id: "M1",
          kind: "dismissal",
          reason: "intentional",
          // The learned entry covers up to the dismissed finding's severity (fix round, M2).
          coversUpTo: MEMORY_RUN_1.pattern.severity,
          path: MEMORY_RUN_1.path,
          text: `Dismissed as intentional: ${MEMORY_RUN_1.pattern.title}`,
        },
      ],
    });
    expect(review.instructions.text).not.toContain(MEMORY_RUN_1.pattern.title);
    // Neither the control nor run 1 carried memory.
    for (const step of ["learn", "control"] as const)
      expect(calls.get(step)!.some((c) => c.labels.includes("memory"))).toBe(false);
  });

  it("fails when the model ignores memory: the eval measures the model, not the plumbing alone", async () => {
    // The decent model that ignores the memory block: on a memory call it answers in the memory
    // shape but suppresses nothing, so run 2 raises the pattern again and cites nothing.
    const ignoring = (step: MemoryStep): Script => {
      const pr = step === "learn" ? MEMORY_RUN_1 : MEMORY_RUN_2;
      const base = fakeModel({
        triage: { [pr.path]: { score: 60, level: "important", reason: "A job." } },
        findings: {
          [pr.path]: [
            { severity: pr.pattern.severity, lines: 4, title: pr.pattern.title },
            { severity: pr.bug.severity, lines: pr.bug.range.start, title: pr.bug.title },
          ],
        },
        tldr: ["Adds a job."],
        verdict: { level: "medium", reason: "A job." },
      });
      return async (call) => {
        const answer = await base(call);
        if (!call.labels.includes("memory") || !("value" in answer)) return answer;
        const { findings } = answer.value as { findings: object[] };
        return {
          value: { findings: findings.map((f) => ({ ...f, memory: [] })), suppressed: [] },
        };
      };
    };
    const result = await runMemoryEval(analyseWith(ignoring));
    expect(result).toMatchObject({ run2Raised: true, run2Cited: false, pass: false });
  });

  it("the run-2 document is clean by the injection checks, and holds the entry only as a ref", async () => {
    let stored: unknown;
    await runMemoryEval(async (step, request) => {
      const outcome = await analyseWith(fake)(step, request);
      if (step === "apply") {
        stored = outcome;
        expect(
          storedViolations(outcome, { title: request.pullRequest.title, diff: request.diff }),
        ).toEqual([]);
        if (outcome.status === "done") {
          expect(outcome.document.briefing.memoryApplied).toEqual([
            {
              entryId: MEMORY_EVAL_ENTRY_ID,
              text: `Dismissed as intentional: ${MEMORY_RUN_1.pattern.title}`,
              source: "dismissal · PR #1301",
            },
          ]);
          const score = scoreFindings([MEMORY_RUN_2.pattern], outcome.document.findings);
          expect(score.matched).toBe(0);
        }
      }
      return outcome;
    });
    expect(stored).toBeDefined();
  });
});
