/**
 * The leak guard (P4-4, ADR 0015 §3): a model answer must not carry Rocky's system prompt into
 * the stored analysis. Every answer that passed its output schema is checked here before its
 * integrity check, in `completeWithRepair`, and the whole document is checked once more before it
 * is returned. A string (or an object key) leaks when it holds:
 *
 * - the canary planted in every system prompt (`PROMPT_CANARY`), however it is spaced, cased or
 *   punctuated; or
 * - a run of `LEAK_NGRAM_WORDS` consecutive words of instruction text that the call's PR content
 *   does not itself contain (a review of a PR that edits Rocky's prompts may quote them).
 *
 * Text is compared after NFKC folding, lower-casing and removal of invisible characters, word by
 * word, so case, spacing, punctuation and compatibility forms do not hide a copy. A paraphrase,
 * a translation or an encoding does; that residual is ADR 0015 R3.
 *
 * A leaking answer gets `path: instruction_leak` issues and goes to the repair round like any
 * other invalid answer; if it still leaks, the unit fails closed.
 */
import { formatPath } from "@rocky-reviews/schema";
import type { LlmUntrustedText } from "../llm.js";
import { FINAL_INSTRUCTION, PROMPT_CANARY, UNTRUSTED_PREAMBLE } from "../prompt.js";
import {
  BRIEFING_INSTRUCTIONS,
  GRAPH_INSTRUCTIONS,
  REPAIR_INSTRUCTIONS,
  REVIEW_INSTRUCTIONS,
  TRIAGE_INSTRUCTIONS,
} from "./instructions.js";

/** Words in a run that counts as a copy. Shorter runs ("for a human code reviewer") are prose. */
export const LEAK_NGRAM_WORDS = 8;
export const INSTRUCTION_LEAK = "instruction_leak";
const MIN_CANARY_CHARS = 6;

/** Everything a model is shown that Rocky wrote. */
export const PROMPT_TEXTS: readonly string[] = Object.freeze([
  UNTRUSTED_PREAMBLE,
  FINAL_INSTRUCTION,
  ...[
    TRIAGE_INSTRUCTIONS,
    REVIEW_INSTRUCTIONS,
    GRAPH_INSTRUCTIONS,
    BRIEFING_INSTRUCTIONS,
    REPAIR_INSTRUCTIONS,
  ].map((instructions) => instructions.text),
]);

const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
const NON_WORD = /[^\p{L}\p{N}]+/u;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

const fold = (text: string): string => text.normalize("NFKC").replace(INVISIBLE, "").toLowerCase();
const words = (text: string): string[] => fold(text).split(NON_WORD).filter(Boolean);
const squash = (text: string): string => fold(text).replace(NON_ALNUM, "");

const ngrams = (list: readonly string[], n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i + n <= list.length; i++) out.push(list.slice(i, i + n).join(" "));
  return out;
};

export interface LeakDetectorOptions {
  /** Instruction texts that must not be copied. */
  readonly texts: readonly string[];
  /** Markers that must never appear, whatever the PR content says. */
  readonly canaries: readonly string[];
  /** Words in a run that counts as a copy (at least 2). */
  readonly ngramWords: number;
}

export interface LeakDetector {
  /**
   * Paths (as `formatPath` writes them; `(root)` for the value itself) of every string or object
   * key in `value` that leaks. `allowed` is the PR content the model was given: a run of
   * instruction words found there is a quote, not a leak. Canaries are never allowed.
   */
  leaks(value: unknown, allowed?: readonly string[]): string[];
}

export const createLeakDetector = (options: LeakDetectorOptions): LeakDetector => {
  const n = options.ngramWords;
  if (!Number.isSafeInteger(n) || n < 2) throw new RangeError("ngramWords must be at least 2");
  const grams = new Set<string>();
  for (const text of options.texts) {
    const list = words(text);
    if (list.length < n) throw new RangeError("every text must be at least ngramWords long");
    for (const gram of ngrams(list, n)) grams.add(gram);
  }
  const canaries = options.canaries.map(squash);
  if (canaries.some((canary) => canary.length < MIN_CANARY_CHARS)) {
    throw new RangeError(`a canary must have at least ${MIN_CANARY_CHARS} letters or digits`);
  }

  const leaksText = (text: string, allowed: () => ReadonlySet<string>): boolean => {
    const squashed = squash(text);
    if (canaries.some((canary) => squashed.includes(canary))) return true;
    const hits = ngrams(words(text), n).filter((gram) => grams.has(gram));
    // The allowed set is built only when needed: most answers share no run with the prompt.
    return hits.length > 0 && hits.some((gram) => !allowed().has(gram));
  };

  return {
    leaks(value, allowedTexts = []) {
      let allowedSet: Set<string> | undefined;
      const allowed = (): ReadonlySet<string> =>
        (allowedSet ??= new Set(allowedTexts.flatMap((text) => ngrams(words(text), n))));
      const found: string[] = [];
      const walk = (node: unknown, path: PropertyKey[]): void => {
        if (typeof node === "string") {
          if (leaksText(node, allowed)) found.push(formatPath(path) || "(root)");
          return;
        }
        if (Array.isArray(node)) {
          node.forEach((item, index) => walk(item, [...path, index]));
          return;
        }
        if (node !== null && typeof node === "object") {
          for (const [key, item] of Object.entries(node)) {
            // A leak in a key is reported at the object that holds it.
            if (leaksText(key, allowed)) found.push(formatPath(path) || "(root)");
            walk(item, [...path, key]);
          }
        }
      };
      walk(value, []);
      return [...new Set(found)];
    },
  };
};

const PROMPT_LEAKS = createLeakDetector({
  texts: PROMPT_TEXTS,
  canaries: [PROMPT_CANARY],
  ngramWords: LEAK_NGRAM_WORDS,
});

/**
 * `path: instruction_leak` lines for a model answer. `untrusted` must be the call's own content
 * (PR text and earlier validated answers), never a repair round's issue list: that list is built
 * from the answer itself, and must not be able to allow what the answer copied.
 */
export const instructionLeaks = (
  value: unknown,
  untrusted: readonly LlmUntrustedText[],
): string[] =>
  PROMPT_LEAKS.leaks(
    value,
    untrusted.map((part) => part.text),
  ).map((path) => `${path}: ${INSTRUCTION_LEAK}`);
