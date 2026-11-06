import { createHash } from "node:crypto";
import {
  analyzePullRequest,
  MEMORY_CANARY_MARKER,
  preTriage,
  type AnalysisRequest,
  type LlmRoles,
  type StructuredCompletionRequest,
  type StructuredCompletionResult,
} from "@rocky-reviews/core";
import { scriptedRoles, type Script, type ScriptedCall } from "@rocky-reviews/core/testing";
import type { AnalysisDocument, Finding } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import { MEMORY_RUN_1, MEMORY_RUN_2, memoryCaseDiff, memoryFakeScript } from "./memory/case.js";
import { pinTriage, type PinnedLevel } from "./memory/pin.js";
import {
  MEMORY_EVAL_ENTRY_ID,
  MEMORY_TRIAGE_PIN,
  runMemoryEval,
  type MemoryAnalyse,
  type MemoryStep,
} from "./memory/run.js";
import { storedViolations } from "./injection/check.js";
import { scoreFindings } from "./score.js";
import { fakeModel } from "./seeded/fake-model.js";

/**
 * P8-2 acceptance: a pattern dismissed as intentional is not raised again on the next run. On the
 * `--fake` roles (no network, deterministic), through the real pipeline and the real learning
 * rules: run 1 raises the pattern, the reviewer dismisses it as intentional, Rocky learns a
 * dismissal entry, and run 2 on a similar pull request in the same directory does not raise it,
 * cites the entry and still finds the real bug. Triage is pinned to `important` as the runner
 * does it (`pinTriage`), so the result measures memory only; the model's level is recorded.
 */

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** Runs an analysis as the runner does: the script's roles, pinned when the eval asks for it. */
const analyseWith =
  (
    scriptFor: (step: MemoryStep) => Script,
    calls: Map<MemoryStep, ScriptedCall[]> = new Map(),
  ): MemoryAnalyse =>
  async (step: MemoryStep, request: AnalysisRequest, { pinTriage: level }) => {
    const llm = scriptedRoles(scriptFor(step));
    calls.set(step, llm.calls);
    const pin = level === null ? undefined : pinTriage(llm.roles, level);
    const outcome = await analyzePullRequest(request, {
      llm: pin?.roles ?? llm.roles,
      clock: { now: () => new Date("2026-11-05T12:00:00Z") },
      sha256Hex,
      generator: { name: "rocky-evals" },
      unitKeySalt: "evals:fake",
    });
    return { outcome, answered: pin?.answered };
  };

const prOf = (step: MemoryStep) => (step === "learn" ? MEMORY_RUN_1 : MEMORY_RUN_2);
const fake = (step: MemoryStep) => memoryFakeScript(prOf(step));
/** The decent model, but it calls pr-1302 (the control and run 2) `critical`. */
const criticalApply = (step: MemoryStep) =>
  memoryFakeScript(prOf(step), { triage: step === "learn" ? "important" : "critical" });

