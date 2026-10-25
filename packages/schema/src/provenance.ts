/**
 * Known facts: everything in the document that comes from git and the pipeline, never from
 * the model. `applyKnownFields` writes this whole section over whatever a model returned
 * (ADR 0004, P1-4), and the integrity checks measure the model's claims against it.
 */
import { z } from "zod";
import {
  MAX_FILE_LINE_COUNT,
  MAX_FILES,
  MAX_GENERATOR_NAME_LENGTH,
  MAX_GENERATOR_ROLES,
  MAX_HUNKS_PER_FILE,
  MAX_LINE_NUMBER,
  MAX_MODEL_NAME_LENGTH,
  MAX_PR_NUMBER,
  MAX_REF_LENGTH,
  MAX_REPO_NAME_LENGTH,
  MAX_REPO_OWNER_LENGTH,
  MAX_VERSION_LENGTH,
} from "./limits.js";
import { count, FullSha, line, RepositoryPath } from "./primitives.js";

/** GitHub's own rules for logins and repository names; other forges will need widening. */
export const RepoOwner = z
  .string()
  .min(1)
  .max(MAX_REPO_OWNER_LENGTH)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/, "must be a valid account login");
export const RepoName = z
  .string()
  .min(1)
  .max(MAX_REPO_NAME_LENGTH)
  .regex(/^[A-Za-z0-9._-]+$/, "must be a valid repository name");

/**
 * Git ref names (git-check-ref-format): no leading '-', no '..', '@{' or '//', no control
 * characters, space or '~^:?*[\\', no trailing '/', '.' or '.lock'.
 */
export const GitRef = z
  .string()
  .min(1)
  .max(MAX_REF_LENGTH)
  // No control characters, no space (the literal in the class), none of git's forbidden marks.
  .regex(
    // eslint-disable-next-line no-control-regex -- the rule is about control characters
    /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*(?:\/|\.|\.lock)$)[^\u0000-\u001F \u007F~^:?*[\\]+$/,
    "must be a valid git ref name",
  );

/**
 * One hunk as the unified diff header states it: `@@ -oldStart,oldLines +newStart,newLines @@`.
 * The new side covers lines newStart .. newStart + newLines - 1 (none when newLines is 0),
 * context lines included. Every line a finding or flag points at must fall inside one hunk.
 */
export const Hunk = z
  .strictObject({
    oldStart: count(MAX_LINE_NUMBER),
    oldLines: count(MAX_LINE_NUMBER),
    newStart: count(MAX_LINE_NUMBER),
    newLines: count(MAX_LINE_NUMBER),
  })
  .refine((hunk) => hunk.newLines === 0 || hunk.newStart >= 1, {
    message: "a hunk with new-side lines starts at line 1 or later",
    path: ["newStart"],
  })
  .refine((hunk) => hunk.oldLines === 0 || hunk.oldStart >= 1, {
    message: "a hunk with old-side lines starts at line 1 or later",
    path: ["oldStart"],
  })
  .describe("Unified diff hunk header numbers.");
export type Hunk = z.infer<typeof Hunk>;

/**
 * Hunks come in file order and never overlap on the new side. A pure deletion (`newLines` 0)
 * sits after `newStart`, so the next hunk may begin at `newStart + 1`.
 */
export const hunksInOrder = (hunks: readonly Hunk[]): boolean =>
  hunks.every((hunk, index) => {
    const previous = hunks[index - 1];
    if (previous === undefined) return true;
    const firstFree =
      previous.newLines === 0 ? previous.newStart + 1 : previous.newStart + previous.newLines;
    return hunk.newStart >= firstFree;
  });

export const FileStatus = z.enum(["added", "modified", "removed", "renamed"]);
export type FileStatus = z.infer<typeof FileStatus>;

export const ChangedFile = z
  .strictObject({
    path: RepositoryPath.describe("Path on the head side (the new path for a rename)."),
    previousPath: RepositoryPath.optional().describe("Path on the base side, for renames."),
    status: FileStatus,
    additions: count(MAX_FILE_LINE_COUNT),
    deletions: count(MAX_FILE_LINE_COUNT),
    hunks: z
      .array(Hunk)
      .max(MAX_HUNKS_PER_FILE)
      .refine(hunksInOrder, { message: "hunks must be in ascending order and not overlap" })
      .describe("Hunks of this file's diff, in order."),
  })
  .describe("One file in the PR's diff, as git reports it.");
export type ChangedFile = z.infer<typeof ChangedFile>;

export const LlmRole = z.enum(["triage", "review", "graph", "ask", "embed"]);
export type LlmRole = z.infer<typeof LlmRole>;

export const GeneratorRole = z
  .strictObject({
    role: LlmRole,
    provider: line(MAX_GENERATOR_NAME_LENGTH).optional(),
    model: line(MAX_MODEL_NAME_LENGTH),
  })
  .describe("Which model produced which part of the document.");
export type GeneratorRole = z.infer<typeof GeneratorRole>;

export const Generator = z
  .strictObject({
    name: line(MAX_GENERATOR_NAME_LENGTH).describe("The producing software, e.g. rocky."),
    version: line(MAX_VERSION_LENGTH).optional(),
    roles: z.array(GeneratorRole).max(MAX_GENERATOR_ROLES).default([]),
  })
  .describe("What produced the document.");
export type Generator = z.infer<typeof Generator>;

export const Provenance = z
  .strictObject({
    repo: z.strictObject({ owner: RepoOwner, name: RepoName }),
    pullRequest: z.strictObject({ number: z.int().min(1).max(MAX_PR_NUMBER) }),
    base: z.strictObject({ sha: FullSha, ref: GitRef.optional() }),
    head: z.strictObject({ sha: FullSha, ref: GitRef.optional() }),
    files: z
      .array(ChangedFile)
      .max(MAX_FILES)
      .describe("Every file the PR changes. The only files the rest of the document may name."),
    generatedAt: z.iso.datetime().describe("When the pipeline produced the document (UTC)."),
    generator: Generator,
  })
  .describe("Known facts from git and the pipeline. Never written by a model.");
export type Provenance = z.infer<typeof Provenance>;
export type ProvenanceInput = z.input<typeof Provenance>;
