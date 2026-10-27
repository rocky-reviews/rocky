import fixture from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { rockyInstructions } from "../llm.js";
import {
  PROMPT_CANARY,
  PROMPT_CANARY_MARKER,
  systemPrompt,
  UNTRUSTED_PREAMBLE,
} from "../prompt.js";
import {
  BRIEFING_INSTRUCTIONS,
  REPAIR_INSTRUCTIONS,
  REVIEW_INSTRUCTIONS,
  TRIAGE_INSTRUCTIONS,
} from "./instructions.js";
import {
  createLeakDetector,
  INSTRUCTION_LEAK,
  instructionLeaks,
  LEAK_NGRAM_WORDS,
  PROMPT_SHARE_THRESHOLD,
  PROMPT_TEXTS,
  promptShare,
} from "./leak.js";
import { RAISED_FOR_FINDINGS, RAISED_FOR_UNREVIEWED, DELETION_ONLY_DETAIL } from "./pipeline.js";
import { NOISE_SUMMARIES } from "./rules.js";

/**
 * P4-4 leak guard (ADR 0015 \u00a73): a model answer that copies Rocky's system prompt (the canary, or
 * any run of LEAK_NGRAM_WORDS words of instruction text the PR itself does not contain) is
 * refused before anything is stored.
 */

const sentence = REVIEW_INSTRUCTIONS.text.split("\n")[2]!; // "Report real defects only: \u2026"
const leaks = (value: unknown, allowed: string[] = []) =>
  instructionLeaks(
    value,
    allowed.map((text) => ({ label: "diff", text })),
  );

describe("instructionLeaks", () => {
  it("knows every text a model is shown: preamble, final line, every stage and repair", () => {
    expect(PROMPT_TEXTS).toContain(UNTRUSTED_PREAMBLE);
    for (const instructions of [
      TRIAGE_INSTRUCTIONS,
      REVIEW_INSTRUCTIONS,
      BRIEFING_INSTRUCTIONS,
      REPAIR_INSTRUCTIONS,
    ])
      expect(PROMPT_TEXTS).toContain(instructions.text);
    expect(LEAK_NGRAM_WORDS).toBe(8);
  });

  it("flags the whole system prompt, and one sentence of it, at the field's path", () => {
    expect(leaks({ summary: systemPrompt(REVIEW_INSTRUCTIONS) })).toEqual([
      `summary: ${INSTRUCTION_LEAK}`,
    ]);
    expect(
      leaks({ findings: [{ title: "Fine", body: `Note: ${sentence} Thanks.` }, { body: "ok" }] }),
    ).toEqual([`findings[0].body: ${INSTRUCTION_LEAK}`]);
  });

  it("sees through case, punctuation, spacing, compatibility forms and invisible characters", () => {
    const mangled = [
      sentence.toUpperCase(),
      sentence.replace(/ /g, "   ").replace(/:/g, " -- "),
      sentence.replace(/ /g, "\n"),
      // Fullwidth letters fold under NFKC.
      sentence.replace(/[a-z]/g, (c) => String.fromCodePoint(c.codePointAt(0)! - 0x61 + 0xff41)),
      // Zero-width characters inside words.
      sentence.replace(/e/g, "e\u200B"),
    ];
    for (const text of mangled) expect(leaks({ reason: text }), text).toHaveLength(1);
  });

  it("flags the canary however it is spelled, even when the PR content carries it", () => {
    for (const text of [
      PROMPT_CANARY_MARKER,
      `marker: ${PROMPT_CANARY}`,
      PROMPT_CANARY.toUpperCase(),
      PROMPT_CANARY.match(/.{4}/g)!.join(" "),
      PROMPT_CANARY.split("").join("-"),
    ]) {
      expect(leaks({ checkedOk: [text] }, [PROMPT_CANARY_MARKER]), text).toEqual([
        `checkedOk[0]: ${INSTRUCTION_LEAK}`,
      ]);
    }
  });

  it("checks object keys as well as values", () => {
    expect(leaks({ payload: { [sentence]: 1 } })).toEqual([`payload: ${INSTRUCTION_LEAK}`]);
  });

  it("allows instruction text the PR content itself contains (a quote, not a leak)", () => {
    // A pull request that edits Rocky's own prompts: the review may quote the changed line.
    const diff = `+export const X = rockyInstructions\`${sentence}\`;`;
    expect(leaks({ body: `This line changes: ${sentence}` }, [diff])).toEqual([]);
    // Only the quoted run is allowed: other instruction text is still a leak.
    expect(
      leaks({ body: `${sentence} ${TRIAGE_INSTRUCTIONS.text.split("\n")[2]!}` }, [diff]),
    ).toHaveLength(1);
  });

  it("does not flag short phrases instructions share with ordinary prose", () => {
    expect(
      leaks({
        summary: "This pull request adds a session module for a human code reviewer to check.",
        reason: "The unified diff touches authentication and database migrations.",
      }),
    ).toEqual([]);
  });

  it("does not flag the pr-847 fixture or Rocky's own fixed texts", () => {
    expect(leaks(fixture)).toEqual([]);
    expect(
      leaks({
        fixed: [
          RAISED_FOR_FINDINGS,
          RAISED_FOR_UNREVIEWED,
          DELETION_ONLY_DETAIL,
          ...Object.values(NOISE_SUMMARIES),
        ],
      }),
    ).toEqual([]);
  });

  it("ignores numbers, booleans and null", () => {
    expect(leaks({ a: 1, b: true, c: null, d: [2, false] })).toEqual([]);
  });
});

