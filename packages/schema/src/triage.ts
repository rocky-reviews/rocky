/**
 * Triage: how much attention each changed file deserves, and why.
 *
 * Every file in the PR's file list appears exactly once, either as a triaged file or as noise
 * (lockfiles, generated code). The integrity pass enforces the coverage (TRIAGE_COVERAGE) and
 * that each score sits in its level's band (SCORE_LEVEL_MISMATCH).
 */
import { z } from "zod";
import {
  MAX_FILE_REVIEW_MINUTES,
  MAX_FILES,
  MAX_FLAG_TEXT_LENGTH,
  MAX_FLAGS_PER_FILE,
  MAX_REASON_LENGTH,
  MIN_FILE_REVIEW_MINUTES,
} from "./limits.js";
import { count, LineRange, prose, RepositoryPath, Score } from "./primitives.js";

/**
 * The level the UI groups by. `noise` files are described by the smaller `NoiseFile` record
 * rather than a `TriagedFile`, so a triaged file is never `noise`.
 */
export const TriageLevel = z.enum(["critical", "important", "normal", "low", "noise"]);
export type TriageLevel = z.infer<typeof TriageLevel>;

export const TriagedFileLevel = z.enum(["critical", "important", "normal", "low"]);
export type TriagedFileLevel = z.infer<typeof TriagedFileLevel>;

/** `look` asks for attention, `question` needs the author, `ok` records something checked. */
export const FlagKind = z.enum(["look", "question", "ok"]);
export type FlagKind = z.infer<typeof FlagKind>;

export const Flag = z
  .strictObject({
    range: LineRange.describe("New-side lines the flag sits under; must be inside a hunk."),
    kind: FlagKind,
    text: prose(MAX_FLAG_TEXT_LENGTH, "What to look at, as markdown (inline code allowed)."),
  })
  .describe("A note under a hunk line: look here, a question, or something checked.");
export type Flag = z.infer<typeof Flag>;

/**
 * Minutes a careful reviewer needs for this file. The briefing's PR-level estimate must be at
 * least the sum of these (REVIEW_MINUTES_TOO_LOW): the sidebar's "minutes of high-risk code
 * left" counts files, the briefing counts the whole PR, and the two must not contradict.
 */
export const ReviewMinutes = count(MAX_FILE_REVIEW_MINUTES)
  .refine((value) => value >= MIN_FILE_REVIEW_MINUTES)
  .describe("Estimated minutes a careful reviewer needs for this file. Zero for a glance.");

export const TriagedFile = z
  .strictObject({
    path: RepositoryPath.describe("Must be one of the PR's files."),
    score: Score,
    level: TriagedFileLevel,
    reviewMinutes: ReviewMinutes,
    reason: prose(MAX_REASON_LENGTH, "One line: why this file matters to the reviewer."),
    whatChanged: prose(MAX_REASON_LENGTH, "What the change does, in plain words."),
    whyThisLevel: prose(MAX_REASON_LENGTH, "Why the file got this level."),
    flags: z.array(Flag).max(MAX_FLAGS_PER_FILE).default([]),
  })
  .describe("Triage for one changed file.");
export type TriagedFile = z.infer<typeof TriagedFile>;

export const NoiseFile = z
  .strictObject({
    path: RepositoryPath.describe("Must be one of the PR's files."),
    summary: prose(MAX_REASON_LENGTH, "What the file is and why it can be trusted unread."),
  })
  .describe("A file a reviewer can trust without reading: lockfile, generated code, vendored.");
export type NoiseFile = z.infer<typeof NoiseFile>;

export const Triage = z
  .strictObject({
    files: z.array(TriagedFile).max(MAX_FILES),
    noise: z.array(NoiseFile).max(MAX_FILES).default([]),
  })
  .describe(
    "Per-file attention scores. Files and noise, plus provenance.unanalysed, cover every PR file once.",
  );
export type Triage = z.infer<typeof Triage>;
export type TriageInput = z.input<typeof Triage>;
