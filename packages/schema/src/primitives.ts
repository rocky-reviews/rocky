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
//   block U+E0000–E007F used for ASCII smuggling, and more.
// - Cf: format characters not in DI (interlinear annotation U+FFF9–FFFB, bidi marks).
// - Blank-looking letters that DI misses: braille blank U+2800.
// - Zl/Zp line and paragraph separators in single-line fields.
// - Lone surrogates: not representable in UTF-8, so never valid text.
//
// Ordinary prose and single-line text keep four DI characters that real text needs, under
// placement rules so they cannot carry hidden bits: ZWNJ U+200C and ZWJ U+200D only between a
// preceding visible character (or mark) and a following visible non-mark character, never two
// in a row; VS15 U+FE0E and VS16 U+FE0F only directly after an emoji or symbol; and in total at
// most MAX_JOINERS of them and at most one per two visible characters (an emoji family needs
// two joiners for three emoji). Agent prompts, code lines, paths and ids allow none of them.
//
// Zalgo: runs of combining marks are capped (6 in single-line text, paths and ids — a Hebrew
// letter can carry five marks — and 8 in prose), counted across interleaved joiners.

// Alternations, not classes: ESLint reads a class holding ZWJ+VS16 or U+115F U+1160 as one
// joined character.
const JOINERS = "\\u200C|\\u200D|\\uFE0E|\\uFE0F";
const BLANK_LETTERS = "\\u2800|\\u3164|\\u115F|\\u1160|\\uFFA0";
/** Any DI or Cf other than the four placed joiners, or a blank-looking letter. */
const INVISIBLE = `(?!${JOINERS})(?:\\p{Default_Ignorable_Code_Point}|\\p{Cf})|${BLANK_LETTERS}`;
/** Every DI or Cf, no exceptions. */
const INVISIBLE_STRICT = `\\p{Default_Ignorable_Code_Point}|\\p{Cf}|${BLANK_LETTERS}`;
const LINE_BREAKS = "\\p{Zl}|\\p{Zp}";

export type TextKind = "prose" | "strict" | "line" | "code" | "name";

const FORBIDDEN: Record<TextKind, RegExp> = {
  prose: new RegExp(`(?!\\t|\\n)\\p{Cc}|${INVISIBLE}`, "u"),
  strict: new RegExp(`(?!\\t|\\n)\\p{Cc}|${INVISIBLE_STRICT}|${LINE_BREAKS}`, "u"),
  line: new RegExp(`\\p{Cc}|${INVISIBLE}|${LINE_BREAKS}`, "u"),
  code: new RegExp(`(?!\\t)\\p{Cc}|${INVISIBLE_STRICT}|${LINE_BREAKS}`, "u"),
  name: new RegExp(`\\p{Cc}|${INVISIBLE_STRICT}|${LINE_BREAKS}`, "u"),
};
const FORBIDDEN_MESSAGE: Record<TextKind, string> = {
  prose: "must not contain control characters other than newline and tab, or invisible characters",
  strict: "must not contain any control, invisible or line-separator character",
  line: "must not contain control, invisible or line-separator characters",
  code: "must be a single line without control or invisible characters other than tab",
  name: "must not contain control, invisible or line-separator characters",
};
const MARK_RUN_CAP: Record<TextKind, number> = { prose: 8, strict: 8, code: 8, line: 6, name: 6 };
/** Joiners and variation selectors per string, whatever its length. */
export const MAX_JOINERS = 32;

const isJoiner = (cp: number): boolean => cp === 0x200c || cp === 0x200d;
const isVariationSelector = (cp: number): boolean => cp === 0xfe0e || cp === 0xfe0f;
const MARK = /^\p{M}$/u;
const WHITESPACE = /^[\s\p{Z}]$/u;
const EMOJI_OR_SYMBOL = /^[\p{Extended_Pictographic}\p{S}]$/u;
const isMark = (cp: number): boolean => MARK.test(String.fromCodePoint(cp));
const isSpace = (cp: number): boolean => WHITESPACE.test(String.fromCodePoint(cp));
const isVisible = (cp: number | undefined): cp is number =>
  cp !== undefined && !isJoiner(cp) && !isVariationSelector(cp) && !isSpace(cp);

