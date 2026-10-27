/**
 * The analysis pipeline (P4-3, ADR 0014): one pull request revision in, one validated analysis
 * document (or a failure code) out.
 *
 *   diff → rules pre-triage → triage (per file) → review (critical and important files only)
 *        → change map → briefing → validate/repair → outcome (the worker stores it)
 *
 * - Known facts come from the diff and the caller, never from a model (ADR 0004 §3).
 * - Every model answer is schema-validated, then integrity-checked in a document; a failing
 *   answer gets one repair round (`completeWithRepair`); a unit that still fails is recorded as
 *   such: the file becomes "AI couldn't analyse this", the change map "unavailable", and a failed
 *   briefing fails the analysis. The outcome is either a document that passed
 *   `parseAnalysisDocumentJson` whole, or a fixed failure code. Never a partial document.
 * - PR content (paths, diffs, the title) and everything a model wrote about it travel only as
 *   `untrusted` parts under Rocky-authored labels; instructions are literals (instructions.ts).
 * - Model output never triggers anything: this function has no way to act on the forge, and its
 *   outcome is data for a human (ADR 0004 §5).
 * - Incremental: a file whose unit key matches the previous analysis is reused (units.ts).
 *
 * Retryable LLM errors and cancellation are thrown (the caller's queue retries, honouring
 * `retryAfterMs`); fatal LLM errors become `llm_<kind>`. Metering (P4-5) and token budgets
 * (P4-6) attach at the `LlmRoles` the caller passes in.
 */
import {
  GeneratorRole,
  limits,
  parseAnalysisDocumentJson,
  Provenance,
  SCHEMA_VERSION,
  type AnalysisDocument,
  type Briefing,
  type ChangedFile,
  type Finding,
  type GraphUnavailable,
  type NoiseFile,
  type RiskLevel,
  type TriagedFile,
  type UnanalysedFile,
  type UnanalysedReason,
} from "@rocky-reviews/schema";
import {
  isLlmCallError,
  type LlmCompletionRole,
  type LlmFatalErrorKind,
  type LlmRoles,
  type LlmUntrustedText,
} from "../llm.js";
import type { Clock } from "../ports.js";
import { parseUnifiedDiff, type DiffFailure, type DiffFile } from "./diff.js";
import {
  BRIEFING_INSTRUCTIONS,
  GRAPH_INSTRUCTIONS,
  REVIEW_INSTRUCTIONS,
  TRIAGE_INSTRUCTIONS,
} from "./instructions.js";
import {
  BRIEFING_OUTPUT,
  GRAPH_OUTPUT,
  MAX_OUTPUT_TOKENS,
  REVIEW_OUTPUT,
  TRIAGE_OUTPUT,
  type BriefingAnswer,
  type GraphAnswer,
  type ReviewFinding,
} from "./outputs.js";
import { completeWithRepair, type CallObserver, type UnitFailure } from "./repair.js";
import { applyFloor, NOISE_SUMMARIES, preTriage, type FloorLevel } from "./rules.js";
import {
  belowUnanalysedRuleFloor,
  findingsFloor,
  maxRisk,
  unreviewedFloor,
  type UnreviewedRisk,
} from "./verdict.js";
import {
  reusableUnit,
  unitKey,
  type FileUnit,
  type PreviousAnalysis,
  type Sha256Hex,
} from "./units.js";
import {
  checkReview,
  checkTriage,
  partitionIssues,
  type ProvenanceBase,
  type UnitCheck,
} from "./validate.js";

/** Characters of diff sent to the change-map call; a larger PR gets `too-large` (P4-6). */
export const GRAPH_MAX_INPUT_CHARS = 400_000;
export const DEFAULT_CONCURRENCY = 4;

