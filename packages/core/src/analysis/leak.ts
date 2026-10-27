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
const MARKS = /\p{M}/gu;
const DIGIT = /\p{Nd}/u;
const DIGITS = /\p{Nd}/gu;
const NON_WORD = /[^\p{L}\p{N}]+/u;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

/**
 * Common Cyrillic and Greek look-alikes of Latin letters (lower case; text is lower-cased
 * first). Not Unicode's full confusables table: enough that swapping a few letters does not hide
 * a copy. Review round 1, item 4.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "i",
  "\u0458": "j",
  "\u0455": "s",
  "\u0501": "d",
  "\u051b": "q",
  "\u051d": "w",
  "\u04bb": "h",
  "\u043a": "k",
  "\u043c": "m",
  "\u04cf": "l",
  "\u0432": "b",
  "\u03b1": "a",
  "\u03b2": "b",
  "\u03b5": "e",
  "\u03b6": "z",
  "\u03b7": "n",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bd": "v",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u03c9": "w",
};
const CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/**
 * A decimal digit of any script as its ASCII digit. Unicode encodes each script's digits as a run
 * of ten consecutive code points, 0 to 9, so the value is the distance from the run's start.
 */
const asciiDigit = (digit: string): string => {
  const cp = digit.codePointAt(0) ?? 0;
  let below = 0;
  while (below < 40 && DIGIT.test(String.fromCodePoint(cp - below - 1))) below++;
  return String(below % 10);
};

/**
 * The text as compared: compatibility forms decomposed (NFKD), combining marks and invisible
 * characters removed, lower case, every script's digits as ASCII, look-alikes folded to Latin.
 */
export const foldForLeaks = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(MARKS, "")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(DIGITS, (digit) => (digit >= "0" && digit <= "9" ? digit : asciiDigit(digit)))
    .replace(CONFUSABLE, (letter) => CONFUSABLES[letter] ?? letter);
const words = (text: string): string[] => foldForLeaks(text).split(NON_WORD).filter(Boolean);
const squash = (text: string): string => foldForLeaks(text).replace(NON_ALNUM, "");

const ngrams = (list: readonly string[], n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i + n <= list.length; i++) out.push(list.slice(i, i + n).join(" "));
  return out;
};

/**
 * Share check (review round 1, item 4): the part of a prompt text's word trigrams present in an
 * answer's text (all fields together, PR content excluded). Filler words and field splitting
 * break 8-word runs but keep most trigrams; ordinary prose shares a few trigrams with the
 * prompts ("of the diff") and stays far below this. Only prompt texts of at least
 * `MIN_SHARE_TRIGRAMS` trigrams are measured; shorter ones are covered by the 8-word runs.
 */
export const PROMPT_SHARE_THRESHOLD = 0.3;
const SHARE_WORDS = 3;
const MIN_SHARE_TRIGRAMS = 40;

export interface LeakDetectorOptions {
  /** Instruction texts that must not be copied. */
  readonly texts: readonly string[];
  /** Markers that must never appear, whatever the PR content says. */
  readonly canaries: readonly string[];
  /** Words in a run that counts as a copy (at least 2). */
  readonly ngramWords: number;
  /** Share of a long text's trigrams that counts as a copy; omitted: no share check. */
  readonly shareThreshold?: number;
}

export interface LeakDetector {
  /**
   * Paths (as `formatPath` writes them; `(root)` for the value itself) of every string or object
   * key in `value` that leaks. `allowed` is the PR content the model was given: a run of
   * instruction words found there is a quote, not a leak. Canaries are never allowed.
   *
   * All of the value's strings are also checked joined together, in walk order: a leak spread
   * over several fields (a split canary, 7-word pieces, filler words) is reported at `(root)`.
   */
  leaks(value: unknown, allowed?: readonly string[]): string[];
  /** The highest share of any long prompt text's trigrams in `value` (see the share check). */
  share(value: unknown, allowed?: readonly string[]): number;
}

interface Part {
  readonly path: PropertyKey[];
  readonly text: string;
  readonly key: boolean;
}

