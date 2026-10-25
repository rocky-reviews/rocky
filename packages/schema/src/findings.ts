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
    agentPrompt: strictProse(
      MAX_AGENT_PROMPT_LENGTH,
      "Self-contained instruction for a coding agent to fix this finding. No invisible characters of any kind.",
    ),
  })
  .describe("A draft review comment.");
export type Finding = z.infer<typeof Finding>;
export type FindingInput = z.input<typeof Finding>;

export const Findings = z.array(Finding).max(MAX_FINDINGS);
