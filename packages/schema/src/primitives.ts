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
// Text the UI shows must not be able to hide, reorder or spoof anything:
// - Cc: C0 and C1 control characters and DEL (only \t and \n are ever allowed, by field kind).
// - Bidi controls (Trojan Source): U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069.
// - Invisible characters that hide content: zero-width space U+200B, word joiner U+2060,
//   BOM U+FEFF, U+180E. (ZWNJ/ZWJ U+200C/U+200D stay allowed in prose: scripts and emoji
//   need them; code lines, ids and paths reject every Cf.)
// - Line/paragraph separators U+2028/U+2029 in single-line fields.
// - Lone surrogates: not representable in UTF-8, so never valid text.

const BIDI_OR_HIDING =
  "\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\u200B\\u2060\\uFEFF\\u180E";
/** Prose: any Cc other than \t and \n, or a bidi/hiding character. */
const FORBIDDEN_IN_PROSE = new RegExp(`[^\\P{Cc}\\t\\n]|[${BIDI_OR_HIDING}]`, "u");
/** Single-line text: any Cc, bidi/hiding, or a line/paragraph separator. */
const FORBIDDEN_IN_LINE = new RegExp(`\\p{Cc}|[${BIDI_OR_HIDING}]|\\p{Zl}|\\p{Zp}`, "u");
/** Code lines: any Cc other than \t, any format character, any line/paragraph separator. */
const FORBIDDEN_IN_CODE = /[^\P{Cc}\t]|\p{Cf}|\p{Zl}|\p{Zp}/u;
/** Paths and ids: no control, format or line/paragraph separator characters at all. */
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const malformed = (text: string): boolean => !text.isWellFormed();

export const hasForbiddenProseCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_PROSE.test(text);
export const hasForbiddenLineCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_LINE.test(text);
export const hasForbiddenCodeCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_CODE.test(text);
export const hasForbiddenNameCharacters = (text: string): boolean =>
  malformed(text) || FORBIDDEN_IN_NAME.test(text);

/** Single-line text: no control, bidi, hiding or line-separator characters, not even \t or \n. */
export const line = (max: number, description?: string) => {
  const schema = z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasForbiddenLineCharacters(text), {
      message: "must not contain control, bidi, invisible or line-separator characters",
    });
  return description === undefined ? schema : schema.describe(description);
};

/** Multi-line text: \n and \t are allowed, every other control, bidi or hiding character is not. */
export const prose = (max: number, description?: string) => {
  const schema = z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasForbiddenProseCharacters(text), {
      message:
        "must not contain control characters other than newline and tab, or bidi/invisible characters",
    });
  return description === undefined ? schema : schema.describe(description);
};

/**
 * A line of code, as it would appear in a file: may be empty, may contain tabs, never a
 * newline (lines are already split), a control character or any format character (Trojan
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

/** Dots and every look-alike NFKC leaves alone; NFKC folds the fullwidth and compat forms itself. */
const DOT_LIKE_SEGMENT = /^(?:[.。·‧・｡]|%2e)+$/iu;
const WHITESPACE_SEGMENT = /^[\s\p{Z}]+$/u;

/**
 * Why a path is not acceptable, or undefined when it is. Beyond the structural pattern:
 * - no control, format (bidi, zero-width, BOM) or line-separator characters anywhere;
 * - NFC-normalised, so two spellings of one name cannot both pass as different files;
 * - no segment that is only dots, dot look-alikes (`．．`, `‥`, `…`) or percent-encoded dots
 *   (`%2e%2e`), or only whitespace, or `.git`.
 */
export const pathProblem = (path: string): string | undefined => {
  if (hasForbiddenNameCharacters(path))
    return "must not contain control, bidi, invisible or line-separator characters";
  if (path.normalize("NFC") !== path) return "must be NFC-normalised";
  if (!REPOSITORY_PATH_PATTERN.test(path))
    return "must be a repository-relative POSIX path: no leading '/', drive letter, backslash, '.' or '..' segment";
  for (const segment of path.split("/")) {
    const folded = segment.normalize("NFKC");
    if (DOT_LIKE_SEGMENT.test(folded)) return `segment '${segment}' spells a dot segment`;
    if (WHITESPACE_SEGMENT.test(folded)) return "segments must not be only whitespace";
    if (folded.toLowerCase() === ".git") return "must not point into .git";
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
