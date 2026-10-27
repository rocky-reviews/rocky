/**
 * A seeded pull request (P4-7): synthetic code with known bugs and the findings a good review
 * should produce. Seeded code is written for Rocky's evals, never copied from a real repository;
 * `provenance` says where it came from and what was planted.
 */
import type { Script } from "@rocky-reviews/core/testing";
import type { SeededFinding } from "../score.js";

export interface SeededPr {
  /** `pr-<number>`. */
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly base: string;
  readonly head: string;
  /** Short note: who wrote it, when, from what, and what was planted. */
  readonly provenance: string;
  readonly diff: () => string;
  readonly expected: readonly SeededFinding[];
  /** Known, harmless remarks a review may make: they count neither for nor against. */
  readonly tolerated: readonly SeededFinding[];
  /**
   * `--fake` answers: what a decent (not perfect) model would say, so the harness measures
   * non-trivial scores for free. Keyed by role and path only, like every scripted model here.
   */
  readonly fake: Script;
}
