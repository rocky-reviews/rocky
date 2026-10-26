/** The briefing: what a reviewer reads before opening a single file. */
import { z } from "zod";
import { MemoryRef } from "./findings.js";
import {
  MAX_BRIEFING_SUMMARY_LENGTH,
  MAX_CHECKED_ITEM_LENGTH,
  MAX_CHECKED_ITEMS,
  MAX_MEMORY_APPLIED,
  MAX_REASON_LENGTH,
  MAX_REVIEW_MINUTES,
  MAX_REVIEW_PATH,
  MIN_REVIEW_MINUTES,
} from "./limits.js";
import { prose, RepositoryPath } from "./primitives.js";

/**
 * PR-level risk. Must not sit below what the findings say (VERDICT_TOO_LOW): a critical finding
 * makes the verdict `critical`, a high finding makes it at least `medium`.
 */
export const RiskLevel = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const Verdict = z
  .strictObject({
    level: RiskLevel,
    reason: prose(MAX_REASON_LENGTH, "One or two sentences: what makes this PR this risky."),
  })
  .describe("The one-line risk call for the whole PR.");
export type Verdict = z.infer<typeof Verdict>;

export const ReviewPathStep = z
  .strictObject({
    path: RepositoryPath.describe("Must be one of the triaged (non-noise) files."),
    why: prose(MAX_REASON_LENGTH, "Why this file comes here in the order."),
  })
  .describe("One stop on the suggested review path.");
export type ReviewPathStep = z.infer<typeof ReviewPathStep>;

export const Briefing = z
  .strictObject({
    summary: prose(
      MAX_BRIEFING_SUMMARY_LENGTH,
      "What the PR does, for someone who has not read it.",
    ),
    verdict: Verdict,
    estimatedReviewMinutes: z
      .int()
      .min(MIN_REVIEW_MINUTES)
      .max(MAX_REVIEW_MINUTES)
      .describe(
        "Minutes for the whole PR; at least the sum of triage.files[].reviewMinutes, plus the briefing and noise.",
      ),
    reviewPath: z
      .array(ReviewPathStep)
      .max(MAX_REVIEW_PATH)
      .describe("Files in the order to read them; each triaged file at most once."),
    checkedOk: z
      .array(prose(MAX_CHECKED_ITEM_LENGTH))
      .max(MAX_CHECKED_ITEMS)
      .default([])
      .describe("Things the AI checked and found fine, so the reviewer need not."),
    memoryApplied: z
      .array(MemoryRef)
      .max(MAX_MEMORY_APPLIED)
      .default([])
      .describe("Project-memory entries used anywhere in the analysis."),
  })
  .describe("What to read before the diff.");
export type Briefing = z.infer<typeof Briefing>;
export type BriefingInput = z.input<typeof Briefing>;
