/**
 * Findings: draft review comments a human accepts, edits or dismisses. Nothing here is posted
 * without that decision (ADR 0004).
 */
import { z } from "zod";
import {
  MAX_AGENT_PROMPT_LENGTH,
  MAX_BODY_LENGTH,
  MAX_CONTEXT_LINE_LENGTH,
  MAX_FINDINGS,
  MAX_MEMORY_REFS_PER_FINDING,
  MAX_MEMORY_SOURCE_LENGTH,
  MAX_MEMORY_TEXT_LENGTH,
  MAX_SUGGESTION_LINE_LENGTH,
  MAX_SUGGESTION_LINES,
  MAX_TITLE_LENGTH,
} from "./limits.js";
import {
  codeLine,
  Confidence,
  Id,
  line,
  LineRange,
  prose,
  RepositoryPath,
  strictProse,
} from "./primitives.js";

export const Severity = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

/**
 * A suggested patch for the finding's range: the referenced lines are replaced by `lines`
 * (an empty array deletes them; to insert, repeat the original line and add the new one).
 * `context` is the line just before the range; when the file's content is available the
 * integrity pass checks it matches (SUGGESTION_CONTEXT_MISMATCH), which catches a suggestion
 * written against stale or misremembered code.
 */
export const Suggestion = z
  .strictObject({
    lines: z
      .array(codeLine(MAX_SUGGESTION_LINE_LENGTH))
      .max(MAX_SUGGESTION_LINES)
      .describe("Replacement for the finding's range. Empty deletes the range."),
    context: codeLine(MAX_CONTEXT_LINE_LENGTH)
      .optional()
      .describe("The unchanged line immediately before the range, verbatim."),
  })
  .describe("A replacement for the finding's referenced lines.");
export type Suggestion = z.infer<typeof Suggestion>;

export const MemoryRef = z
  .strictObject({
    entryId: Id.describe("Id of the project-memory entry."),
    text: line(MAX_MEMORY_TEXT_LENGTH, "The entry as quoted to the reviewer."),
    source: line(MAX_MEMORY_SOURCE_LENGTH, "Where it came from, e.g. 'decision · PR #612'."),
  })
  .describe("A project-memory entry this finding or briefing relied on.");
export type MemoryRef = z.infer<typeof MemoryRef>;

/** The reasons a dismissal entry can carry (core's `DismissReason`, listed here for the document). */
export const DISMISSAL_REASONS = [
  "not_an_issue",
  "intentional",
  "not_worth_it",
  "handled_elsewhere",
] as const;
/** Why a covered finding is shown anyway: the file is triaged critical, or its path takes a rule floor. */
export const RESTORED_BECAUSE = ["critical_file", "rule_floor"] as const;

/**
 * Schema 1.5 (P8-2, ADR 0037 §4): a dismissal entry covered this finding, but no suppression
 * stands on this file (triaged critical, or a rule floor: auth, migrations), so the pipeline
 * raised it as a draft anyway and says so. Written by the pipeline only, from the stored entry;
 * never part of a model answer. Distinct from `memory` (what backs a finding): this entry argued
 * against it.
 */
export const RestoredDismissal = z
  .strictObject({
    entry: MemoryRef.describe(
      "The dismissal entry the model applied, quoted from the stored entry.",
    ),
    path: RepositoryPath.describe(
      "Where the team took that dismissal (the entry's evidence path).",
    ),
    dismissedAs: z.enum(DISMISSAL_REASONS).describe("The dismissal's reason."),
    shownBecause: z
      .enum(RESTORED_BECAUSE)
      .describe(
        "Why it is shown anyway: the file is triaged critical, or always gets a full review.",
      ),
  })
  .describe(
    "Set by the pipeline when a dismissal covered this finding but the file is one where no suppression stands: the reviewer should double-check it.",
  );
export type RestoredDismissal = z.infer<typeof RestoredDismissal>;

export const Finding = z
  .strictObject({
    id: Id,
    severity: Severity,
    confidence: Confidence,
    path: RepositoryPath.describe("Must be one of the PR's triaged (non-noise) files."),
    range: LineRange.describe("New-side lines the finding is about; must be inside a hunk."),
    title: line(MAX_TITLE_LENGTH, "One line, no trailing period."),
    body: prose(MAX_BODY_LENGTH, "Markdown subset: paragraphs, inline code, lists. No raw HTML."),
    suggestion: Suggestion.optional(),
    memory: z.array(MemoryRef).max(MAX_MEMORY_REFS_PER_FINDING).default([]),
    restored: RestoredDismissal.optional(),
    agentPrompt: strictProse(
      MAX_AGENT_PROMPT_LENGTH,
      "Self-contained instruction for a coding agent to fix this finding. No invisible characters of any kind.",
    ),
  })
  .describe("A draft review comment.");
export type Finding = z.infer<typeof Finding>;
export type FindingInput = z.input<typeof Finding>;

export const Findings = z.array(Finding).max(MAX_FINDINGS);

/**
 * Schema 1.6 (P8-2b, ADR 0037 §7): why a finding is hidden rather than drafted. A dismissal
 * entry covered it and the suppression stood (the pipeline's rules, never the model's word), so
 * Rocky kept it out of the drafts but not out of sight: the page lists it under "hidden by
 * memory" and the reviewer can restore it as a draft. Written by the pipeline only, from the
 * stored entry. `entry` is also in `briefing.memoryApplied` (it was applied).
 */
export const HiddenByDismissal = z
  .strictObject({
    entry: MemoryRef.describe(
      "The dismissal entry that covers this finding, quoted from the stored entry.",
    ),
    path: RepositoryPath.describe(
      "Where the team took that dismissal (the entry's evidence path).",
    ),
    dismissedAs: z.enum(DISMISSAL_REASONS).describe("The dismissal's reason."),
  })
  .describe("Set by the pipeline on a finding a dismissal entry kept out of the drafts.");
export type HiddenByDismissal = z.infer<typeof HiddenByDismissal>;

/**
 * A finding a dismissal entry kept out of the drafts (schema 1.6). The same shape as a draft
 * minus what only a draft carries (a suggestion, memory backing, the double-check marker), plus
 * `hiddenBy`. Ids are their own collection (`H1`, `H2`, …): a hidden finding is not a draft
 * until the reviewer restores it.
 */
export const HiddenFinding = Finding.omit({ suggestion: true, memory: true, restored: true })
  .extend({ hiddenBy: HiddenByDismissal })
  .describe("A finding project memory hid; shown collapsed, restorable as a draft.");
export type HiddenFinding = z.infer<typeof HiddenFinding>;

export const HiddenFindings = z.array(HiddenFinding).max(MAX_FINDINGS);