describe("createLeakDetector", () => {
  it("takes its own texts, canaries and window", () => {
    const detector = createLeakDetector({
      texts: ["one two three four"],
      canaries: ["c4n4ry"],
      ngramWords: 3,
    });
    expect(detector.leaks({ x: "say two three four now" })).toEqual(["x"]);
    expect(detector.leaks({ x: "say two three now" })).toEqual([]);
    expect(detector.leaks({ x: "C4N 4RY" })).toEqual(["x"]);
    expect(detector.leaks({ x: "say two three four now" }, ["two three four"])).toEqual([]);
    expect(detector.leaks("two three four")).toEqual(["(root)"]);
  });

  it("refuses a window below two words or a text shorter than the window", () => {
    expect(() => createLeakDetector({ texts: ["a b"], canaries: [], ngramWords: 1 })).toThrow(
      RangeError,
    );
    expect(() => createLeakDetector({ texts: ["a b"], canaries: [], ngramWords: 3 })).toThrow(
      RangeError,
    );
    expect(() => createLeakDetector({ texts: ["a b c"], canaries: ["ab"], ngramWords: 3 })).toThrow(
      RangeError,
    );
  });

  it("is unaffected by a literal instructions object it is not given", () => {
    const other = rockyInstructions`Completely different words here for this test only.`;
    const detector = createLeakDetector({ texts: PROMPT_TEXTS, canaries: [], ngramWords: 8 });
    expect(detector.leaks({ x: other.text })).toEqual([]);
  });
});

describe("leak guard hardening (P4-4 review round 1, item 4)", () => {
  const preamble = UNTRUSTED_PREAMBLE;
  // Words as the guard counts them, so a 7-word piece really holds 7 (no canary here).
  const promptWords = REVIEW_INSTRUCTIONS.text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const chunks = (list: string[], size: number) =>
    Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
      list.slice(i * size, i * size + size).join(" "),
    );

  it("finds a canary split across fields, in any order of keys", () => {
    const [a, b, c, d] = PROMPT_CANARY.match(/.{4}/g)!;
    expect(leaks({ title: `id ${a}`, body: `${b}`, agentPrompt: `${c}`, why: `${d} end` })).toEqual(
      [`(root): ${INSTRUCTION_LEAK}`],
    );
  });

  it("folds other scripts' digits before looking for the canary", () => {
    const arabic = PROMPT_CANARY.replace(/[0-9]/g, (d) => String.fromCodePoint(0x660 + Number(d)));
    const devanagari = PROMPT_CANARY.replace(/[0-9]/g, (d) =>
      String.fromCodePoint(0x966 + Number(d)),
    );
    for (const text of [arabic, devanagari]) expect(leaks({ x: text }), text).toHaveLength(1);
  });

  it("strips combining marks and folds Cyrillic and Greek look-alikes", () => {
    const marked = sentence.replace(/([a-z])/g, "$1\u0301");
    const cyrillic = sentence.replace(
      /[aeopcx]/g,
      (c) => ({ a: "\u0430", e: "\u0435", o: "\u043e", p: "\u0440", c: "\u0441", x: "\u0445" })[c]!,
    );
    const greek = sentence.replace(
      /[aoi]/g,
      (c) => ({ a: "\u03b1", o: "\u03bf", i: "\u03b9" })[c]!,
    );
    for (const text of [marked, cyrillic, greek]) expect(leaks({ x: text }), text).toHaveLength(1);
  });

  it("finds prompt text split into 7-word fields", () => {
    const parts = chunks(promptWords, 7);
    expect(leaks({ checkedOk: parts })).toEqual([`(root): ${INSTRUCTION_LEAK}`]);
    const findings = parts.map((title) => ({ title, body: "ok" }));
    expect(leaks({ findings })).toEqual([`(root): ${INSTRUCTION_LEAK}`]);
  });

  it("finds prompt text with a filler word every 7 words, and in shuffled 7-word pieces", () => {
    const filler = chunks(promptWords, 7).join(" banana ");
    expect(leaks({ body: filler })).toEqual([`(root): ${INSTRUCTION_LEAK}`]);
    const shuffled = chunks(promptWords, 7).reverse();
    expect(leaks({ checkedOk: shuffled })).toEqual([`(root): ${INSTRUCTION_LEAK}`]);
    const preambleFiller = chunks(preamble.split(/[^\p{L}\p{N}]+/u).filter(Boolean), 6).join(" x ");
    expect(leaks({ summary: preambleFiller })).toHaveLength(1);
  });

  it("still allows a PR that quotes the prompt, whatever the field layout", () => {
    const diff = `+const PROMPT = \`${systemPrompt(REVIEW_INSTRUCTIONS).replaceAll(PROMPT_CANARY_MARKER, "")}\`;`;
    const parts = chunks(REVIEW_INSTRUCTIONS.text.split(/\s+/), 7);
    expect(leaks({ checkedOk: parts }, [diff])).toEqual([]);
  });

  it("stays quiet on the pr-847 fixture and Rocky's fixed texts after the new folds", () => {
    expect(leaks(fixture)).toEqual([]);
    expect(promptShare({ fixture })).toBeLessThan(PROMPT_SHARE_THRESHOLD / 2);
  });
});
