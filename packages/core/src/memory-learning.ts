/**
 * Learning project memory from reviewers' decisions (P8-2, ADR 0036 amendment). Pure: the
 * database side (`packages/db` `learnFromReviewSubmission`) reads the decisions of a posted
 * review and stores what this module derives, through `createMemoryEntry` (which scrubs and
 * validates again).
 *
 * What becomes an entry, deliberately conservative:
 *
 * - a draft **dismissed** as `intentional`, `not_an_issue` or `handled_elsewhere` becomes a
 *   `dismissal` entry with the reason code. `not_worth_it` is a call about one pull request's
 *   priorities, not a pattern of the repository, so it teaches nothing. A dismissed **critical**
 *   finding teaches nothing either: an entry can keep a finding out of later reviews, and the
 *   most dangerous entry is one that hides critical findings, so that stays a decision on the
 *   one pull request;
 * - a draft **accepted** (as is, or edited) and posted becomes a `convention` entry: reviewers
 *   here want this kind of finding raised. Never a `decision`: an accept carries no decision
 *   text, and decisions are what people write (P8-3).
 *
 * The text is deterministic, built from the reason and the finding's title only (never its
 * body, never the reviewer's edited text, never a model call): one line, which the store scrubs
 * of personal identifiers. The title is model output about PR content, so it is untrusted: a
 * title that carries a canary (however spaced or cased) or a run of Rocky's prompt text is
 * refused here, and the store refuses the canary prefix and PR-content markers again.
 */
import type { Finding } from "@rocky-reviews/schema";
import { instructionLeaks } from "./analysis/leak.js";
import type { DismissReason } from "./drafts.js";
import type { MemoryEvidence, MemoryKind } from "./memory.js";

export type ReviewDecision =
  | { readonly kind: "dismissed"; readonly reason: DismissReason }
  | { readonly kind: "accepted"; readonly edited: boolean };

/** Confidence (0..100) a first learned entry gets, by the signal it came from. */
export const LEARNED_CONFIDENCE = {
  intentional: 80,
  not_an_issue: 70,
  handled_elsewhere: 70,
  edited: 65,
  accepted: 60,
} as const;
/** Each corroboration from another pull request (same path, kind and subject) adds this. */
export const CORROBORATION_STEP = 10;
/** A learned entry never claims certainty. */
export const MAX_LEARNED_CONFIDENCE = 95;
/** At most this many entries are learned from one posted review. */
export const MAX_LEARNED_PER_REVIEW = 25;

const REASON_TEXT: Readonly<Record<Exclude<DismissReason, "not_worth_it">, string>> = {
  intentional: "Dismissed as intentional: ",
  not_an_issue: "Dismissed as not an issue: ",
  handled_elsewhere: "Dismissed as handled elsewhere: ",
};
const ACCEPTED_TEXT = "Accepted in review: ";
const PREFIXES = [...Object.values(REASON_TEXT), ACCEPTED_TEXT];

/** A learned entry before the store: what `createMemoryEntry` takes as `entry`. */
export interface LearnedEntry {
  readonly kind: Exclude<MemoryKind, "decision">;
  readonly origin: "learned";
  readonly text: string;
  readonly evidence: MemoryEvidence;
  readonly confidence: number;
  readonly reason: DismissReason | null;
}

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * The entry a decision teaches, or `null` when it teaches nothing (see the module comment) or
 * the title is unusable. `source` is the analysed revision: its pull request number and head
 * sha, from the stored document's provenance.
 */
export const learnedEntry = (
  decision: ReviewDecision,
  finding: Pick<Finding, "title" | "path" | "range" | "severity">,
  source: { readonly pullRequestNumber: number; readonly headSha: string },
): LearnedEntry | null => {
  const title = oneLine(finding.title).replace(/\.$/u, "");
  if (title.length === 0) return null;
  // Model text about PR content: refused when it carries a canary or Rocky's prompt text.
  if (instructionLeaks(title, []).length > 0) return null;
  const evidence: MemoryEvidence = {
    path: finding.path,
    sha: source.headSha,
    range: { start: finding.range.start, end: finding.range.end },
    pullRequestNumber: source.pullRequestNumber,
  };
  if (decision.kind === "accepted") {
    return {
      kind: "convention",
      origin: "learned",
      text: `${ACCEPTED_TEXT}${title}`,
      evidence,
      confidence: decision.edited ? LEARNED_CONFIDENCE.edited : LEARNED_CONFIDENCE.accepted,
      reason: null,
    };
  }
  const { reason } = decision;
  if (reason === "not_worth_it" || finding.severity === "critical") return null;
  return {
    kind: "dismissal",
    origin: "learned",
    text: `${REASON_TEXT[reason]}${title}`,
    evidence,
    confidence: LEARNED_CONFIDENCE[reason],
    reason,
  };
};

/**
 * What a learned entry is about, for telling repeats and reversals apart: the text after its
 * fixed prefix, lower-cased, whitespace collapsed. `null` for text that is not a learned entry's
 * (a member wrote it, or P8-3 edited it).
 */
export const memorySubject = (text: string): string | null => {
  const prefix = PREFIXES.find((candidate) => text.startsWith(candidate));
  if (prefix === undefined) return null;
  const subject = oneLine(text.slice(prefix.length)).toLowerCase();
  return subject.length === 0 ? null : subject;
};

/** The confidence of an entry that a current one of the same kind and subject corroborates. */
export const corroboratedConfidence = (base: number, previous: number | undefined): number =>
  previous === undefined
    ? base
    : Math.min(MAX_LEARNED_CONFIDENCE, Math.max(base, previous + CORROBORATION_STEP));
