/**
 * Shared field types. Everything a model writes passes through one of these, so the rules
 * about control characters, invisible characters, path shapes and identifiers live here and
 * nowhere else.
 *
 * Parts adapted from PR Lens (https://github.com/coldteadotai/pr-lens), MIT License,
 * Copyright (c) 2026 Coldtea AI. See NOTICE.
 */
import { z } from "zod";
import {
  MAX_CONFIDENCE,
  MAX_ID_LENGTH,
  MAX_LINE_NUMBER,
  MAX_PATH_LENGTH,
  MAX_RANGE_LINES,
  MAX_SCORE,
  MIN_CONFIDENCE,
  MIN_SCORE,
} from "./limits.js";

// --- Character rules ---------------------------------------------------------------------------
//
// Text the UI shows must not be able to hide, reorder or spoof anything. The rules are built
// from Unicode properties, not hand lists, so new code points are covered:
// - Cc: C0 and C1 control characters and DEL. Only \t and \n are ever allowed, by field kind.
// - Default_Ignorable_Code_Point (DI): everything a renderer may draw as nothing — soft hyphen,
//   zero-width and bidi controls, word joiners, Hangul fillers, variation selectors, the TAG
//   block U+E0000–E007F used for ASCII smuggling, and more. Three exceptions in ordinary text:
//   ZWNJ U+200C and ZWJ U+200D (scripts and emoji need them) and VS16 U+FE0F (emoji).
// - Cf: format characters not in DI (interlinear annotation U+FFF9–FFFB, bidi marks).
// - Blank-looking letters that DI misses: braille blank U+2800 (U+3164, U+115F, U+1160 and
//   U+FFA0 are DI already).
// - Zl/Zp line and paragraph separators in single-line fields.
// - Zalgo: five or more consecutive combining marks in single-line fields, paths and ids.
// - Lone surrogates: not representable in UTF-8, so never valid text.

// Alternation, not a class: ESLint reads a class holding ZWJ and VS16 as one joined character.
const EMOJI_JOINERS = "\\u200C|\\u200D|\\uFE0F";
// As an alternation, not a class: a class holding U+115F U+1160 reads as one Hangul syllable.
const BLANK_LETTERS = "\\u2800|\\u3164|\\u115F|\\u1160|\\uFFA0";
/** Any DI or Cf other than the emoji joiners, or a blank-looking letter. */
const INVISIBLE = `(?!${EMOJI_JOINERS})(?:\\p{Default_Ignorable_Code_Point}|\\p{Cf})|${BLANK_LETTERS}`;
/** Every DI or Cf, no exceptions. */
const INVISIBLE_STRICT = `\\p{Default_Ignorable_Code_Point}|\\p{Cf}|${BLANK_LETTERS}`;
const ZALGO = "\\p{M}{5}";
const LINE_BREAKS = "\\p{Zl}|\\p{Zp}";

/** Prose: any Cc other than \t and \n, or an invisible character. */
const FORBIDDEN_IN_PROSE = new RegExp(`(?!\\t|\\n)\\p{Cc}|${INVISIBLE}`, "u");
/** Strict prose (agent prompts): like prose, but no joiner exceptions and no line separators. */
const FORBIDDEN_IN_STRICT_PROSE = new RegExp(
  `(?!\\t|\\n)\\p{Cc}|${INVISIBLE_STRICT}|${LINE_BREAKS}`,
  "u",
);
/** Single-line text: any Cc, invisible, line separator, or a zalgo run. */
const FORBIDDEN_IN_LINE = new RegExp(`\\p{Cc}|${INVISIBLE}|${LINE_BREAKS}|${ZALGO}`, "u");
/** Code lines: any Cc other than \t, every invisible (no joiner exceptions), line separators. */
const FORBIDDEN_IN_CODE = new RegExp(`(?!\\t)\\p{Cc}|${INVISIBLE_STRICT}|${LINE_BREAKS}`, "u");
/** Paths and ids: no Cc, no invisible at all, no line separators, no zalgo. */
const FORBIDDEN_IN_NAME = new RegExp(`\\p{Cc}|${INVISIBLE_STRICT}|${LINE_BREAKS}|${ZALGO}`, "u");

