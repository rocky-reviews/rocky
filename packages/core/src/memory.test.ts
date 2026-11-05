import { MEMORY_CANARY, PROMPT_CANARY, PROMPT_CANARY_MARKER } from "./prompt.js";
import { describe, expect, it } from "vitest";
import {
  FORMER_MEMBER_LABEL,
  isMemoryKind,
  isMemoryOrigin,
  MAX_MEMORY_ENTRY_TEXT_LENGTH,
  MAX_MEMORY_TEXT_INPUT_LENGTH,
  MAX_KNOWN_PEOPLE,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  memoryAuthorLabel,
  memorySourceLabel,
  prepareMemoryEntry,
  readPullRequestNumber,
  type MemoryEntryProblem,
} from "./memory.js";
import { MAX_KNOWN_PEOPLE as PII_MAX_KNOWN_PEOPLE } from "./pii.js";

/**
 * P8-1 (ADR 0036 §1, §3): the entry's invariants, the scrub before validation, and what a
 * reader shows for an author who is gone.
 */

const SHA = "a".repeat(40);

const valid = () => ({
  kind: "convention",
  text: "Use the shared validator for emails.",
  evidence: {
    path: "src/invite.ts",
    sha: SHA,
    range: { start: 10, end: 12 },
    pullRequestNumber: 847,
  },
  confidence: 80,
});

const problemOf = (input: unknown, people: readonly string[] = []): MemoryEntryProblem | "ok" => {
  const result = prepareMemoryEntry(input, { origin: "member", people });
  return result.ok ? "ok" : result.problem;
};

describe("kinds and origins", () => {
  it("are fixed codes", () => {
    expect(MEMORY_KINDS).toEqual(["convention", "decision", "dismissal"]);
    expect(MEMORY_ORIGINS).toEqual(["member", "learned"]);
    expect(isMemoryKind("decision")).toBe(true);
    expect(isMemoryKind("note")).toBe(false);
    expect(isMemoryKind(1)).toBe(false);
    expect(isMemoryOrigin("learned")).toBe(true);
    expect(isMemoryOrigin("system")).toBe(false);
  });
});