const strings = (value: unknown): Part[] => {
  const out: Part[] = [];
  const walk = (node: unknown, path: PropertyKey[]): void => {
    if (typeof node === "string") {
      out.push({ path, text: node, key: false });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]));
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        // A leak in a key is reported at the object that holds it.
        out.push({ path, text: key, key: true });
        walk(item, [...path, key]);
      }
    }
  };
  walk(value, []);
  return out;
};

export const createLeakDetector = (options: LeakDetectorOptions): LeakDetector => {
  const n = options.ngramWords;
  if (!Number.isSafeInteger(n) || n < 2) throw new RangeError("ngramWords must be at least 2");
  const grams = new Set<string>();
  const long: ReadonlySet<string>[] = [];
  for (const text of options.texts) {
    const list = words(text);
    if (list.length < n) throw new RangeError("every text must be at least ngramWords long");
    for (const gram of ngrams(list, n)) grams.add(gram);
    const trigrams = new Set(ngrams(list, SHARE_WORDS));
    if (trigrams.size >= MIN_SHARE_TRIGRAMS) long.push(trigrams);
  }
  const canaries = options.canaries.map(squash);
  if (canaries.some((canary) => canary.length < MIN_CANARY_CHARS)) {
    throw new RangeError(`a canary must have at least ${MIN_CANARY_CHARS} letters or digits`);
  }

  const allowance = (texts: readonly string[]) => {
    let runs: Set<string> | undefined;
    let tri: Set<string> | undefined;
    return {
      runs: (): ReadonlySet<string> =>
        (runs ??= new Set(texts.flatMap((text) => ngrams(words(text), n)))),
      trigrams: (): ReadonlySet<string> =>
        (tri ??= new Set(texts.flatMap((text) => ngrams(words(text), SHARE_WORDS)))),
    };
  };

  const leaksText = (text: string, allowed: () => ReadonlySet<string>): boolean => {
    const squashed = squash(text);
    if (canaries.some((canary) => squashed.includes(canary))) return true;
    const hits = ngrams(words(text), n).filter((gram) => grams.has(gram));
    // The allowed set is built only when needed: most answers share no run with the prompt.
    return hits.length > 0 && hits.some((gram) => !allowed().has(gram));
  };

  const shareOf = (joined: string, allowed: () => ReadonlySet<string>): number => {
    if (long.length === 0) return 0;
    const present = new Set(ngrams(words(joined), SHARE_WORDS));
    let best = 0;
    for (const trigrams of long) {
      let hits = 0;
      for (const gram of trigrams) if (present.has(gram) && !allowed().has(gram)) hits++;
      best = Math.max(best, hits / trigrams.size);
    }
    return best;
  };

  return {
    leaks(value, allowedTexts = []) {
      const allow = allowance(allowedTexts);
      const parts = strings(value);
      const found = new Set<string>();
      for (const part of parts)
        if (leaksText(part.text, allow.runs)) found.add(formatPath(part.path) || "(root)");
      if (found.size === 0) {
        // Values only: field names between the pieces would otherwise hide a split copy.
        const joined = parts
          .filter((part) => !part.key)
          .map((part) => part.text)
          .join(" ");
        if (
          leaksText(joined, allow.runs) ||
          (options.shareThreshold !== undefined &&
            shareOf(joined, allow.trigrams) >= options.shareThreshold)
        )
          found.add("(root)");
      }
      return [...found];
    },
    share(value, allowedTexts = []) {
      const joined = strings(value)
        .filter((part) => !part.key)
        .map((part) => part.text)
        .join(" ");
      return shareOf(joined, allowance(allowedTexts).trigrams);
    },
  };
};

const PROMPT_LEAKS = createLeakDetector({
  texts: PROMPT_TEXTS,
  canaries: [PROMPT_CANARY],
  ngramWords: LEAK_NGRAM_WORDS,
  shareThreshold: PROMPT_SHARE_THRESHOLD,
});

/** The highest share of a prompt text's trigrams in `value` (for tests and evals). */
export const promptShare = (value: unknown, allowed: readonly string[] = []): number =>
  PROMPT_LEAKS.share(value, allowed);

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
