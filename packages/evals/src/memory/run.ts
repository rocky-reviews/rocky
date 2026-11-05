/**
 * The project-memory eval (P8-2): learn from a dismissal on one pull request, then check that the
 * next similar pull request does not raise the dismissed pattern again and cites the entry. It
 * runs the real pipeline (`analyzePullRequest` through the caller's `analyse`) and the real
 * learning rules (core `learnedEntry` and the store's `prepareMemoryEntry`); only the database is
 * left out (the store side is `packages/db` `learnFromReviewSubmission`, tested on Postgres).
 *
 * Three analyses: run 1 (pr-1301, no memory), a control (pr-1302, no memory) and run 2 (pr-1302
 * with the learned entry). The result holds booleans, counts and ids only: no model text.
 */
import {
  learnedEntry,
  memorySourceLabel,
  prepareMemoryEntry,
  type AnalysisMemoryEntry,
  type AnalysisOutcome,
  type AnalysisRequest,
} from "@rocky-reviews/core";
import type { Finding } from "@rocky-reviews/schema";
import { scoreFindings, type SeededFinding } from "../score.js";
import { MEMORY_RUN_1, MEMORY_RUN_2, memoryCaseDiff, type MemoryCasePr } from "./case.js";

export type MemoryStep = "learn" | "control" | "apply";

export type MemoryAnalyse = (
  step: MemoryStep,
  request: AnalysisRequest,
) => Promise<AnalysisOutcome | "capped">;

/** A stand-in for the stored entry's id: what the pipeline cites and the worker would touch. */
export const MEMORY_EVAL_ENTRY_ID = "00000000-0000-4000-8000-000000001301";

export interface MemoryEvalResult {
  /** `done` when all three analyses were stored; otherwise the first other status. */
  readonly status: "done" | "failed" | "capped";
  /** Run 1 raised the pattern (there was something to dismiss). */
  readonly run1Raised: boolean;
  /** The dismissal taught an entry that passed the store's rules. */
  readonly learned: boolean;
  /** Without memory, pr-1302's pattern is raised (the control). */
  readonly controlRaised: boolean;
  /** With the entry, pr-1302's pattern is raised anyway (must be false). */
  readonly run2Raised: boolean;
  /** Run 2's briefing cites the entry (`briefing.memoryApplied`). */
  readonly run2Cited: boolean;
  /** Run 2 still finds pr-1302's real bug: memory hid nothing else. */
  readonly run2BugFound: boolean;
  /** Every condition above holds. */
  readonly pass: boolean;
}

const request = (pr: MemoryCasePr, memory?: readonly AnalysisMemoryEntry[]): AnalysisRequest => ({
  repo: { owner: "acme", name: "rocky-app" },
  pullRequest: { number: pr.number, title: pr.title },
  base: { sha: pr.base, ref: "main" },
  head: { sha: pr.head, ref: "feat/jobs" },
  diff: memoryCaseDiff(pr),
  diffTruncated: false,
  ...(memory === undefined ? {} : { memory }),
});

const findingsOf = (outcome: AnalysisOutcome | "capped"): readonly Finding[] =>
  outcome !== "capped" && outcome.status === "done" ? outcome.document.findings : [];

/** The produced finding that matches `seeded` under the suite's matching rules, if any. */
const matchOf = (seeded: SeededFinding, findings: readonly Finding[]): Finding | undefined => {
  const score = scoreFindings([seeded], findings);
  const pair = score.pairs[0];
  return pair === undefined ? undefined : findings[pair.produced];
};

/**
 * The entry a reviewer's "dismiss as intentional" of `finding` teaches, as the store would hold
 * it (scrubbed and validated by `prepareMemoryEntry`) and the worker would give the pipeline.
 */
export const learnedFrom = (
  finding: Finding,
  pr: MemoryCasePr,
): AnalysisMemoryEntry | undefined => {
  const learned = learnedEntry({ kind: "dismissed", reason: "intentional" }, finding, {
    pullRequestNumber: pr.number,
    headSha: pr.head,
  });
  if (learned === null) return undefined;
  const prepared = prepareMemoryEntry(learned, { origin: "learned", people: [] });
  if (!prepared.ok) return undefined;
  const { draft } = prepared;
  return {
    id: MEMORY_EVAL_ENTRY_ID,
    kind: draft.kind,
    origin: "learned",
    reason: draft.reason,
    // What the learner records on a dismissal: the dismissed finding's severity.
    severity: draft.kind === "dismissal" ? finding.severity : null,
    text: draft.text,
    path: draft.evidence.path,
    source: memorySourceLabel(draft),
    confidence: draft.confidence,
  };
};

const statusOf = (
  outcomes: readonly (AnalysisOutcome | "capped")[],
): MemoryEvalResult["status"] => {
  for (const outcome of outcomes) {
    if (outcome === "capped") return "capped";
    if (outcome.status !== "done") return "failed";
  }
  return "done";
};

export const runMemoryEval = async (analyse: MemoryAnalyse): Promise<MemoryEvalResult> => {
  const run1 = await analyse("learn", request(MEMORY_RUN_1));
  const dismissed = matchOf(MEMORY_RUN_1.pattern, findingsOf(run1));
  const entry = dismissed === undefined ? undefined : learnedFrom(dismissed, MEMORY_RUN_1);
  const control = await analyse("control", request(MEMORY_RUN_2));
  const run2 = await analyse("apply", request(MEMORY_RUN_2, entry === undefined ? [] : [entry]));
  const run2Findings = findingsOf(run2);
  const result = {
    status: statusOf([run1, control, run2]),
    run1Raised: dismissed !== undefined,
    learned: entry !== undefined,
    controlRaised: matchOf(MEMORY_RUN_2.pattern, findingsOf(control)) !== undefined,
    run2Raised: matchOf(MEMORY_RUN_2.pattern, run2Findings) !== undefined,
    run2Cited:
      entry !== undefined &&
      run2 !== "capped" &&
      run2.status === "done" &&
      run2.document.briefing.memoryApplied.some((ref) => ref.entryId === entry.id),
    run2BugFound: matchOf(MEMORY_RUN_2.bug, run2Findings) !== undefined,
  };
  return {
    ...result,
    pass:
      result.status === "done" &&
      result.run1Raised &&
      result.learned &&
      result.controlRaised &&
      !result.run2Raised &&
      result.run2Cited &&
      result.run2BugFound,
  };
};