const malformed = (text: string): boolean => !text.isWellFormed();

export const hasForbiddenProseCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_PROSE.test(text);
export const hasForbiddenStrictProseCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_STRICT_PROSE.test(text);
export const hasForbiddenLineCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_LINE.test(text);
export const hasForbiddenCodeCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_CODE.test(text);
export const hasForbiddenNameCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_NAME.test(text);

/** Single-line text: no control, invisible or line-separator characters, not even \t or \n. */
export const line = (max: number, description?: string) => {
  const schema = z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasForbiddenLineCharacters(text), {
      message:
        "must not contain control, invisible or line-separator characters, or runs of combining marks",
    });
  return description === undefined ? schema : schema.describe(description);
};

/** Multi-line text: \n and \t are allowed, every other control or invisible character is not. */
export const prose = (max: number, description?: string) => {
  const schema = z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasForbiddenProseCharacters(text), {
      message:
        "must not contain control characters other than newline and tab, or invisible characters",
    });
  return description === undefined ? schema : schema.describe(description);
};

/**
 * Text handed to another machine (the agent prompt): the strictest rule, because a reviewer
 * who sees "Fix it. ok" must be sure the coding agent sees the same. No invisible character of
 * any kind, not even the emoji joiners.
 */
export const strictProse = (max: number, description?: string) => {
  const schema = z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasForbiddenStrictProseCharacters(text), {
      message: "must not contain any control, invisible or line-separator character",
    });
  return description === undefined ? schema : schema.describe(description);
};

/**
 * A line of code, as it would appear in a file: may be empty, may contain tabs, never a
 * newline (lines are already split), a control character or any invisible character (Trojan
 * Source hides in those).
 */
export const codeLine = (max: number, description?: string) => {
  const schema = z
    .string()
    .max(max)
    .refine((text) => !hasForbiddenCodeCharacters(text), {
      message: "must be a single line without control or invisible characters other than tab",
    });
  return description === undefined ? schema : schema.describe(description);
};

/** Non-negative integer that is not -0 (JSON would re-serialise it as 0, breaking canonical form). */
export const count = (max: number) =>
  z
    .int()
    .min(0)
    .max(max)
    .refine((value) => !Object.is(value, -0), { message: "must not be -0" });

/**
 * Identifiers are model-authored, so they are constrained to a shape that survives an SVG id,
 * a URL fragment and a GitHub comment anchor without escaping. Uniqueness within a collection
 * is checked by the integrity pass (DUPLICATE_ID), case-insensitively, because anchors are
 * often compared that way.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const Id = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(ID_PATTERN, "must start alphanumeric and contain only letters, digits and . _ : / -")
  .describe("Stable identifier, unique within its collection in a document.");
export type Id = z.infer<typeof Id>;

/**
 * Repository-relative POSIX path, structural part: no leading slash, no drive letter, no
 * backslash, no empty, `.` or `..` segment, no trailing slash, no ASCII control characters.
 * This is what the JSON Schema can carry; `pathProblem` below adds the Unicode rules.
 */
const PATH_SEGMENT = "(?!\\.\\.?(?:/|$))[^/\\\\\\u0000-\\u001F\\u007F]+";
export const REPOSITORY_PATH_PATTERN = new RegExp(
  `^(?![A-Za-z]:)${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`,
);

/** `%2e`, `%252e`, `%25252e`…: a dot however many times it was percent-encoded. */
const ENCODED_DOT = /%(?:25)*2e/giu;
/** After NFKC and with marks stripped: nothing but punctuation (every dot look-alike is Po). */
const PUNCTUATION_ONLY = /^\p{Po}+$/u;
const WHITESPACE_ONLY = /^[\s\p{Z}]+$/u;
/** `.git`, `.git.`, `.git ` (Windows trailing-dot/space forms), `git~1` (8.3 short name). */
const GIT_DIR = /^(?:\.git[. ]*|git~\d+)$/iu;

