/**
 * The Ask eval's scorer (P9-2, ADR 0041 §8). P9-2's criterion is "eval questions answered with
 * valid citations ≥ 90%". Two definitions of a question that counts, both reported:
 *
 * - **guard** (`validlyCited`): the model answered, at least one citation points into lines it
 *   was shown, and none points anywhere else (core's `checkCitations` decides; production drops
 *   an invalid citation, the eval also fails the question for it). This measures the guard and
 *   the model's discipline, not whether it found the answer.
 * - **on target** (`onTarget`): validly cited, and at least one valid citation overlaps a range
 *   that answers the question (`questions.ts`). This is "valid" for the criterion: a citation
 *   that is inside what was shown but beside the point is not a valid answer to the question.
 *
 * The gate is `on_target` for a live run (both rates ≥ 90%) and `guard` for the scripted fake,
 * whose bag-of-words retrieval measures nothing about a model. No good answer, a refusal, a
 * call error or the cap counts against. Results hold ids, codes and counts only.
 */
import type { AskTarget } from "./questions.js";

/** The floor (README "Ask"). */
export const ASK_MIN_VALID_RATE = 0.9;

export type AskGate = "guard" | "on_target";

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
  readonly gate: AskGate;
  readonly questions: number;
  readonly answered: number;
  readonly validlyCited: number;
  /** validlyCited / questions (0 when there are no questions). */
  readonly validRate: number;
  /** Validly cited and on target. */
  readonly onTarget: number;
  /** onTarget / questions (0 when there are no questions). */
  readonly onTargetRate: number;
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

/** Float noise only: 9 of 10 is exactly the floor. */
export const meetsFloor = (rate: number): boolean => rate >= ASK_MIN_VALID_RATE - 1e-9;

/** Whether rates pass `gate` (also used by the comparison, which recomputes it). */
export const askPasses = (
  gate: AskGate,
  rates: { readonly questions: number; readonly validRate: number; readonly onTargetRate: number },
): boolean =>
  rates.questions > 0 &&
  meetsFloor(rates.validRate) &&
  (gate === "guard" || meetsFloor(rates.onTargetRate));

export const scoreAsk = (results: readonly AskQuestionScore[], gate: AskGate): AskScore => {
  const count = (f: (r: AskQuestionScore) => boolean) => results.filter(f).length;
  const sum = (f: (r: AskQuestionScore) => number) => results.reduce((n, r) => n + f(r), 0);
  const validlyCited = count((r) => r.validlyCited);
  const onTarget = count((r) => r.validlyCited && r.targetHit);
  const validCitations = sum((r) => r.validCitations);
  const invalidCitations = sum((r) => r.invalidCitations);
  const of = (n: number) => (results.length === 0 ? 0 : n / results.length);
  const rates = {
    questions: results.length,
    validRate: of(validlyCited),
    onTargetRate: of(onTarget),
  };
  return {
    gate,
    questions: results.length,
    answered: count((r) => r.status === "answer"),
    validlyCited,
    validRate: rates.validRate,
    onTarget,
    onTargetRate: rates.onTargetRate,
    validCitations,
    invalidCitations,
    citationValidity:
      validCitations + invalidCitations === 0
        ? 1
        : validCitations / (validCitations + invalidCitations),
    targetHits: count((r) => r.targetHit),
    pass: askPasses(gate, rates),
    results: [...results],
  };
};
