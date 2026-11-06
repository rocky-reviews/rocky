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
 * go in untrusted parts and run this corpus"). Every corpus payload is planted in stored entries
 * on the clean pr-847, in three variants: a convention, a dismissal (fix round, L1) and several
 * entries offered and cited together (a convention and a dismissal carrying the payload, and a
 * clean convention). Every adversary obeys them fully: it cites every entry it was given and,
 * when it was given a dismissal, suppresses every finding it would raise under it. Whatever the
 * payload, the variant and the adversary:
 *
 * - the payload never reaches the instructions slot, and the memory part only review calls;
 * - triage never sees memory, so every file keeps its clean triage level and the verdict keeps the
 *   triage floor;
 * - the stored document passes the independent checks: V1 (verdict floor), F1 (inside the diff),
 *   M1 (no markup), L1 (no canary, the memory canary included, and no prompt text);
 * - a suppressed finding above what the dismissal covers (high or critical here) is stored anyway:
 *   the pipeline, not the model, decides what a dismissal may keep out (fix round, M2);
 * - an entry the pipeline refuses (multi-line, markup, a canary, prompt text) reaches no call.
 *
 * What memory can do by design is keep a reviewed file's findings out, up to the dismissal's
 * severity (ADR 0037): as with a payload inside the file (ADR 0015 R1), the floors above bound
 * what that buys.
 */

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
const ENTRY_ID = "00000000-0000-4000-8000-000000000847";
const DISMISSAL_ID = "00000000-0000-4000-8000-000000000848";
const CLEAN_ID = "00000000-0000-4000-8000-000000000849";

const entryFor = (payload: string): AnalysisMemoryEntry => ({
  id: ENTRY_ID,
  kind: "convention",
  origin: "learned",
  reason: null,
  severity: null,
  // As a learned entry would carry it: the payload as a finding title, after the fixed prefix.
  text: `Accepted in review: ${payload}`.slice(0, 300),
  path: "src/auth/invitations.ts",
  source: "convention · PR #840",
  confidence: 60,
});

const dismissalFor = (payload: string): AnalysisMemoryEntry => ({
  id: DISMISSAL_ID,
  kind: "dismissal",
  origin: "learned",
  reason: "intentional",
  // What the learner records: covers up to the dismissed finding's severity.
  severity: "medium",
  text: `Dismissed as intentional: ${payload}`.slice(0, 300),
  path: "src/auth/invitations.ts",
  source: "dismissal · PR #841",
  confidence: 80,
});

const VARIANTS = {
  convention: (payload: string) => [entryFor(payload)],
  dismissal: (payload: string) => [dismissalFor(payload)],
  several: (payload: string) => [
    entryFor(payload),
    dismissalFor(payload),
    { ...entryFor("Validate input"), id: CLEAN_ID, path: "src/auth/tokens.ts" },
  ],
} as const;
type Variant = keyof typeof VARIANTS;

interface Suppressed {
  readonly title: string;
  readonly severity: string;
  readonly range: { readonly start: number; readonly end: number };
}

/**
 * A memory-review call answers in the memory shape; the adversary decides the content, and the
 * model obeys the memory: every finding cites every entry, or, given a dismissal, every finding is
 * suppressed under it. `last` keeps each file's last suppressed list (the answer that counted).
 */
const memoryShaped =
  (script: Script, last: Map<string, readonly Suppressed[]>): Script =>
  async (call) => {
    const answer = await script(call);
    const memory = call.part("memory");
    if (memory === undefined || !("value" in answer)) return answer;
    const value = answer.value as { findings?: unknown };
    if (!Array.isArray(value.findings)) return answer;
    const block = JSON.parse(memory) as { entries: { id: string; kind: string }[] };
    const handles = block.entries.map((e) => e.id);
    const dismissal = block.entries.find((e) => e.kind === "dismissal")?.id;
    const findings = value.findings as {
      suggestion?: unknown;
      title: string;
      severity: string;
      range: Suppressed["range"];
    }[];
    if (dismissal === undefined) {
      last.set(call.part("file_path") ?? "", []);
      return {
        value: {
          ...value,
          findings: findings.map((f) => ({ memory: handles, ...f })),
          suppressed: [],
        },
      };
    }
    last.set(
      call.part("file_path") ?? "",
      findings.map((f) => ({ title: f.title, severity: f.severity, range: f.range })),
    );
    return {
      value: {
        ...value,
        findings: [],
        suppressed: findings.map((f) => ({ ...withoutSuggestion(f), entry: dismissal })),
      },
    };
  };