/**
 * Why a path is not acceptable, or undefined when it is. Beyond the structural pattern:
 * - no control, invisible or line-separator characters anywhere, no zalgo runs;
 * - no segment that, after NFKC folding, mark stripping and percent-decoding of dots, is
 *   only punctuation (`．．`, `‥`, `…`, `۔۔`, `%2e%2e`, `%252e`, `.̸`), only whitespace, or a
 *   spelling of the `.git` directory (`.git`, `.GIT.`, `git~1`).
 *
 * Normalisation form is deliberately not required: paths in the facts are what git reports,
 * and macOS repositories legitimately carry NFD names. The integrity pass rejects a file list
 * with two paths equal under NFC, and every model-written path must equal a listed path.
 */
export const pathProblem = (path: string): string | undefined => {
  if (hasForbiddenNameCharacters(path))
    return "must not contain control, invisible or line-separator characters, or runs of combining marks";
  if (!REPOSITORY_PATH_PATTERN.test(path))
    return "must be a repository-relative POSIX path: no leading '/', drive letter, backslash, '.' or '..' segment";
  for (const segment of path.split("/")) {
    const folded = segment.normalize("NFKC").replace(/\p{M}/gu, "").replace(ENCODED_DOT, ".");
    if (folded.length === 0 || PUNCTUATION_ONLY.test(folded))
      return `segment '${segment}' spells a dot segment or is only punctuation`;
    if (WHITESPACE_ONLY.test(folded)) return "segments must not be only whitespace";
    if (GIT_DIR.test(folded)) return "must not point into .git";
  }
  return undefined;
};

export const RepositoryPath = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .regex(REPOSITORY_PATH_PATTERN, "must be a repository-relative POSIX path")
  .superRefine((path, context) => {
    const problem = pathProblem(path);
    if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
  })
  .describe("Repository-relative path with POSIX separators.");
export type RepositoryPath = z.infer<typeof RepositoryPath>;

/** Git facts are always recorded in full; abbreviations can collide as a repository grows. */
export const FullSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase hex git object name")
  .describe("Git commit sha, in full.");
export type FullSha = z.infer<typeof FullSha>;

export const LineNumber = z.int().min(1).max(MAX_LINE_NUMBER).describe("1-based line number.");

/**
 * An inclusive range of new-side (head revision) line numbers. Every line reference in the
 * document is on the new side: findings and flags are things to look at in the code as it
 * will be after the merge.
 */
export const LineRange = z
  .strictObject({
    start: LineNumber.describe("First line, 1-based, inclusive."),
    end: LineNumber.describe("Last line, 1-based, inclusive."),
  })
  .refine((range) => range.end >= range.start, {
    message: "end must be greater than or equal to start",
    path: ["end"],
  })
  .refine((range) => range.end - range.start + 1 <= MAX_RANGE_LINES, {
    message: `must cover at most ${MAX_RANGE_LINES} lines`,
    path: ["end"],
  })
  .describe("Inclusive range of new-side line numbers.");
export type LineRange = z.infer<typeof LineRange>;

/**
 * A pointer into the repository, used by the graph. The path is only checked for shape:
 * graph nodes legitimately point at files the PR does not touch (the "unchanged" context).
 */
export const FileRef = z
  .strictObject({
    path: RepositoryPath,
    range: LineRange.optional().describe("Lines backing the element, when known."),
  })
  .describe("A file (and optional line range) backing a graph element.");
export type FileRef = z.infer<typeof FileRef>;

export const Score = count(MAX_SCORE)
  .refine((value) => value >= MIN_SCORE)
  .describe("Triage score: how much of the reviewer's attention this file deserves.");

export const Confidence = count(MAX_CONFIDENCE)
  .refine((value) => value >= MIN_CONFIDENCE)
  .describe("How sure the model is, in percent.");

/**
 * How an element relates to the base branch. `unchanged` elements are the context a reader
 * needs to judge blast radius, so they are first-class rather than omitted.
 */
export const Delta = z
  .enum(["added", "modified", "removed", "unchanged"])
  .describe("Change state relative to the base commit.");
export type Delta = z.infer<typeof Delta>;
