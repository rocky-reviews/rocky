/**
 * Shared field types. Everything a model writes passes through one of these, so the rules
 * about control characters, path shapes and identifiers live here and nowhere else.
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

// The three patterns below are about control characters on purpose, hence the lint waivers.
/** Control characters that are never acceptable in text: C0 except \t and \n, plus DEL. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_PROSE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
/** Single-line text additionally forbids \t and \n. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_LINE = /[\u0000-\u001F\u007F]/;

export const hasForbiddenProseCharacters = (text: string): boolean => FORBIDDEN_IN_PROSE.test(text);
export const hasForbiddenLineCharacters = (text: string): boolean => FORBIDDEN_IN_LINE.test(text);

/**
 * Single-line text: no control characters at all (not even \t or \n). Carriage returns are
 * rejected too, so a document never carries line endings a renderer has to normalise.
 */
export const line = (max: number, description?: string) => {
  const schema = z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasForbiddenLineCharacters(text), {
      message: "must not contain control characters",
    });
  return description === undefined ? schema : schema.describe(description);
};

/** Multi-line text: \n and \t are allowed, every other control character is rejected. */
export const prose = (max: number, description?: string) => {
  const schema = z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasForbiddenProseCharacters(text), {
      message: "must not contain control characters other than newline and tab",
    });
  return description === undefined ? schema : schema.describe(description);
};

/**
 * A line of code, as it would appear in a file: may be empty, may contain tabs, never a
 * newline (lines are already split) or any other control character.
 */
export const codeLine = (max: number, description?: string) => {
  const schema = z
    .string()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((text) => !/[\u0000-\u0008\u000A-\u001F\u007F]/.test(text), {
      message: "must be a single line without control characters other than tab",
    });
  return description === undefined ? schema : schema.describe(description);
};

/**
 * Identifiers are model-authored, so they are constrained to a shape that survives an SVG id,
 * a URL fragment and a GitHub comment anchor without escaping. Uniqueness within a collection
 * is checked by the integrity pass (DUPLICATE_ID), not here.
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
 * Repository-relative POSIX path: no leading slash, no drive letter, no backslash, no empty,
 * `.` or `..` segment, no trailing slash, no control characters. A path that breaks any of
 * these cannot be joined safely onto a checkout or turned into a diff permalink.
 */
const PATH_SEGMENT = "(?!\\.\\.?(?:/|$))[^/\\\\\\u0000-\\u001F\\u007F]+";
export const REPOSITORY_PATH_PATTERN = new RegExp(
  `^(?![A-Za-z]:)${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`,
);

export const RepositoryPath = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .regex(
    REPOSITORY_PATH_PATTERN,
    "must be a repository-relative POSIX path: no leading '/', drive letter, backslash, '.' or '..' segment, or control character",
  )
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

export const Score = z
  .int()
  .min(MIN_SCORE)
  .max(MAX_SCORE)
  .describe("Triage score: how much of the reviewer's attention this file deserves.");

export const Confidence = z
  .int()
  .min(MIN_CONFIDENCE)
  .max(MAX_CONFIDENCE)
  .describe("How sure the model is, in percent.");

/**
 * How an element relates to the base branch. `unchanged` elements are the context a reader
 * needs to judge blast radius, so they are first-class rather than omitted.
 */
export const Delta = z
  .enum(["added", "modified", "removed", "unchanged"])
  .describe("Change state relative to the base commit.");
export type Delta = z.infer<typeof Delta>;
