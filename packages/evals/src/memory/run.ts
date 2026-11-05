/**
 * The project-memory eval (P8-2): learn from a dismissal on one pull request, then check that the
 * next similar pull request does not raise the dismissed pattern again and cites the entry. It
 * runs the real pipeline (`analyzePullRequest` through the caller's `analyse`) and the real
 * learning rules (core `learnedEntry` and the store's `prepareMemoryEntry`); only the database is
 * left out (the store side is `packages/db` `learnFromReviewSubmission`, tested on Postgres).
 *
 * Three analyses per trial: run 1 (pr-1301, no memory), a control (pr-1302, no memory) and run 2
 * (pr-1302 with the learned entry). A live run may repeat the trial (`trials`) to report a rate.
 * The result holds booleans, fixed codes, levels, counts and seeded ids only: no code and no model
 * text. Each analysis records enough to tell why a condition failed (was the file reviewed at
 * all, did the analysis fail, what matched): the first live run recorded booleans only and could
 * not tell a miss from a file that was never reviewed (ADR 0037 §6).
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

/** What one analysis of the case did with the case's one file. Codes and counts only. */
export interface MemoryRunDiagnosis {
  readonly status: "done" | "failed" | "capped";
  /** The pipeline's failure code when `failed` (a fixed code), else null. */
  readonly failure: string | null;
  /** The file's triage level (after the rule floor), or null when it was not triaged. */
  readonly level: "critical" | "important" | "normal" | "low" | null;
  /** The file went through review (critical or important, not unanalysed). */
  readonly reviewed: boolean;
  /** The file's unanalysed reason (a fixed code), or null. */
  readonly unanalysed: string | null;
  /** Findings stored on the file. */
  readonly findings: number;
  /** Seeded ids (`P1`, `B1`, …) a stored finding matched. */
  readonly matched: readonly string[];
  /** The severity of the finding that matched the pattern, or null. */
  readonly patternSeverity: "critical" | "high" | "medium" | "low" | null;
  /** Findings a dismissal kept out, and suppressions restored as drafts (the pipeline's counts). */
  readonly suppressed: number;
  readonly restored: number;
}

/** One trial: the conditions, and what each of its three analyses did. */
export interface MemoryTrialResult {
  readonly status: "done" | "failed" | "capped";
  readonly run1Raised: boolean;
  readonly learned: boolean;
  readonly controlRaised: boolean;
  readonly run2Raised: boolean;
  readonly run2Cited: boolean;
  readonly run2BugFound: boolean;
  readonly pass: boolean;
  readonly runs: {
    readonly learn: MemoryRunDiagnosis;
    readonly control: MemoryRunDiagnosis;
    readonly apply: MemoryRunDiagnosis;
  };
}

/**
 * The eval over all trials. The conditions are aggregated so that `pass` means "every trial
 * passed": each condition that must hold holds in every trial, and `run2Raised` is true when any
 * trial raised the pattern with memory.
 */
export interface MemoryEvalResult {
  /** `done` when every analysis was stored; otherwise the first other status. */
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
  /** Every condition above holds, in every trial. */
  readonly pass: boolean;
  /** Trials that passed, of `trials.length`. */
  readonly passes: number;
  readonly trials: readonly MemoryTrialResult[];
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

const REVIEWED: ReadonlySet<string> = new Set(["critical", "important"]);

/** What one analysis did with the case file: codes, levels, counts and seeded ids only. */
export const diagnose = (
  outcome: AnalysisOutcome | "capped",
  pr: MemoryCasePr,
): MemoryRunDiagnosis => {
  const empty = {
    level: null,
    reviewed: false,
    unanalysed: null,
    findings: 0,
    matched: [],
    patternSeverity: null,
    suppressed: 0,
    restored: 0,
  } as const;
  if (outcome === "capped") return { status: "capped", failure: null, ...empty };
  const counts = {
    suppressed: outcome.stats.memorySuppressed,
    restored: outcome.stats.memoryRestored,
  };
  if (outcome.status !== "done")
    return { status: "failed", failure: outcome.code, ...empty, ...counts };
  const { document } = outcome;
  const level = document.triage.files.find((file) => file.path === pr.path)?.level ?? null;
  const unanalysed =
    document.provenance.unanalysed.find((file) => file.path === pr.path)?.reason ?? null;
  const own = document.findings.filter((finding) => finding.path === pr.path);
  const score = scoreFindings([pr.pattern, pr.bug], own);
  const patternPair = score.pairs.find((pair) => pair.seeded === pr.pattern.id);
  return {
    status: "done",
    failure: null,
    level,
    reviewed: level !== null && REVIEWED.has(level) && unanalysed === null,
    unanalysed,
    findings: own.length,
    matched: score.pairs.map((pair) => pair.seeded).sort(),
    patternSeverity:
      patternPair === undefined ? null : (own[patternPair.produced]?.severity ?? null),
    ...counts,
  };
};

const trial = async (analyse: MemoryAnalyse): Promise<MemoryTrialResult> => {
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
    runs: {
      learn: diagnose(run1, MEMORY_RUN_1),
      control: diagnose(control, MEMORY_RUN_2),
      apply: diagnose(run2, MEMORY_RUN_2),
    },
  };
};

/** At most this many trials in one run (each is three analyses). */
export const MAX_MEMORY_TRIALS = 5;

export const runMemoryEval = async (
  analyse: MemoryAnalyse,
  options: { readonly trials?: number } = {},
): Promise<MemoryEvalResult> => {
  const count = options.trials ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_MEMORY_TRIALS)
    throw new RangeError(`memory trials must be 1..${MAX_MEMORY_TRIALS}`);
  const trials: MemoryTrialResult[] = [];
  for (let i = 0; i < count; i++) {
    const result = await trial(analyse);
    trials.push(result);
    // A capped analysis means the token budget is spent: later trials could not finish either.
    if (result.status === "capped") break;
  }
  const every = (key: "run1Raised" | "learned" | "controlRaised" | "run2Cited" | "run2BugFound") =>
    trials.every((t) => t[key]);
  return {
    status: trials.find((t) => t.status !== "done")?.status ?? "done",
    run1Raised: every("run1Raised"),
    learned: every("learned"),
    controlRaised: every("controlRaised"),
    run2Raised: trials.some((t) => t.run2Raised),
    run2Cited: every("run2Cited"),
    run2BugFound: every("run2BugFound"),
    pass: trials.length === count && trials.every((t) => t.pass),
    passes: trials.filter((t) => t.pass).length,
    trials,
  };
};