describe("prepareMemoryEntry", () => {
  it("accepts a valid entry and returns it with the scrub report", () => {
    const result = prepareMemoryEntry(valid(), { origin: "member", people: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toEqual({
      kind: "convention",
      origin: "member",
      text: "Use the shared validator for emails.",
      evidence: {
        path: "src/invite.ts",
        sha: SHA,
        range: { start: 10, end: 12 },
        pullRequestNumber: 847,
      },
      confidence: 80,
      reason: null,
    });
    expect(result.scrubbed.total).toBe(0);
  });

  it("scrubs the text before validating it, with the caller's people", () => {
    const result = prepareMemoryEntry(
      { ...valid(), text: "  alice said: keep\tthe  legacy\nendpoint, cc @bob (bob@example.com) " },
      { origin: "learned", people: ["alice"] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.origin).toBe("learned");
    expect(result.draft.text).toBe("[person] said: keep the legacy endpoint, cc [user] ([email])");
    expect(result.scrubbed.replaced).toEqual({
      person: 1,
      email: 1,
      handle: 1,
      phone: 0,
      address: 0,
    });
    expect(result.scrubbed.total).toBe(3);
  });

  it("refuses what is not an object", () => {
    for (const input of [null, undefined, 1, "x", [], true]) {
      expect(problemOf(input)).toBe("invalid_entry");
    }
  });

  it("refuses an unknown kind; the origin is the caller's, never the input's (S5)", () => {
    expect(problemOf({ ...valid(), kind: "note" })).toBe("invalid_kind");
    expect(problemOf({ ...valid(), kind: undefined })).toBe("invalid_kind");
    const learned = prepareMemoryEntry({ ...valid(), origin: "member" }, { origin: "learned" });
    expect(learned.ok && learned.draft.origin).toBe("learned");
    expect(() => prepareMemoryEntry(valid(), { origin: "system" as unknown as "member" })).toThrow(
      TypeError,
    );
  });

  it("pairs the reason with the dismissal kind", () => {
    expect(problemOf({ ...valid(), kind: "dismissal" })).toBe("invalid_reason");
    expect(problemOf({ ...valid(), kind: "dismissal", reason: "because" })).toBe("invalid_reason");
    expect(problemOf({ ...valid(), kind: "dismissal", reason: "intentional" })).toBe("ok");
    expect(problemOf({ ...valid(), reason: "intentional" })).toBe("invalid_reason");
    expect(problemOf({ ...valid(), reason: null })).toBe("ok");
    const result = prepareMemoryEntry(
      { ...valid(), kind: "dismissal", reason: "not_worth_it" },
      { origin: "learned", people: [] },
    );
    expect(result.ok && result.draft.reason).toBe("not_worth_it");
  });

  it("bounds the text before and after the scrub", () => {
    expect(problemOf({ ...valid(), text: 7 })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "" })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "   \n  " })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "x".repeat(MAX_MEMORY_ENTRY_TEXT_LENGTH) })).toBe("ok");
    expect(problemOf({ ...valid(), text: "x".repeat(MAX_MEMORY_ENTRY_TEXT_LENGTH + 1) })).toBe(
      "text_too_long",
    );
    expect(problemOf({ ...valid(), text: "x".repeat(MAX_MEMORY_TEXT_INPUT_LENGTH + 1) })).toBe(
      "text_too_long",
    );
    // A scrub can lengthen the text ("bob" → "[person]"): the cap applies to what is stored.
    const nearCap = `${"x".repeat(MAX_MEMORY_ENTRY_TEXT_LENGTH - 6)} bobby`;
    expect(problemOf({ ...valid(), text: nearCap }, ["bobby"])).toBe("text_too_long");
  });

  it("refuses invisible characters, control characters, links and images (schema line rules)", () => {
    expect(problemOf({ ...valid(), text: "keep\u0000it" })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "keep\u0007it" })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "see [docs](https://evil.example/?x)" })).toBe(
      "invalid_text",
    );
    expect(problemOf({ ...valid(), text: "see ![img](https://evil.example/p.png)" })).toBe(
      "invalid_text",
    );
    expect(problemOf({ ...valid(), text: "see <https://evil.example>" })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "keep\uD800it" })).toBe("invalid_text");
    // Invisible characters are removed by the scrub, so they do not make a text invalid.
    const result = prepareMemoryEntry(
      { ...valid(), text: "keep​it ⁠now" },
      { origin: "member", people: [] },
    );
    expect(result.ok && result.draft.text).toBe("keepit now");
  });

  it("refuses the prompt canary in every spelling the leak guard folds, and PR-content markers (threat P3, security M1/L1)", () => {
    expect(problemOf({ ...valid(), text: `note ${PROMPT_CANARY_MARKER}` })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "note RK-CANARY-0 here" })).toBe("invalid_text");
    const spaced = PROMPT_CANARY.replace(/(.{4})/g, "$1 ").trim();
    const fullWidth = Array.from(PROMPT_CANARY, (c) =>
      /[0-9a-z]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c,
    ).join("");
    const lookalike = PROMPT_CANARY.replace(/e/g, "\u0435").replace(/a/g, "\u0430");
    const arabicDigits = PROMPT_CANARY.replace(/[0-9]/g, (d) =>
      String.fromCodePoint(0x0660 + Number(d)),
    );
    for (const variant of [
      PROMPT_CANARY,
      spaced,
      PROMPT_CANARY.toUpperCase(),
      fullWidth,
      lookalike,
      arabicDigits,
      PROMPT_CANARY.split("").join("-"),
      `${PROMPT_CANARY.slice(0, 8)}\u200B${PROMPT_CANARY.slice(8)}`,
    ]) {
      expect(problemOf({ ...valid(), text: `see ${variant} here` }), variant).toBe("invalid_text");
      expect(
        problemOf({ ...valid(), evidence: { ...valid().evidence, path: `src/${variant}.ts` } }),
        variant,
      ).toBe("invalid_path");
    }
    // Any run of eight canary characters is refused (two entries could hold halves); seven pass.
    expect(problemOf({ ...valid(), text: `see ${PROMPT_CANARY.slice(0, 15)} here` })).toBe(
      "invalid_text",
    );
    expect(problemOf({ ...valid(), text: `see ${PROMPT_CANARY.slice(4, 12)} here` })).toBe(
      "invalid_text",
    );
    expect(problemOf({ ...valid(), text: `see ${PROMPT_CANARY.slice(0, 7)} here` })).toBe("ok");
    expect(
      problemOf({
        ...valid(),
        evidence: { ...valid().evidence, path: `src/${PROMPT_CANARY.slice(8)}.ts` },
      }),
    ).toBe("invalid_path");
    expect(problemOf({ ...valid(), text: 'x <pr_content id="1"> y' })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "x </pr_content> y" })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "x < pr_content > y" })).toBe("invalid_text");
    expect(problemOf({ ...valid(), text: "the pr_content table is fine" })).toBe("ok");
  });

  it("validates the evidence path with the schema's path rules", () => {
    const withPath = (path: unknown) => ({ ...valid(), evidence: { ...valid().evidence, path } });
    expect(problemOf(withPath("src/a.ts"))).toBe("ok");
    expect(problemOf(withPath("/src/a.ts"))).toBe("invalid_path");
    expect(problemOf(withPath("src\\a.ts"))).toBe("invalid_path");
    expect(problemOf(withPath("src/../a.ts"))).toBe("invalid_path");
    expect(problemOf(withPath(".git/config"))).toBe("invalid_path");
    expect(problemOf(withPath("src/a.ts/"))).toBe("invalid_path");
    expect(problemOf(withPath("src/​a.ts"))).toBe("invalid_path");
    expect(problemOf(withPath(""))).toBe("invalid_path");
    expect(problemOf(withPath(3))).toBe("invalid_path");
    expect(problemOf(withPath(`${"a".repeat(1025)}`))).toBe("invalid_path");
  });

  it("validates the sha, the range and the pull request number", () => {
    const withEvidence = (patch: Record<string, unknown>) => ({
      ...valid(),
      evidence: { ...valid().evidence, ...patch },
    });
    expect(problemOf(withEvidence({ sha: "A".repeat(40) }))).toBe("invalid_sha");
    expect(problemOf(withEvidence({ sha: "a".repeat(39) }))).toBe("invalid_sha");
    expect(problemOf(withEvidence({ sha: "g".repeat(40) }))).toBe("invalid_sha");
    expect(problemOf(withEvidence({ sha: undefined }))).toBe("invalid_sha");
    expect(problemOf(withEvidence({ range: { start: 0, end: 1 } }))).toBe("invalid_range");
    expect(problemOf(withEvidence({ range: { start: 5, end: 4 } }))).toBe("invalid_range");
    expect(problemOf(withEvidence({ range: { start: 1, end: 200 } }))).toBe("ok");
    expect(problemOf(withEvidence({ range: { start: 1, end: 201 } }))).toBe("invalid_range");
    expect(problemOf(withEvidence({ range: { start: 1.5, end: 2 } }))).toBe("invalid_range");
    expect(problemOf(withEvidence({ range: { start: 1, end: 10_000_001 } }))).toBe("invalid_range");
    expect(problemOf(withEvidence({ range: null }))).toBe("invalid_range");
    expect(problemOf(withEvidence({ range: "1-2" }))).toBe("invalid_range");
    expect(problemOf(withEvidence({ pullRequestNumber: 0 }))).toBe("invalid_pull_request");
    expect(problemOf(withEvidence({ pullRequestNumber: 1_000_000_001 }))).toBe(
      "invalid_pull_request",
    );
    expect(problemOf(withEvidence({ pullRequestNumber: "847" }))).toBe("invalid_pull_request");
    expect(problemOf({ ...valid(), evidence: null })).toBe("invalid_evidence");
    expect(problemOf({ ...valid(), evidence: "src/a.ts" })).toBe("invalid_evidence");
  });

  it("refuses more distinct people than the scrubber accepts instead of truncating (security M2)", () => {
    expect(MAX_KNOWN_PEOPLE).toBe(PII_MAX_KNOWN_PEOPLE);
    const many = Array.from({ length: MAX_KNOWN_PEOPLE + 1 }, (_, i) => `person-${i}`);
    expect(problemOf(valid(), many)).toBe("too_many_people");
    // Duplicates (case, spelling) count once.
    const duplicates = Array.from({ length: MAX_KNOWN_PEOPLE }, (_, i) => `person-${i}`);
    expect(problemOf(valid(), [...duplicates, "PERSON-0", "person-1", "\uFF50erson-2"])).toBe("ok");
  });

  it("validates the confidence", () => {
    for (const confidence of [-1, 101, 1.5, "80", undefined, Number.NaN]) {
      expect(problemOf({ ...valid(), confidence })).toBe("invalid_confidence");
    }
    expect(problemOf({ ...valid(), confidence: 0 })).toBe("ok");
    expect(problemOf({ ...valid(), confidence: 100 })).toBe("ok");
  });

  it("ignores unknown fields and never reads the prototype", () => {
    expect(problemOf({ ...valid(), createdBy: "alice", author: "x" })).toBe("ok");
    const input = Object.create({ kind: "convention" }) as Record<string, unknown>;
    Object.assign(input, valid());
    delete input["kind"];
    expect(problemOf(input)).toBe("invalid_kind");
  });
});