export interface AnalysisRequest {
  readonly repo: { readonly owner: string; readonly name: string };
  /** `title` is PR content: it reaches a model only as an untrusted part. */
  readonly pullRequest: { readonly number: number; readonly title: string };
  readonly base: { readonly sha: string; readonly ref?: string };
  readonly head: { readonly sha: string; readonly ref?: string };
  /** The revision's unified diff, decoded. Untrusted content: never logged. */
  readonly diff: string;
  /** The reader cut the diff: the file list is incomplete, so nothing is analysed. */
  readonly diffTruncated: boolean;
  /** The pull request's last good analysis, loaded inside the org's tenant transaction. */
  readonly previous?: PreviousAnalysis | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AnalysisDeps {
  readonly llm: LlmRoles;
  readonly clock: Clock;
  readonly sha256Hex: Sha256Hex;
  readonly generator: { readonly name: string; readonly version?: string };
  /**
   * Mixed into every unit key: the role configuration (provider, model, effort) behind triage
   * and review, so a model change re-analyses every file. The worker derives it from its config.
   */
  readonly unitKeySalt?: string;
  /** Unit calls in flight at once (default 4). The org-wide cap is P4-6's. */
  readonly concurrency?: number;
}

/** Fixed codes: stored as `analyses.error_code` and logged. */
export type AnalysisFailureCode =
  | DiffFailure
  | "diff_truncated"
  | "diff_empty"
  | "invalid_request"
  | "briefing_failed"
  | "document_invalid"
  | `llm_${LlmFatalErrorKind}`
  | "internal_error";

export type AnalysisStage = "triage" | "review" | "graph" | "briefing";

/** Counts only: safe to log. */
export interface AnalysisStats {
  files: number;
  noise: number;
  /** Files whose previous analysis was reused. */
  reused: number;
  /** Files sent to the triage model in this run. */
  analysed: number;
  /** Files sent to the review model in this run. */
  reviewed: number;
  unanalysed: number;
  findings: number;
  calls: Record<AnalysisStage, number>;
  repairs: number;
  graph: "drawn" | "unavailable" | "none";
}

export type AnalysisOutcome =
  | {
      readonly status: "done";
      readonly document: AnalysisDocument;
      /** What the next push may reuse: one unit per file analysed (fresh or reused). */
      readonly units: readonly FileUnit[];
      readonly stats: AnalysisStats;
    }
  | {
      readonly status: "failed";
      readonly code: AnalysisFailureCode;
      readonly stats: AnalysisStats;
    };

// ---------------------------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<Finding["severity"], number>> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};
const RISK_RANK: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Fixed text for a critical or important file with only deleted lines (review round 1, Fix B):
 * findings sit on new-side lines, so there is nothing the review can point at.
 */
export const DELETION_ONLY_DETAIL =
  "Only deleted lines: Rocky reviews new-side lines, so this file was not reviewed. Read the deletion by hand.";

const REVIEWED_LEVELS: ReadonlySet<TriagedFile["level"]> = new Set(["critical", "important"]);

const UNANALYSED_REASON: Readonly<Record<UnitFailure, UnanalysedReason>> = {
  refused: "analysis-failed",
  truncated: "analysis-failed",
  invalid: "analysis-failed",
  too_large: "too-large",
  timeout: "timeout",
};

/** A briefing no other part's check can trip over (verdict and estimate at their maximum). */
const STUB_BRIEFING: Briefing = {
  summary: "Pending.",
  verdict: { level: "critical", reason: "Pending." },
  estimatedReviewMinutes: limits.MAX_REVIEW_MINUTES,
  reviewPath: [],
  checkedOk: [],
  memoryApplied: [],
};

class Failed extends Error {
  constructor(readonly code: AnalysisFailureCode) {
    super(code);
  }
}

const facts = (file: DiffFile): ChangedFile => ({
  path: file.path,
  ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
  hunks: [...file.hunks],
});

const hasNewSide = (file: DiffFile): boolean => file.hunks.some((hunk) => hunk.newLines > 0);

/** Runs `task` over `items`, at most `limit` at a time; the first failure aborts the rest. */
const mapBounded = async <T, R>(
  items: readonly T[],
  limit: number,
  outer: AbortSignal | undefined,
  task: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> => {
  const controller = new AbortController();
  const signal =
    outer === undefined ? controller.signal : AbortSignal.any([outer, controller.signal]);
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index] as T, signal);
      } catch (error) {
        failure ??= { error };
        controller.abort();
      }
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  if (failure !== undefined) throw failure.error;
  return results;
};

