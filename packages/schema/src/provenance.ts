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
  MAX_REASON_LENGTH,
  MAX_REF_LENGTH,
  MAX_REPO_NAME_LENGTH,
  MAX_REPO_OWNER_LENGTH,
  MAX_VERSION_LENGTH,
} from "./limits.js";
import {
  count,
  FullSha,
  hasForbiddenNameCharacters,
  line,
  prose,
  RepositoryPath,
} from "./primitives.js";

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
 * Why a ref name is not acceptable (git-check-ref-format), or undefined when it is: no control,
 * invisible or line-separator characters; no `..`, `@{` or `//`; not `@`; no leading `-`; no
 * trailing `/` or `.`; per component: not empty, no leading `.`, no `.lock` suffix, none of
 * space `~ ^ : ? * [ \`.
 */
/** Characters git-check-ref-format refuses inside a component. */
// eslint-disable-next-line no-control-regex -- the rule is about control characters
const GIT_FORBIDDEN = /[\u0000-\u0020\u007F~^:?*[\\]/u;

export const gitRefProblem = (ref: string): string | undefined => {
  if (hasForbiddenNameCharacters(ref))
    return "must not contain control, invisible or line-separator characters";
  if (ref === "@") return "must not be '@'";
  if (ref.startsWith("-")) return "must not start with '-'";
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//"))
    return "must not contain '..', '@{' or '//'";
  if (ref.endsWith("/") || ref.endsWith(".")) return "must not end with '/' or '.'";
  for (const component of ref.split("/")) {
    if (component.length === 0) return "must not have empty components";
    if (component.startsWith(".")) return `component '${component}' must not start with '.'`;
    if (component.endsWith(".lock")) return `component '${component}' must not end with '.lock'`;
    if (GIT_FORBIDDEN.test(component))
      return `component '${component}' contains a character git forbids`;
  }
  return undefined;
};

/** Structural half of the ref rule, for the JSON Schema; `gitRefProblem` adds the rest. */
// eslint-disable-next-line no-control-regex -- the rule is about control characters
const GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)[^\u0000-\u0020\u007F~^:?*[\\]+$/;

export const GitRef = z
  .string()
  .min(1)
  .max(MAX_REF_LENGTH)
  .regex(GIT_REF_PATTERN, "must be a valid git ref name")
  .superRefine((ref, context) => {
    const problem = gitRefProblem(ref);
    if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
  });

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

/** Why the pipeline could not analyse a file. Written by the pipeline, never by the model. */
export const UnanalysedReason = z.enum(["analysis-failed", "too-large", "binary", "timeout"]);
export type UnanalysedReason = z.infer<typeof UnanalysedReason>;

/**
 * A file the AI could not analyse (ADR 0004 §2): the model's output for it failed validation
 * after the repair round, or the file was never sent. It lives in the facts, so
 * `applyKnownFields` overwrites whatever a model claims: a model cannot hide a file from
 * review by calling it unanalysed. The UI shows "AI couldn't analyse this file"; no finding,
 * flag, triage entry or review-path step may name it.
 */
export const UnanalysedFile = z
  .strictObject({
    path: RepositoryPath.describe("Must be one of the PR's files."),
    reason: UnanalysedReason,
    detail: prose(MAX_REASON_LENGTH).optional().describe("Human-readable detail, if any."),
  })
  .describe("A file the AI could not analyse.");
export type UnanalysedFile = z.infer<typeof UnanalysedFile>;

/**
 * Why the pipeline could not produce a change map. Written by the pipeline, never by the model:
 * `analysis-failed` is the graph role's output failing validation after the repair round,
 * `too-large` a PR over the graph's budget, `timeout` the role not answering in time.
 */
export const GraphUnavailableReason = z.enum(["analysis-failed", "too-large", "timeout"]);
export type GraphUnavailableReason = z.infer<typeof GraphUnavailableReason>;

/**
 * The change map is optional (gate H2, #2): when the graph role fails, the rest of the review
 * still ships and the UI shows "Change map unavailable", this reason and a Retry button. The
 * reason lives in the facts, like `unanalysed`, so `applyKnownFields` overwrites whatever a
 * model claims (and drops a model's `graph` when this is set) and the text the UI shows for it
 * is never model-written. `detail` holds only fixed strings the pipeline writes itself: never a
 * raw error message, a prompt or model output, which could carry PR content into the UI. A
 * document carries either a `graph` or this field, never both.
 */
export const GraphUnavailable = z
  .strictObject({
    reason: GraphUnavailableReason,
    detail: prose(MAX_REASON_LENGTH)
      .optional()
      .describe(
        "Fixed, pipeline-written detail, if any. Never a raw error message, prompt or model output.",
      ),
  })
  .describe("Why the change map is missing. Written by the pipeline, never by a model.");
export type GraphUnavailable = z.infer<typeof GraphUnavailable>;

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
    unanalysed: z
      .array(UnanalysedFile)
      .max(MAX_FILES)
      .default([])
      .describe("Files the pipeline could not analyse; they count toward triage coverage."),
    graphUnavailable: GraphUnavailable.optional().describe(
      "Present only when the pipeline could not produce the change map; the document then has no graph.",
    ),
    generatedAt: z.iso.datetime().describe("When the pipeline produced the document (UTC)."),
    generator: Generator,
  })
  .describe("Known facts from git and the pipeline. Never written by a model.");
export type Provenance = z.infer<typeof Provenance>;
export type ProvenanceInput = z.input<typeof Provenance>;
