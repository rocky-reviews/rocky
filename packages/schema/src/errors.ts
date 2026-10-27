/**
 * Codes are the stable half of a failure; messages are not. Callers (the repair round in
 * packages/llm, the UI) switch on the code; every code stays meaningful across versions.
 *
 * Error shape and `formatPath` adapted from PR Lens (https://github.com/coldteadotai/pr-lens),
 * MIT License, Copyright (c) 2026 Coldtea AI. See NOTICE.
 */
export type IssueCode =
  /** Zod rejected the shape: wrong type, missing or unknown field, limit exceeded, bad pattern. */
  | "INVALID_SHAPE"
  /** The raw text is not JSON. */
  | "INVALID_JSON"
  /** The document nests deeper than the parser can read. */
  | "TOO_DEEP"
  /** An object is reached twice (a cycle or a shared subtree): not the output of JSON.parse. */
  | "SHARED_REFERENCE"
  /** `schemaVersion` is not one this package implements. */
  | "UNSUPPORTED_SCHEMA_VERSION"
  /** The same id appears twice in one collection. */
  | "DUPLICATE_ID"
  /** The same path appears twice in one collection. */
  | "DUPLICATE_PATH"
  /** An id points at an element the document does not declare. */
  | "BROKEN_REFERENCE"
  /** A path is not in the PR's file list (or, for a review-path step, not a triaged file). */
  | "UNKNOWN_FILE"
  /** A finding points at a path the triage calls noise. */
  | "FINDING_IN_NOISE_FILE"
  /** A finding points at a file the AI could not analyse. */
  | "FINDING_IN_UNANALYSED_FILE"
  /** A finding's memory reference is missing from, or differs from, briefing.memoryApplied. */
  | "MEMORY_REF_MISMATCH"
  /** A line range is not inside a single new-side hunk of the file's diff. */
  | "LINE_OUTSIDE_DIFF"
  /** A PR file is missing from triage, or listed in more than one of files/noise/unanalysed. */
  | "TRIAGE_COVERAGE"
  /** A triage score is outside its level's band. */
  | "SCORE_LEVEL_MISMATCH"
  /** A critical or high finding sits in a file triaged `low`. */
  | "SEVERITY_LEVEL_MISMATCH"
  /** The PR verdict is lower than its findings allow (a critical finding means a critical verdict). */
  | "VERDICT_TOO_LOW"
  /** The PR's estimated review minutes are below the sum of the per-file estimates. */
  | "REVIEW_MINUTES_TOO_LOW"
  /** A suggestion names a context line but its range starts at line 1. */
  | "SUGGESTION_CONTEXT_IMPOSSIBLE"
  /** A suggestion's context line differs from the file. */
  | "SUGGESTION_CONTEXT_MISMATCH"
  /** A suggestion's range runs past the end of the file. */
  | "SUGGESTION_RANGE_OUTSIDE_FILE"
  /** A suggestion replaces lines with themselves. */
  | "SUGGESTION_NOOP"
  /** A `provenance.readByHand` file is not triaged, or has findings (schema 1.1). */
  | "READ_BY_HAND_MISMATCH"
  /** A total the shape could not bound (views in a tree, flags, document bytes) is over its limit. */
  | "LIMIT_EXCEEDED"
  /** The parser hit an unexpected error. Reported, never thrown. */
  | "INTERNAL_ERROR";

/** One problem, located. `path` is a JSON path like `findings[2].range.end`; "" is the root. */
export type SchemaIssue = {
  code: IssueCode;
  path: string;
  message: string;
};

export type ParseError = {
  /** The first issue's code, for callers that want one answer. */
  code: IssueCode;
  message: string;
  issues: readonly SchemaIssue[];
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: ParseError };

export const formatIssues = (issues: readonly SchemaIssue[]): string =>
  issues.map((issue) => `${issue.path || "<root>"}: ${issue.message} [${issue.code}]`).join("\n");

/** `findings[2].range.end` from Zod's `["findings", 2, "range", "end"]`. */
export const formatPath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc === "" ? String(segment) : `${acc}.${String(segment)}`;
  }, "");