interface UnitOutcome extends UnreviewedRisk {
  readonly path: string;
  readonly triage?: TriagedFile;
  readonly findings: readonly ReviewFinding[];
  readonly unanalysed?: UnanalysedReason;
  /** Fixed, pipeline-written text only. */
  readonly detail?: string;
  readonly unit?: FileUnit;
}

/** Keeps the PR estimate within the document's cap: per-file minutes are scaled down to fit. */
const fitMinutes = (files: readonly TriagedFile[]): TriagedFile[] => {
  const sum = files.reduce((total, file) => total + file.reviewMinutes, 0);
  if (sum <= limits.MAX_REVIEW_MINUTES) return [...files];
  return files.map((file) => ({
    ...file,
    reviewMinutes: Math.floor((file.reviewMinutes * limits.MAX_REVIEW_MINUTES) / sum),
  }));
};

// ---------------------------------------------------------------------------------------------

const run = async (
  request: AnalysisRequest,
  deps: AnalysisDeps,
  stats: AnalysisStats,
): Promise<AnalysisOutcome> => {
  const { llm } = deps;
  const signal = request.signal;
  if (request.diffTruncated) throw new Failed("diff_truncated");
  const parsed = parseUnifiedDiff(request.diff);
  if (!parsed.ok) throw new Failed(parsed.code);
  const files = parsed.files;
  if (files.length === 0) throw new Failed("diff_empty");
  stats.files = files.length;

  const base: ProvenanceBase = {
    repo: { owner: request.repo.owner, name: request.repo.name },
    pullRequest: { number: request.pullRequest.number },
    base: { ...request.base },
    head: { ...request.head },
    generatedAt: deps.clock.now().toISOString(),
    generator: {
      name: deps.generator.name,
      ...(deps.generator.version === undefined ? {} : { version: deps.generator.version }),
      roles: [],
    },
  };
  if (!Provenance.safeParse({ ...base, files: [], unanalysed: [] }).success) {
    throw new Failed("invalid_request");
  }

  const models = new Map<LlmCompletionRole, { provider: string; model: string }>();
  const observe = (stage: AnalysisStage): CallObserver => ({
    onResult: (role, result, repair) => {
      stats.calls[stage]++;
      if (repair) stats.repairs++;
      if (!models.has(role)) models.set(role, { provider: result.provider, model: result.model });
    },
  });

  // --- Rules pre-triage --------------------------------------------------------------------
  const noise: NoiseFile[] = [];
  const unanalysed: UnanalysedFile[] = [];
  /** Files that were not reviewed, with what is known of their risk (Fix A). */
  const unreviewed: UnreviewedRisk[] = [];
  const work: { file: DiffFile; floor: FloorLevel | undefined }[] = [];
  for (const file of files) {
    const rule = preTriage(file.path);
    if (rule.kind === "noise") {
      noise.push({ path: file.path, summary: NOISE_SUMMARIES[rule.rule] });
      continue;
    }
    if (file.binary || file.tooLarge) {
      unanalysed.push({ path: file.path, reason: file.binary ? "binary" : "too-large" });
      unreviewed.push({ ruleFloor: rule.floor });
    } else {
      work.push({ file, floor: rule.floor });
    }
  }
  stats.noise = noise.length;

  // --- Triage and review, per file ---------------------------------------------------------
  const salt = deps.unitKeySalt ?? "";
  const analyseFile = async (
    item: (typeof work)[number],
    unitSignal: AbortSignal,
  ): Promise<UnitOutcome> => {
    const { file, floor } = item;
    const fileFacts = facts(file);
    const key = unitKey(deps.sha256Hex, salt, file);
    const reused = reusableUnit(request.previous, fileFacts, key);
    if (reused !== undefined) {
      stats.reused++;
      return {
        path: file.path,
        triage: applyFloor(reused.triage, floor),
        findings: reused.findings,
        unit: { path: file.path, key, reviewMinutes: reused.triage.reviewMinutes },
      };
    }
    const context = { provenance: base, file: fileFacts, newFileLines: file.newFileLines };
    const fileParts: LlmUntrustedText[] = [
      { label: "file_path", text: file.path },
      { label: "file_status", text: file.status },
      { label: "diff", text: file.patch },
    ];
    stats.analysed++;
    const triaged = await completeWithRepair(
      llm,
      {
        role: "triage",
        instructions: TRIAGE_INSTRUCTIONS,
        untrusted: fileParts,
        output: TRIAGE_OUTPUT,
        maxOutputTokens: MAX_OUTPUT_TOKENS.triage,
        check: (answer) => checkTriage(context, answer),
      },
      observe("triage"),
      unitSignal,
    );
    if (!triaged.ok) {
      return {
        path: file.path,
        findings: [],
        unanalysed: UNANALYSED_REASON[triaged.reason],
        ruleFloor: floor,
      };
    }
    const triage = applyFloor({ ...triaged.value, path: file.path }, floor);
    // The unit keeps the model's minutes; the document's may be scaled to fit (Fix E).
    const unit = { path: file.path, key, reviewMinutes: triaged.value.reviewMinutes };
    if (!REVIEWED_LEVELS.has(triage.level)) {
      return { path: file.path, triage, findings: [], unit };
    }
    if (!hasNewSide(file)) {
      // Nothing to review on the new side: it must not look reviewed and clean (Fix B).
      return {
        path: file.path,
        findings: [],
        unanalysed: "analysis-failed",
        detail: DELETION_ONLY_DETAIL,
        ruleFloor: floor,
        level: triage.level,
      };
    }
    stats.reviewed++;
    const reviewed = await completeWithRepair(
      llm,
      {
        role: "review",
        instructions: REVIEW_INSTRUCTIONS,
        untrusted: fileParts.filter((part) => part.label !== "file_status"),
        output: REVIEW_OUTPUT,
        maxOutputTokens: MAX_OUTPUT_TOKENS.review,
        check: (answer) => checkReview(context, triage, answer.findings),
      },
      observe("review"),
      unitSignal,
    );
    if (!reviewed.ok) {
      // A file that should have been reviewed and was not must not look reviewed and clean, and
      // its risk still counts toward the verdict (Fix A).
      return {
        path: file.path,
        findings: [],
        unanalysed: UNANALYSED_REASON[reviewed.reason],
        ruleFloor: floor,
        level: triage.level,
      };
    }
    return { path: file.path, triage, findings: reviewed.value.findings, unit };
  };
  const outcomes = await mapBounded(
    work,
    deps.concurrency ?? DEFAULT_CONCURRENCY,
    signal,
    analyseFile,
  );

  const order = new Map(files.map((file, index) => [file.path, index] as const));
  const triaged: TriagedFile[] = [];
  const raw: { finding: ReviewFinding; path: string; seq: number }[] = [];
  const units: FileUnit[] = [];
  for (const outcome of outcomes) {
    if (outcome.unanalysed !== undefined) {
      unanalysed.push({
        path: outcome.path,
        reason: outcome.unanalysed,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      });
      unreviewed.push(outcome);
      continue;
    }
    if (outcome.triage !== undefined) triaged.push(outcome.triage);
    if (outcome.unit !== undefined) units.push(outcome.unit);
    for (const finding of outcome.findings)
      raw.push({ finding, path: outcome.path, seq: raw.length });
  }
  const byFileOrder = (a: { path: string }, b: { path: string }) =>
    (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0);
  unanalysed.sort(byFileOrder);
  stats.unanalysed = unanalysed.length;

  // Ids by severity, then file order, then line: stable and independent of call timing.
  raw.sort(
    (a, b) =>
      SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity] ||
      byFileOrder(a, b) ||
      a.finding.range.start - b.finding.range.start ||
      a.seq - b.seq,
  );
  const findings: Finding[] = raw.map(({ finding, path }, index) => ({
    ...finding,
    id: `F${index + 1}`,
    path,
    memory: [],
  }));
  stats.findings = findings.length;
  const triageFiles = fitMinutes(triaged.sort(byFileOrder));

  const fileLines = Object.fromEntries(
    files.flatMap((file) =>
      file.newFileLines === undefined ? [] : [[file.path, file.newFileLines] as const],
    ),
  );
  const assemble = (
    briefing: Briefing,
    graph: GraphAnswer | undefined,
    graphUnavailable: GraphUnavailable | undefined,
  ) =>
    parseAnalysisDocumentJson(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        provenance: {
          ...base,
          generator: { ...base.generator, roles: generatorRoles(models, request.previous) },
          files: files.map(facts),
          unanalysed,
          ...(graphUnavailable === undefined ? {} : { graphUnavailable }),
        },
        briefing,
        triage: { files: triageFiles, noise },
        findings,
        ...(graph === undefined ? {} : { graph }),
      }),
      { newFileLines: fileLines },
    );

  /** Issues the document reports against one part, or `unrepairable` for any other issue. */
  const checkPart = (
    part: "graph" | "briefing",
    briefing: Briefing,
    graph: GraphAnswer | undefined,
    graphUnavailable: GraphUnavailable | undefined,
  ): UnitCheck => {
    const result = assemble(briefing, graph, graphUnavailable);
    if (result.ok) return [];
    const split = partitionIssues(result.error.issues);
    const otherPart = part === "graph" ? split.briefing : split.graph;
    if (split.other > 0 || otherPart.length > 0) return "unrepairable";
    return split[part];
  };

  // Units were checked one by one (fresh) or not at all (reused): check them together before
  // spending a call on the change map or the briefing. A failure here is not a model's to fix.
  const together = assemble(STUB_BRIEFING, undefined, undefined);
  if (!together.ok) throw new Failed("document_invalid");

  // --- Change map ----------------------------------------------------------------------------
  let graph: GraphAnswer | undefined;
  let graphUnavailable: GraphUnavailable | undefined;
  if (triageFiles.length > 0) {
    const mapped = files.filter((file) => triageFiles.some((t) => t.path === file.path));
    const parts: LlmUntrustedText[] = [
      { label: "pr_title", text: request.pullRequest.title },
      ...mapped.flatMap((file, index) => [
        { label: `file.${index}.path`, text: file.path },
        { label: `file.${index}.diff`, text: file.patch },
      ]),
    ];
    const size = parts.reduce((total, part) => total + part.text.length, 0);
    if (size > GRAPH_MAX_INPUT_CHARS) {
      graphUnavailable = { reason: "too-large" };
    } else {
      const drawn = await completeWithRepair(
        llm,
        {
          role: "graph",
          instructions: GRAPH_INSTRUCTIONS,
          untrusted: parts,
          output: GRAPH_OUTPUT,
          maxOutputTokens: MAX_OUTPUT_TOKENS.graph,
          check: (answer) => checkPart("graph", STUB_BRIEFING, answer, undefined),
        },
        observe("graph"),
        signal,
      );
      if (drawn.ok) graph = drawn.value;
      else
        graphUnavailable = {
          reason:
            drawn.reason === "too_large"
              ? "too-large"
              : drawn.reason === "timeout"
                ? "timeout"
                : "analysis-failed",
        };
    }
  }
  stats.graph =
    graph !== undefined ? "drawn" : graphUnavailable !== undefined ? "unavailable" : "none";

  // --- Briefing ------------------------------------------------------------------------------
  const floor = maxRisk(findingsFloor(findings), unreviewedFloor(unreviewed));
  const minutes = Math.max(
    limits.MIN_REVIEW_MINUTES,
    triageFiles.reduce((total, file) => total + file.reviewMinutes, 0),
  );
  const toBriefing = (answer: BriefingAnswer): Briefing => ({
    summary: answer.summary,
    verdict: {
      // The verdict never sits below what the findings say, nor below the risk of a file that
      // was not reviewed, whatever the model answered (Fix A).
      level: RISK_RANK[answer.verdict.level] >= RISK_RANK[floor] ? answer.verdict.level : floor,
      reason: answer.verdict.reason,
    },
    estimatedReviewMinutes: minutes,
    reviewPath: answer.reviewPath,
    checkedOk: answer.checkedOk,
    memoryApplied: [],
  });
  const briefed = await completeWithRepair(
    llm,
    {
      role: "review",
      instructions: BRIEFING_INSTRUCTIONS,
      untrusted: [
        { label: "pr_title", text: request.pullRequest.title },
        {
          label: "triage",
          text: JSON.stringify(
            triageFiles.map((file) => ({
              path: file.path,
              level: file.level,
              score: file.score,
              whatChanged: file.whatChanged,
              reason: file.reason,
            })),
          ),
        },
        {
          label: "findings",
          text: JSON.stringify(
            findings.map((finding) => ({
              id: finding.id,
              path: finding.path,
              severity: finding.severity,
              range: finding.range,
              title: finding.title,
            })),
          ),
        },
        { label: "noise", text: JSON.stringify(noise.map((file) => file.path)) },
        {
          label: "unanalysed",
          text: JSON.stringify(
            unanalysed.map((file) => ({ path: file.path, reason: file.reason })),
          ),
        },
      ],
      output: BRIEFING_OUTPUT,
      maxOutputTokens: MAX_OUTPUT_TOKENS.briefing,
      check: (answer) => checkPart("briefing", toBriefing(answer), graph, graphUnavailable),
    },
    observe("briefing"),
    signal,
  );
  if (!briefed.ok) throw new Failed("briefing_failed");

  // --- Final validation: the whole document, as it will be stored ----------------------------
  const final = assemble(toBriefing(briefed.value), graph, graphUnavailable);
  if (!final.ok || belowUnanalysedRuleFloor(final.value)) throw new Failed("document_invalid");
  return { status: "done", document: final.value, units, stats };
};

