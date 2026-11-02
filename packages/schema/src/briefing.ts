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
  MAX_TLDR_ITEM_LENGTH,
  MAX_TLDR_ITEMS,
  MIN_REVIEW_MINUTES,
  MIN_TLDR_ITEMS,
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
    reason: prose(
      MAX_REASON_LENGTH,
      "One short sentence: what makes this PR this risky. Documents before 1.4 may have two.",
    ),
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

/**
 * One TL;DR bullet (schema 1.4, H4-8): one sentence on one line. Inline `**bold**` and
 * `` `code` `` render as everywhere else in the briefing; a newline would turn a bullet into a
 * paragraph, so it is refused.
 */
export const TldrItem = prose(MAX_TLDR_ITEM_LENGTH, "One short sentence.").refine(
  (text) => !text.includes("\n"),
  { message: "a TL;DR item is one line" },
);

/** The TL;DR itself: required in the briefing call's answer, optional in the document. */
export const Tldr = z
  .array(TldrItem)
  .min(MIN_TLDR_ITEMS)
  .max(MAX_TLDR_ITEMS)
  .describe(
    "The briefing as two to four one-sentence bullets. The first says what the PR does; the rest say what matters most to the reviewer.",
  );

/**
 * The briefing's fields, before the rule that it has a summary or a TL;DR. Exported for the
 * briefing call's answer, which picks from it (Zod cannot pick from a refined object).
 */
export const BriefingFields = z.strictObject({
  tldr: Tldr.optional().describe(`Schema 1.4. ${Tldr.description}`),
  summary: prose(
    MAX_BRIEFING_SUMMARY_LENGTH,
    "What the PR does, for someone who has not read it. Documents before 1.4 always carry it; a 1.4 document may carry the TL;DR instead.",
  ).optional(),
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
});

/**
 * Every briefing says what the PR does: as the `summary` paragraph (every document before 1.4,
 * and Rocky's own fallback briefing) or as the `tldr` bullets (schema 1.4). Both may be present.
 */
export const Briefing = BriefingFields.meta({
  anyOf: [{ required: ["summary"] }, { required: ["tldr"] }],
})
  .refine((briefing) => briefing.summary !== undefined || briefing.tldr !== undefined, {
    message: "a briefing needs a summary or a TL;DR",
  })
  .describe("What to read before the diff.");
export type Briefing = z.infer<typeof Briefing>;
export type BriefingInput = z.input<typeof Briefing>;