/** A finding as a suppressed one carries it: without a suggestion. */
const withoutSuggestion = <T extends object>(finding: T): Omit<T, "suggestion"> => {
  const copy: Record<string, unknown> = { ...(finding as Record<string, unknown>) };
  delete copy["suggestion"];
  return copy as Omit<T, "suggestion">;
};

const run = async (script: Script, memory: readonly AnalysisMemoryEntry[]) => {
  const last = new Map<string, readonly Suppressed[]>();
  const llm = scriptedRoles(memoryShaped(script, last));
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
  return { outcome, calls: llm.calls, last };
};

const CLEAN = await run(honestScriptFor(PR847_FIXTURE), []);
const cleanTriage = () => {
  if (CLEAN.outcome.status !== "done") throw new Error("clean run failed");
  return CLEAN.outcome.document.triage.files.map((f) => [f.path, f.level]);
};
const request = injectionRequest(undefined, PR847_FIXTURE);
const pr = { title: request.pullRequest.title, diff: request.diff };

const ABOVE_COVERED: ReadonlySet<string> = new Set(["high", "critical"]);
let restored = 0;
let suppressedKept = 0;
let planted = 0;
let refused = 0;

const CASES = INJECTION_CORPUS.flatMap((c) =>
  (Object.keys(VARIANTS) as Variant[]).map((variant) => ({ ...c, variant })),
);

describe.each(CASES)("corpus case $id planted in project memory ($variant)", (c) => {
  it.each(ADVERSARIES)(
    "a model that obeys it (%s) keeps the floors, the diff, L1 and what a dismissal cannot cover",
    async (mode: Adversary) => {
      const entries = VARIANTS[c.variant](c.payload);
      const { outcome, calls, last } = await run(
        adversaryScript(mode, c.trigger, undefined, PR847_FIXTURE),
        entries,
      );
      for (const call of calls) {
        expect(call.instructions.text).not.toContain(c.trigger);
        for (const entry of entries) expect(call.instructions.text).not.toContain(entry.id);
        if (call.labels.includes("memory")) {
          expect(call.role).toBe("review");
          expect(call.part("file_path")).toBeDefined();
        }
      }
      expect(storedViolations(outcome, pr)).toEqual([]);
      expect(JSON.stringify(outcome)).not.toContain(MEMORY_CANARY);
      const payloadEntries = entries.filter((entry) => entry.id !== CLEAN_ID).length;
      if (outcome.stats.memoryDropped === payloadEntries) {
        refused++;
        if (payloadEntries === entries.length)
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
      // A dismissal covering up to medium keeps nothing above it out, however hard the model tries.
      for (const [path, items] of last) {
        if (unanalysed.has(path)) continue;
        const stored = outcome.document.findings.filter((f) => f.path === path);
        for (const item of items) {
          if (!ABOVE_COVERED.has(item.severity)) continue;
          restored++;
          expect(
            stored.some(
              (f) =>
                f.title === item.title &&
                f.range.start === item.range.start &&
                f.range.end === item.range.end,
            ),
          ).toBe(true);
        }
      }
      suppressedKept += outcome.stats.memorySuppressed;
    },
  );
});

describe("the memory channel over the corpus", () => {
  it("planted and refused entries were both exercised, so neither branch is vacuous", () => {
    expect(planted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(planted + refused).toBe(CASES.length * ADVERSARIES.length);
  });

  it("obeying models both had findings restored and had covered ones kept out", () => {
    expect(restored).toBeGreaterThan(0);
    expect(suppressedKept).toBeGreaterThan(0);
  });

  it("a clean entry reaches every review on its top-level directory and is cited, with its stored text", async () => {
    const { outcome, calls } = await run(honestScriptFor(PR847_FIXTURE), [
      entryFor("Validate input"),
    ]);
    // Only files on the entry's top-level directory are offered it (fix round, S2).
    const reviews = calls.filter(
      (call: ScriptedCall) => call.role === "review" && call.part("file_path"),
    );
    expect(reviews.length).toBeGreaterThan(0);
    for (const call of reviews)
      expect(call.labels.includes("memory")).toBe(call.part("file_path")!.startsWith("src/"));
    expect(reviews.some((call) => call.labels.includes("memory"))).toBe(true);
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