/** Who produced the parts: this run's calls first, the reused analysis's for roles not called. */
const generatorRoles = (
  models: ReadonlyMap<LlmCompletionRole, { provider: string; model: string }>,
  previous: PreviousAnalysis | undefined,
): GeneratorRole[] => {
  const roles: GeneratorRole[] = [];
  for (const role of ["triage", "review", "graph"] as const) {
    const seen = models.get(role);
    const candidate =
      seen === undefined
        ? previous?.document.provenance.generator.roles.find((entry) => entry.role === role)
        : { role, provider: seen.provider, model: seen.model };
    if (candidate !== undefined && GeneratorRole.safeParse(candidate).success)
      roles.push(candidate);
  }
  return roles;
};

const newStats = (): AnalysisStats => ({
  files: 0,
  noise: 0,
  reused: 0,
  analysed: 0,
  reviewed: 0,
  unanalysed: 0,
  findings: 0,
  calls: { triage: 0, review: 0, graph: 0, briefing: 0 },
  repairs: 0,
  graph: "none",
});

export const analyzePullRequest = async (
  request: AnalysisRequest,
  deps: AnalysisDeps,
): Promise<AnalysisOutcome> => {
  const stats = newStats();
  try {
    return await run(request, deps, stats);
  } catch (error) {
    if (error instanceof Failed) return { status: "failed", code: error.code, stats };
    if (isLlmCallError(error)) {
      if (error.retryable || error.kind === "cancelled") throw error;
      return { status: "failed", code: `llm_${error.kind as LlmFatalErrorKind}`, stats };
    }
    // Anything else is a bug or a broken port; it carries no detail out (it could quote content).
    return { status: "failed", code: "internal_error", stats };
  }
};
