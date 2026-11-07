/**
 * The Ask eval's scorer (P9-2). P9-2's criterion is "eval questions answered with valid
 * citations ≥ 90%". A question counts as answered with valid citations when the model answered,
 * at least one of its citations points into an excerpt it was shown, and none points anywhere
 * else (core's `checkCitations` decides; an invalid citation is dropped in production, but here
 * it still fails the question). "No good answer", a failure or a capped call counts against.
 *
 * Beside the gate: citation-level validity, and target hits (a valid citation overlapping the
 * code that answers the question), which measure retrieval and the model, not the guard.
 * Results hold ids, codes and counts only: no question, code or model text.
 */
import type { AskTarget } from "./questions.js";

/** The gate (README "Ask"). */
export const ASK_MIN_VALID_RATE = 0.9;

export type AskQuestionStatus = "answer" | "no_answer" | "failed" | "capped";

/** What one question's run gave, as the scorer needs it. */
export interface AskRunResult {
  readonly id: string;
  readonly status: AskQuestionStatus;
  /** A fixed code: the no-answer reason, the failure reason, or null. */
  readonly reason: string | null;
  /** Citations that pointed into a shown excerpt. */
  readonly valid: readonly AskTarget[];
  /** Citations that pointed anywhere else. */
  readonly dropped: number;
  readonly excerpts: number;
}

export interface AskQuestionScore {
  readonly id: string;
  readonly status: AskQuestionStatus;
  readonly reason: string | null;
  readonly validCitations: number;
  readonly invalidCitations: number;
  readonly excerpts: number;
  /** Answered with ≥ 1 valid citation and no invalid one. */
  readonly validlyCited: boolean;
  /** A valid citation overlaps one of the question's targets. */
  readonly targetHit: boolean;
}

export interface AskScore {
  readonly questions: number;
  readonly answered: number;
  readonly validlyCited: number;
  /** validlyCited / questions (the gated rate; 0 when there are no questions). */
  readonly validRate: number;
  readonly validCitations: number;
  readonly invalidCitations: number;
  /** valid / (valid + invalid) citations; 1 when none was given. */
  readonly citationValidity: number;
  readonly targetHits: number;
  readonly pass: boolean;
  readonly results: readonly AskQuestionScore[];
}

const overlaps = (a: AskTarget, b: AskTarget) =>
  a.path === b.path && a.start <= b.end && b.start <= a.end;

export const scoreQuestion = (
  result: AskRunResult,
  targets: readonly AskTarget[],
): AskQuestionScore => ({
  id: result.id,
  status: result.status,
  reason: result.reason,
  validCitations: result.valid.length,
  invalidCitations: result.dropped,
  excerpts: result.excerpts,
  validlyCited: result.status === "answer" && result.valid.length > 0 && result.dropped === 0,
  targetHit: result.valid.some((c) => targets.some((t) => overlaps(c, t))),
});

export const scoreAsk = (results: readonly AskQuestionScore[]): AskScore => {
  const count = (f: (r: AskQuestionScore) => boolean) => results.filter(f).length;
  const sum = (f: (r: AskQuestionScore) => number) => results.reduce((n, r) => n + f(r), 0);
  const validlyCited = count((r) => r.validlyCited);
  const validCitations = sum((r) => r.validCitations);
  const invalidCitations = sum((r) => r.invalidCitations);
  const validRate = results.length === 0 ? 0 : validlyCited / results.length;
  return {
    questions: results.length,
    answered: count((r) => r.status === "answer"),
    validlyCited,
    validRate,
    validCitations,
    invalidCitations,
    citationValidity:
      validCitations + invalidCitations === 0
        ? 1
        : validCitations / (validCitations + invalidCitations),
    targetHits: count((r) => r.targetHit),
    // Float noise only: 9 of 10 is exactly the floor.
    pass: results.length > 0 && validRate >= ASK_MIN_VALID_RATE - 1e-9,
    results: [...results],
  };
};
