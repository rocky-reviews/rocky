import { describe, expect, it } from "vitest";
import { REVIEW_INSTRUCTIONS } from "./analysis/instructions.js";
import { prepareMemoryEntry } from "./memory.js";
import {
  corroboratedConfidence,
  LEARNED_CONFIDENCE,
  learnedEntry,
  MAX_LEARNED_CONFIDENCE,
  memorySubject,
} from "./memory-learning.js";
import { MEMORY_CANARY_MARKER, PROMPT_CANARY } from "./prompt.js";

const SOURCE = { pullRequestNumber: 612, headSha: "c".repeat(40) };
const finding = (overrides: Partial<Parameters<typeof learnedEntry>[1]> = {}) => ({
  title: "Retry count is hard-coded",
  path: "src/jobs/retry.ts",
  range: { start: 4, end: 6 },
  severity: "medium" as const,
  ...overrides,
});

describe("learnedEntry: what a decision teaches (P8-2)", () => {
  it("a dismissal as intentional becomes a dismissal entry with its reason, evidence and confidence", () => {
    expect(learnedEntry({ kind: "dismissed", reason: "intentional" }, finding(), SOURCE)).toEqual({
      kind: "dismissal",
      text: "Dismissed as intentional: Retry count is hard-coded",
      evidence: {
        path: "src/jobs/retry.ts",
        sha: SOURCE.headSha,
        range: { start: 4, end: 6 },
        pullRequestNumber: 612,
      },
      confidence: LEARNED_CONFIDENCE.intentional,
      reason: "intentional",
    });
  });

  it.each([
    ["not_an_issue", "Dismissed as not an issue: ", 70],
    ["handled_elsewhere", "Dismissed as handled elsewhere: ", 70],
  ] as const)("a dismissal as %s carries its own text and confidence", (reason, prefix, conf) => {
    const learned = learnedEntry({ kind: "dismissed", reason }, finding(), SOURCE);
    expect(learned?.text).toBe(`${prefix}Retry count is hard-coded`);
    expect(learned?.confidence).toBe(conf);
    expect(learned?.reason).toBe(reason);
  });

  it("a dismissal as not worth it teaches nothing (a call about one PR's priorities)", () => {
    expect(learnedEntry({ kind: "dismissed", reason: "not_worth_it" }, finding(), SOURCE)).toBe(
      null,
    );
  });

  it("a dismissed critical finding teaches nothing: memory never hides critical findings", () => {
    const critical = finding({ severity: "critical" });
    expect(learnedEntry({ kind: "dismissed", reason: "intentional" }, critical, SOURCE)).toBe(null);
  });

  it("an accepted or edited draft becomes a convention, never a decision, without a reason", () => {
    const accepted = learnedEntry({ kind: "accepted", edited: false }, finding(), SOURCE);
    const edited = learnedEntry(
      { kind: "accepted", edited: true },
      finding({ severity: "critical" }),
      SOURCE,
    );
    expect(accepted).toMatchObject({
      kind: "convention",
      text: "Accepted in review: Retry count is hard-coded",
      confidence: LEARNED_CONFIDENCE.accepted,
      reason: null,
    });
    expect(edited).toMatchObject({ kind: "convention", confidence: LEARNED_CONFIDENCE.edited });
  });

  it("keeps the text to one line without a trailing period", () => {
    const learned = learnedEntry(
      { kind: "dismissed", reason: "intentional" },
      finding({ title: "  Retry   count\tis hard-coded. " }),
      SOURCE,
    );
    expect(learned?.text).toBe("Dismissed as intentional: Retry count is hard-coded");
  });

  it.each([
    ["the prompt canary", `About ${PROMPT_CANARY}`],
    ["the memory canary, spaced", MEMORY_CANARY_MARKER.split("").join(" ")],
    ["eight characters of the memory canary", `Fix ${MEMORY_CANARY_MARKER.slice(-8)} now`],
    ["a run of Rocky's prompt text", REVIEW_INSTRUCTIONS.text.slice(0, 120)],
    ["nothing", "   "],
  ])("refuses a title with %s", (_name, title) => {
    expect(
      learnedEntry({ kind: "dismissed", reason: "intentional" }, finding({ title }), SOURCE),
    ).toBe(null);
  });

  it("what it builds passes the store's own rules (prepareMemoryEntry)", () => {
    const learned = learnedEntry(
      { kind: "dismissed", reason: "handled_elsewhere" },
      finding({ title: "x".repeat(200) }),
      SOURCE,
    );
    const prepared = prepareMemoryEntry(learned, { origin: "learned" });
    expect(prepared.ok).toBe(true);
  });
});

describe("memorySubject and corroboratedConfidence", () => {
  it("reads the subject behind every learned prefix, and nothing else", () => {
    expect(memorySubject("Dismissed as intentional: Retry  Count")).toBe("retry count");
    expect(memorySubject("Accepted in review: Retry count")).toBe("retry count");
    expect(memorySubject("Dismissed as handled elsewhere: x")).toBe("x");
    expect(memorySubject("We keep the legacy endpoint")).toBe(null);
    expect(memorySubject("Accepted in review: ")).toBe(null);
  });

  it("a corroboration raises the confidence by a step, never past the cap", () => {
    expect(corroboratedConfidence(80, undefined)).toBe(80);
    expect(corroboratedConfidence(80, 80)).toBe(90);
    expect(corroboratedConfidence(80, 60)).toBe(80);
    expect(corroboratedConfidence(80, 90)).toBe(MAX_LEARNED_CONFIDENCE);
  });
});