describe("readPullRequestNumber", () => {
  it("reads a plausible number from an untrusted entry and nothing else", () => {
    expect(readPullRequestNumber(valid())).toBe(847);
    expect(readPullRequestNumber({ evidence: { pullRequestNumber: 0 } })).toBeNull();
    expect(readPullRequestNumber({ evidence: { pullRequestNumber: "1" } })).toBeNull();
    expect(readPullRequestNumber({ evidence: null })).toBeNull();
    expect(readPullRequestNumber(null)).toBeNull();
    expect(readPullRequestNumber({ evidence: { pullRequestNumber: 1_000_000_001 } })).toBeNull();
  });
});

describe("labels", () => {
  it("names the author by login while they are a member, 'former member' otherwise", () => {
    expect(memoryAuthorLabel({ kind: "member", memberId: "m-1", login: "alice" })).toBe("alice");
    expect(memoryAuthorLabel({ kind: "former_member" })).toBe(FORMER_MEMBER_LABEL);
    expect(FORMER_MEMBER_LABEL).toBe("former member");
  });

  it("cites the kind and the source PR, never a person", () => {
    const entry = { kind: "decision" as const, evidence: valid().evidence };
    expect(memorySourceLabel(entry)).toBe("decision · PR #847");
    expect(memorySourceLabel({ ...entry, kind: "dismissal" })).toBe("dismissal · PR #847");
  });
});

describe("P8-2: the memory canary is refused at storage like the prompt canary", () => {
  it("refuses the memory canary, or eight of its characters, in text and path", () => {
    const base = {
      kind: "convention",
      text: "Use the shared validator.",
      evidence: {
        path: "src/a.ts",
        sha: "c".repeat(40),
        range: { start: 1, end: 1 },
        pullRequestNumber: 1,
      },
      confidence: 60,
    };
    const prepare = (patch: Record<string, unknown>) =>
      prepareMemoryEntry({ ...base, ...patch }, { origin: "learned" });
    expect(prepare({}).ok).toBe(true);
    expect(prepare({ text: `note ${MEMORY_CANARY.slice(3, 11)}` })).toEqual({
      ok: false,
      problem: "invalid_text",
    });
    expect(
      prepare({ evidence: { ...base.evidence, path: `src/${MEMORY_CANARY.slice(0, 8)}.ts` } }),
    ).toEqual({ ok: false, problem: "invalid_path" });
  });
});