/** Why `text` is not acceptable as the given kind of text, or undefined when it is. */
export const textProblem = (text: string, kind: TextKind): string | undefined => {
  if (!text.isWellFormed()) return "must not contain lone surrogates";
  if (FORBIDDEN[kind].test(text)) return FORBIDDEN_MESSAGE[kind];

  const points = Array.from(text, (character) => character.codePointAt(0) ?? 0);
  const cap = MARK_RUN_CAP[kind];
  let markRun = 0;
  let joiners = 0;
  let visible = 0;
  for (const [index, cp] of points.entries()) {
    if (isJoiner(cp) || isVariationSelector(cp)) {
      // Only prose and line get here; the other kinds forbid these outright above.
      joiners += 1;
      const previous = points[index - 1];
      const next = points[index + 1];
      if (isJoiner(cp)) {
        if (!isVisible(previous)) return "a zero-width joiner must follow a visible character";
        if (!isVisible(next) || isMark(next))
          return "a zero-width joiner must be followed by a visible character";
      } else if (previous === undefined || !EMOJI_OR_SYMBOL.test(String.fromCodePoint(previous))) {
        return "a variation selector must follow an emoji or symbol";
      }
      continue; // joiners do not break a run of combining marks
    }
    if (isMark(cp)) {
      markRun += 1;
      if (markRun > cap) return `must not have more than ${cap} consecutive combining marks`;
      continue;
    }
    markRun = 0;
    if (!isSpace(cp)) visible += 1;
  }
  if (joiners > MAX_JOINERS || joiners > Math.ceil(visible / 2))
    return "too many joiners or variation selectors for the visible text";
  return undefined;
};

export const hasForbiddenProseCharacters = (text: string): boolean =>
  textProblem(text, "prose") !== undefined;
export const hasForbiddenStrictProseCharacters = (text: string): boolean =>
  textProblem(text, "strict") !== undefined;
export const hasForbiddenLineCharacters = (text: string): boolean =>
  textProblem(text, "line") !== undefined;
export const hasForbiddenCodeCharacters = (text: string): boolean =>
  textProblem(text, "code") !== undefined;
export const hasForbiddenNameCharacters = (text: string): boolean =>
  textProblem(text, "name") !== undefined;

const textField = (kind: TextKind, max: number, min: number, description?: string) => {
  const schema = z
    .string()
    .min(min)
    .max(max)
    .superRefine((text, context) => {
      const problem = textProblem(text, kind);
      if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
    });
  return description === undefined ? schema : schema.describe(description);
};

/** Single-line text: no control, invisible or line-separator characters, not even \t or \n. */
export const line = (max: number, description?: string) => textField("line", max, 1, description);

/** Multi-line text: \n and \t are allowed, every other control or invisible character is not. */
export const prose = (max: number, description?: string) => textField("prose", max, 1, description);

/**
 * Text handed to another machine (the agent prompt): the strictest rule, because a reviewer
 * who sees "Fix it. ok" must be sure the coding agent sees the same. No invisible character of
 * any kind, not even the joiners emoji need.
 */
export const strictProse = (max: number, description?: string) =>
  textField("strict", max, 1, description);

/**
 * A line of code, as it would appear in a file: may be empty, may contain tabs, never a
 * newline (lines are already split), a control character or any invisible character (Trojan
 * Source hides in those).
 */
export const codeLine = (max: number, description?: string) =>
  textField("code", max, 0, description);

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

/** A dot however it was percent-encoded: `%2e`, `%252e`, `%25252e`…, and overlong UTF-8 `%c0%ae`. */
const ENCODED_DOT = /%(?:25)*(?:2e|c0%ae|e0%80%ae)/giu;
/**
 * Characters that read as a dot. NFKC already folds U+2024–2026, U+FF0E, U+FE52 and U+FF61 to
 * ASCII dots or U+3002; the list repeats them so the rule reads as a whole. Deliberately not
 * here: middle dot U+00B7, `!`, `#`, `@`, `'`, which are real file names.
 */
const DOT_LIKE_ONLY =
  /^(?:[.\u2024\u2025\u2026\u3002\uFF0E\uFF61\u06D4\u0701\u0702\uFE52\u0589])+$/u;
const WHITESPACE_ONLY = /^[\s\p{Z}]+$/u;
/**
 * The `.git` directory in every spelling a filesystem may map onto it: `.git`, `.git.` and
 * `.git ` (Windows trailing dot/space), `.git:stream` (NTFS alternate data streams), `git~1`
 * (8.3 short name). `.gitignore`, `.github` and `.git-hooks` are ordinary names.
 */
const GIT_DIR = /^(?:\.git(?:[. ]*|[. ]*:.*)|git~\d+)$/iu;

/**
 * Why a path is not acceptable, or undefined when it is. Beyond the structural pattern:
 * - no control, invisible or line-separator characters anywhere, no zalgo runs;
 * - no segment that, after NFKC folding, mark stripping and percent-decoding of dots, is
 *   only dots or dot look-alikes (`．．`, `‥`, `…`, `۔۔`, `܁܁`, `%2e%2e`, `%252e`, `%c0%ae`,
 *   `.̸`), only whitespace, or a spelling of the `.git` directory (`.git`, `.GIT.`, `.git:x`,
 *   `git~1`). Other punctuation-only names (`!`, `@`, `#`, `'`, `·`) are ordinary files.
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
    if (folded.length === 0 || DOT_LIKE_ONLY.test(folded))
      return `segment '${segment}' spells a dot segment`;
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
