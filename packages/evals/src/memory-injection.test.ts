import { createHash } from "node:crypto";
import {
  analyzePullRequest,
  MEMORY_CANARY,
  type AnalysisMemoryEntry,
  type AnalysisOutcome,
} from "@rocky-reviews/core";
import { scriptedRoles, type Script, type ScriptedCall } from "@rocky-reviews/core/testing";
import { describe, expect, it } from "vitest";
import {
  ADVERSARIES,
  adversaryScript,
  honestScriptFor,
  type Adversary,
} from "./injection/adversary.js";
import { storedViolations } from "./injection/check.js";
import { INJECTION_CORPUS } from "./injection/corpus.js";
import { injectionRequest, PR847_FIXTURE } from "./injection/inject.js";

/**
 * P8-2: project memory is a new channel into review prompts (ADR 0015 §2: "any new channel must
 * go in untrusted parts and run this corpus"). Every corpus payload is planted as a stored
 * convention entry (offered to every reviewed file, the widest reach an entry has) on the clean
 * pr-847, and every adversary obeys it fully. Whatever the payload and the adversary:
 *
 * - the payload never reaches the instructions slot, and the memory part only review calls;
 * - triage never sees memory, so every file keeps its clean triage level and the verdict keeps the
 *   triage floor;
 * - the stored document passes the independent checks: V1 (verdict floor), F1 (inside the diff),
 *   M1 (no markup), L1 (no canary, the memory canary included, and no prompt text);
 * - an entry the pipeline refuses (multi-line, markup, a canary, prompt text) reaches no call.
 *
 * What memory can do by design is keep a reviewed file's findings out (a dismissal): an obeying
 * model suppresses findings of the files it reviews with the entry, as with a payload inside the
 * file (ADR 0015 R1). The floors above bound what that buys.
 */

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
const ENTRY_ID = "00000000-0000-4000-8000-000000000847";

const entryFor = (payload: string): AnalysisMemoryEntry => ({
  id: ENTRY_ID,
  kind: "convention",
  reason: null,
  // As a learned entry would carry it: the payload as a finding title, after the fixed prefix.
  text: `Accepted in review: ${payload}`.slice(0, 300),
  path: "src/auth/invitations.ts",
  source: "convention · PR #840",
  confidence: 60,
});

/** A memory-review call answers in the memory shape; the adversary decides the content. */
const memoryShaped =
  (script: Script): Script =>
  async (call) => {
    const answer = await script(call);
    if (!call.labels.includes("memory") || !("value" in answer)) return answer;
    const value = answer.value as { findings?: unknown };
    if (!Array.isArray(value.findings)) return answer;
    return {
      value: {
        ...value,
        findings: value.findings.map((f: object) => ({ memory: [], ...f })),
        memoryApplied: ["M1"],
      },
    };
  };

const run = async (script: Script, memory: readonly AnalysisMemoryEntry[]) => {
  const llm = scriptedRoles(memoryShaped(script));
  const outcome: AnalysisOutcome = await analyzePullRequest(
    { ...injectionRequest(undefined, PR847_FIXTURE), memory },
    {
      llm: llm.roles,
      clock: { now: () => new Date("2026-11-05T12:00:00.000Z") },
      sha256Hex,
      generator: { name: "rocky", version: "0.0.0" },
      unitKeySalt: "memory-injection",
    },
  );
  return { outcome, calls: llm.calls };
};

const CLEAN = await run(honestScriptFor(PR847_FIXTURE), []);
const cleanTriage = () => {
  if (CLEAN.outcome.status !== "done") throw new Error("clean run failed");
  return CLEAN.outcome.document.triage.files.map((f) => [f.path, f.level]);
};
const request = injectionRequest(undefined, PR847_FIXTURE);
const pr = { title: request.pullRequest.title, diff: request.diff };

let planted = 0;
let refused = 0;

describe.each(INJECTION_CORPUS)("corpus case $id planted in project memory", (c) => {
  it.each(ADVERSARIES)(
    "a model that obeys it (%s) keeps the floors, the diff and L1",
    async (mode: Adversary) => {
      const { outcome, calls } = await run(
        adversaryScript(mode, c.trigger, undefined, PR847_FIXTURE),
        [entryFor(c.payload)],
      );
      for (const call of calls) {
        expect(call.instructions.text).not.toContain(c.trigger);
        expect(call.instructions.text).not.toContain(ENTRY_ID);
        if (call.labels.includes("memory")) {
          expect(call.role).toBe("review");
          expect(call.part("file_path")).toBeDefined();
        }
      }
      expect(storedViolations(outcome, pr)).toEqual([]);
      expect(JSON.stringify(outcome)).not.toContain(MEMORY_CANARY);
      if (outcome.stats.memoryDropped === 1) {
        refused++;
        expect(calls.some((call) => call.labels.includes("memory"))).toBe(false);
        return;
      }
      planted++;
      expect(outcome.status).toBe("done");
      if (outcome.status !== "done") return;
      for (const call of calls.filter((call) => call.role === "triage"))
        expect(call.labels).not.toContain("memory");
      // Memory never reaches triage: every file keeps its clean level, unless its review (the
      // only call with memory) failed closed, which makes the file unanalysed and raises the floor.
      const unanalysed = new Set(outcome.document.provenance.unanalysed.map((f) => f.path));
      const kept = cleanTriage().filter(([path]) => !unanalysed.has(path!));
      expect(outcome.document.triage.files.map((f) => [f.path, f.level])).toEqual(kept);
    },
  );
});

describe("the memory channel over the corpus", () => {
  it("planted and refused entries were both exercised, so neither branch is vacuous", () => {
    expect(planted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(planted + refused).toBe(INJECTION_CORPUS.length * ADVERSARIES.length);
  });

  it("a clean entry reaches every review and is cited, with its stored text", async () => {
    const { outcome, calls } = await run(honestScriptFor(PR847_FIXTURE), [
      entryFor("Validate input"),
    ]);
    const reviews = calls.filter(
      (call: ScriptedCall) => call.role === "review" && call.part("file_path"),
    );
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((call) => call.labels.includes("memory"))).toBe(true);
    if (outcome.status !== "done") throw new Error("failed");
    expect(outcome.document.briefing.memoryApplied).toEqual([
      {
        entryId: ENTRY_ID,
        text: "Accepted in review: Validate input",
        source: "convention · PR #840",
      },
    ]);
  });
});