describe("the project-memory eval (P8-2)", () => {
  it("a pattern dismissed as intentional is not raised again on the next run, and the entry is cited", async () => {
    const calls = new Map<MemoryStep, ScriptedCall[]>();
    const result = await runMemoryEval(analyseWith(fake, calls));
    const conditions = {
      status: "done",
      run1Raised: true,
      learned: true,
      controlRaised: true,
      run2Raised: false,
      run2Cited: true,
      run2BugFound: true,
      pass: true,
    };
    expect(result).toMatchObject({ ...conditions, passes: 1 });
    expect(result.trials).toHaveLength(1);
    // Every analysis is pinned to `important`; the fake said `important` itself.
    const reviewed = {
      status: "done",
      failure: null,
      level: "important",
      pinned: "important",
      modelLevel: "important",
      reviewed: true,
    };
    expect(result.trials[0]).toEqual({
      ...conditions,
      runs: {
        learn: {
          ...reviewed,
          unanalysed: null,
          findings: 2,
          matched: ["B1", "P1"],
          patternSeverity: "medium",
          suppressed: 0,
          restored: 0,
          doubleCheck: 0,
          hidden: 0,
          hiddenOnCritical: 0,
        },
        control: {
          ...reviewed,
          unanalysed: null,
          findings: 2,
          matched: ["B2", "P2"],
          patternSeverity: "medium",
          suppressed: 0,
          restored: 0,
          doubleCheck: 0,
          hidden: 0,
          hiddenOnCritical: 0,
        },
        apply: {
          ...reviewed,
          unanalysed: null,
          findings: 1,
          matched: ["B2"],
          patternSeverity: null,
          suppressed: 1,
          restored: 0,
          doubleCheck: 0,
          // P8-2b: the hidden pattern is listed in the document, never invisible.
          hidden: 1,
          hiddenOnCritical: 0,
        },
      },
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
            {
              severity: pr.pattern.severity,
              lines: pr.pattern.range.start,
              title: pr.pattern.title,
            },
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
    await runMemoryEval(async (step, request, options) => {
      const analysed = await analyseWith(fake)(step, request, options);
      const { outcome } = analysed;
      if (step === "apply" && outcome !== "capped") {
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
      return analysed;
    });
    expect(stored).toBeDefined();
  });

  it("records why a run raised nothing: unpinned, a file triaged normal is never reviewed (the first live run)", async () => {
    // A triage that calls the case file `normal`: no review, so no findings and nothing learned,
    // while every analysis is `done`. The diagnosis says so. (With the pin, the level would be
    // `important` and the model's `normal` kept as `modelLevel`.)
    const normal = (step: MemoryStep): Script => {
      const pr = step === "learn" ? MEMORY_RUN_1 : MEMORY_RUN_2;
      return fakeModel({
        triage: { [pr.path]: { score: 30, level: "normal", reason: "A small job." } },
        findings: {},
        tldr: ["Adds a job."],
        verdict: { level: "low", reason: "A job." },
      });
    };
    const result = await runMemoryEval(analyseWith(normal), { pinTriage: null });
    expect(result).toMatchObject({ status: "done", run1Raised: false, pass: false, passes: 0 });
    for (const run of Object.values(result.trials[0]!.runs))
      expect(run).toMatchObject({
        status: "done",
        level: "normal",
        pinned: null,
        modelLevel: null,
        reviewed: false,
        findings: 0,
        matched: [],
      });
  });

  describe("triage is pinned to important, so pass/fail measures memory only (fix round 3)", () => {
    it(`pins every analysis to ${MEMORY_TRIAGE_PIN} by default, and keeps the model's own level as a diagnostic`, async () => {
      // The fake calls pr-1302 `critical` in the control and run 2 (the third live run's trial
      // 2): pinned, both are reviewed at `important`, the suppression stands, and the trial
      // passes; the report says what the model answered.
      const calls = new Map<MemoryStep, ScriptedCall[]>();
      const result = await runMemoryEval(analyseWith(criticalApply, calls));
      expect(result).toMatchObject({ pass: true, run2Raised: false, run2Cited: true });
      const { runs } = result.trials[0]!;
      expect(runs.learn).toMatchObject({
        level: "important",
        pinned: "important",
        modelLevel: "important",
      });
      expect(runs.control).toMatchObject({
        level: "important",
        pinned: "important",
        modelLevel: "critical",
      });
      expect(runs.apply).toMatchObject({
        level: "important",
        pinned: "important",
        modelLevel: "critical",
        suppressed: 1,
        restored: 0,
      });
      // The triage model was still called: the pin replaces its answer, it does not skip it.
      expect(calls.get("apply")!.filter((c) => c.role === "triage")).toHaveLength(1);
    });

    it("the pin moves the score into the pinned level's band and leaves everything else alone", async () => {
      const llm = scriptedRoles(criticalApply("apply"));
      const pin = pinTriage(llm.roles, "important");
      const triage = pin.roles.completion("triage");
      expect(triage.role).toBe("triage");
      // Only the triage role is wrapped: the review role is the script's own client.
      expect(pin.roles.completion("review").role).toBe("review");
      const outcome = await analyzePullRequest(
        {
          repo: { owner: "acme", name: "rocky-app" },
          pullRequest: { number: 1302, title: MEMORY_RUN_2.title },
          base: { sha: MEMORY_RUN_2.base },
          head: { sha: MEMORY_RUN_2.head },
          diff: memoryCaseDiff(MEMORY_RUN_2),
          diffTruncated: false,
        },
        { llm: pin.roles, clock: { now: () => new Date() }, sha256Hex, generator: { name: "t" } },
      );
      if (outcome.status !== "done") throw new Error(outcome.code);
      const file = outcome.document.triage.files.find((f) => f.path === MEMORY_RUN_2.path);
      expect(file).toMatchObject({ level: "important", score: 79, reason: "A new payments job." });
      expect(pin.answered.get(MEMORY_RUN_2.path)).toBe("critical");
    });

    it("the pin passes through, unchanged and unrecorded, whatever it cannot pin", async () => {
      // A triage client that answers whatever the case says: the wrapper's early returns.
      const base = { model: "m", usage: undefined, provider: "scripted" };
      const cases: [string, StructuredCompletionResult<unknown>][] = [
        ["a refused result", { ...base, status: "refused" }],
        ["an invalid result", { ...base, status: "invalid_output", issues: ["level: x"] }],
        ["a non-record value", { ...base, status: "ok", value: "important" }],
        ["an unknown level", { ...base, status: "ok", value: { level: "bogus", score: 90 } }],
        ["a missing level", { ...base, status: "ok", value: { score: 90 } }],
      ];
      const request = {
        untrusted: [{ label: "file_path", text: MEMORY_RUN_2.path }],
      } as unknown as StructuredCompletionRequest<unknown>;
      for (const [name, result] of cases) {
        const roles: LlmRoles = {
          completion: (role) => ({ role, complete: async () => result as never }),
          embedding: () => undefined,
        };
        const pin = pinTriage(roles, "important");
        expect(await pin.roles.completion("triage").complete(request), name).toBe(result);
        expect(pin.answered.size, name).toBe(0);
      }
      // A valid level without a score is pinned (the level only) and recorded.
      const scoreless: StructuredCompletionResult<unknown> = {
        ...base,
        status: "ok",
        value: { level: "critical", reason: "r" },
      };
      const roles: LlmRoles = {
        completion: (role) => ({ role, complete: async () => scoreless as never }),
        embedding: () => undefined,
      };
      const levels: PinnedLevel[] = ["critical", "important", "normal", "low"];
      for (const level of levels) {
        const pin = pinTriage(roles, level);
        const pinned = await pin.roles.completion("triage").complete(request);
        expect(pinned, level).toMatchObject({ status: "ok", value: { level, reason: "r" } });
        expect((pinned as { value: Record<string, unknown> }).value["score"]).toBeUndefined();
        expect(pin.answered.get(MEMORY_RUN_2.path), level).toBe("critical");
      }
    });
  });

  describe("the critical-file rule, deterministically (ADR 0037 M3)", () => {
    it("unpinned, a suppression on a file triaged critical is restored as a draft that says double-check", async () => {
      // The fake model follows memory (it suppresses P2 under the entry); the pipeline restores
      // it because the file is critical, with the entry it was dismissed under. The eval then
      // fails: the pattern was raised and nothing was applied (the third live run's trial 2).
      let stored: Finding | undefined;
      const result = await runMemoryEval(
        async (step, request, options) => {
          const analysed = await analyseWith(criticalApply)(step, request, options);
          if (
            step === "apply" &&
            analysed.outcome !== "capped" &&
            analysed.outcome.status === "done"
          )
            stored = analysed.outcome.document.findings.find(
              (f) => f.title === MEMORY_RUN_2.pattern.title,
            );
          return analysed;
        },
        { pinTriage: null },
      );
      expect(result).toMatchObject({
        controlRaised: true,
        run2Raised: true,
        run2Cited: false,
        run2BugFound: true,
        pass: false,
      });
      expect(result.trials[0]!.runs.apply).toMatchObject({
        level: "critical",
        pinned: null,
        modelLevel: null,
        reviewed: true,
        findings: 2,
        matched: ["B2", "P2"],
        suppressed: 0,
        restored: 1,
        doubleCheck: 1,
      });
      expect(stored?.restored).toEqual({
        entry: {
          entryId: MEMORY_EVAL_ENTRY_ID,
          text: `Dismissed as intentional: ${MEMORY_RUN_1.pattern.title}`,
          source: "dismissal · PR #1301",
        },
        path: MEMORY_RUN_1.path,
        dismissedAs: "intentional",
        shownBecause: "critical_file",
      });
      expect(stored?.memory).toEqual([]);
    });

    it("P8-2b: a dismissal taken on a critical file stands on a critical file nearby: hidden, listed, cited", async () => {
      // Unpinned and the fake calls every analysis `critical`: the learn run's document holds the
      // case file as critical, so the entry is learned at that level; run 2 is critical too, in
      // the same directory, so the suppression stands and the pattern is hidden, not drafted.
      const critical = (step: MemoryStep) => memoryFakeScript(prOf(step), { triage: "critical" });
      let document: AnalysisDocument | undefined;
      const result = await runMemoryEval(
        async (step, request, options) => {
          const analysed = await analyseWith(critical)(step, request, options);
          if (
            step === "apply" &&
            analysed.outcome !== "capped" &&
            analysed.outcome.status === "done"
          )
            document = analysed.outcome.document;
          return analysed;
        },
        { pinTriage: null },
      );
      expect(result).toMatchObject({
        run1Raised: true,
        learned: true,
        controlRaised: true,
        run2Raised: false,
        run2Cited: true,
        run2BugFound: true,
        pass: true,
        pinDecided: 0,
      });
      expect(result.trials[0]!.runs.apply).toMatchObject({
        level: "critical",
        pinned: null,
        findings: 1,
        matched: ["B2"],
        suppressed: 1,
        restored: 0,
        doubleCheck: 0,
        hidden: 1,
        hiddenOnCritical: 1,
      });
      expect(document?.hidden?.map((h) => h.title)).toEqual([MEMORY_RUN_2.pattern.title]);
      expect(document?.hidden?.[0]?.hiddenBy).toEqual({
        entry: {
          entryId: MEMORY_EVAL_ENTRY_ID,
          text: `Dismissed as intentional: ${MEMORY_RUN_1.pattern.title}`,
          source: "dismissal · PR #1301",
        },
        path: MEMORY_RUN_1.path,
        dismissedAs: "intentional",
      });
    });

    it("P8-2b: the level is the learn run's stored triage: pinned important, the entry does not stand on a critical run 2", async () => {
      // The pinned eval (the default) learns at `important` even when the model said critical,
      // so a critical run 2 restores the finding (the previous test's rule), and N3 counts the
      // pinned-critical pass: here the pin is what made trial pass.
      const result = await runMemoryEval(analyseWith(criticalApply));
      expect(result).toMatchObject({ pass: true, passes: 1, pinDecided: 1 });
      expect(result.trials[0]!.runs.apply).toMatchObject({
        modelLevel: "critical",
        suppressed: 1,
        hidden: 1,
        hiddenOnCritical: 0,
      });
    });
  });

  it("runs several trials and reports how many passed", async () => {
    const result = await runMemoryEval(analyseWith(fake), { trials: 2 });
    expect(result).toMatchObject({ pass: true, passes: 2 });
    expect(result.trials).toHaveLength(2);
    await expect(runMemoryEval(analyseWith(fake), { trials: 0 })).rejects.toThrow(RangeError);
  });

  it("the case files take no rule floor, so a dismissal can stand on run 2", () => {
    for (const pr of [MEMORY_RUN_1, MEMORY_RUN_2])
      expect(preTriage(pr.path)).toEqual({ kind: "analyse" });
  });
});
