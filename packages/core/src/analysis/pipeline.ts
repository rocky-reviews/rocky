/**
 * The analysis pipeline (P4-3, ADR 0014): one pull request revision in, one validated analysis
 * document (or a failure code) out.
 *
 *   diff → rules pre-triage → triage (per file) → review (critical and important files only)
 *        → change map → its flows → its walkthrough → briefing → validate/repair
 *        → outcome (the worker stores it)
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
  requiredSchemaVersion,
  type AnalysisDocument,
  type Briefing,
  type BriefingUnavailable,
  type ChangedFile,
  type Finding,
  type GraphUnavailable,
  type MapSectionUnavailable,
  type MapSectionUnavailableReason,
  type NoiseFile,
  type RiskLevel,
  type TriagedFile,
  type UnanalysedFile,
  type UnanalysedReason,
  type Walkthrough,
} from "@rocky-reviews/schema";
import {
  isLlmCallError,
  type LlmCompletionRole,
  type LlmFatalErrorKind,
  type LlmRoles,
  joinInstructions,
  type LlmUntrustedText,
  type LlmUsage,
} from "../llm.js";
import type { Clock } from "../ports.js";
import { parseUnifiedDiff, type DiffFailure, type DiffFile } from "./diff.js";
import {
  BRIEFING_INSTRUCTIONS,
  FLOWS_INSTRUCTIONS,
  GRAPH_INSTRUCTIONS,
  REVIEW_INSTRUCTIONS,
  REVIEW_MEMORY_INSTRUCTIONS,
  TRIAGE_INSTRUCTIONS,
  WALKTHROUGH_INSTRUCTIONS,
} from "./instructions.js";
import {
  memoryKeyOf,
  memoryPart,
  memoryRefOf,
  resolveHandles,
  selectMemory,
  usableMemory,
  type AnalysisMemoryEntry,
  type SelectedMemory,
} from "./memory.js";
import {
  BRIEFING_OUTPUT,
  FLOWS_OUTPUT,
  GRAPH_OUTPUT,
  MAX_OUTPUT_TOKENS,
  REVIEW_MEMORY_OUTPUT,
  REVIEW_OUTPUT,
  TRIAGE_OUTPUT,
  WALKTHROUGH_OUTPUT,
  type BriefingAnswer,
  type FlowsAnswer,
  type GraphAnswer,
  type ReviewFinding,
} from "./outputs.js";
import { instructionLeaks } from "./leak.js";
import { changeMapScope, GRAPH_MAX_INPUT_CHARS } from "./map-scope.js";
import { completeWithRepair, type CallObserver, type UnitFailure } from "./repair.js";
import { applyFloor, NOISE_SUMMARIES, preTriage, type FloorLevel } from "./rules.js";
import {
  belowVerdictFloor,
  findingsFloor,
  maxRisk,
  triageFloor,
  unreviewedFloor,
  type UnreviewedRisk,
} from "./verdict.js";
import {
  FileUnits,
  reusableUnit,
  unitKey,
  type FileUnit,
  type PreviousAnalysis,
  type Sha256Hex,
} from "./units.js";
import {
  checkReview,
  checkTriage,
  graphIds,
  partitionIssues,
  rebaseFlowIssues,
  rebaseStepIssues,
  stripFlowRefs,
  stripGraphRefs,
  stripWalkthroughRefs,
  toWalkthrough,
  type DocumentPart,
  type MappedFiles,
  type ProvenanceBase,
  type UnitCheck,
} from "./validate.js";

export { GRAPH_MAX_INPUT_CHARS };
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
  /**
   * The repository's current project-memory entries (P8-2), loaded inside the org's tenant
   * transaction for this analysis's repository only, newest first. Untrusted text: each review
   * call gets the relevant ones as an untrusted part (`memory.ts`), never as instructions.
   */
  readonly memory?: readonly AnalysisMemoryEntry[] | undefined;
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
  | "document_invalid"
  | `llm_${LlmFatalErrorKind}`
  | "internal_error";

export type AnalysisStage = "triage" | "review" | "graph" | "flows" | "walkthrough" | "briefing";

/**
 * What became of a map section drawn by its own call (H4-7): `drawn`, `skipped` when there was
 * no map to draw it over (no call), or the fixed reason also written to the document.
 */
export type MapSectionStatus = "drawn" | "skipped" | MapSectionUnavailableReason;

/**
 * Provider-reported tokens of one stage, summed over its calls (repair rounds included). The
 * key names are ones the log redactor keeps (`inputTokens` and `outputTokens` are allowlisted;
 * `tokens`, `output` and `*Tokens` as a bare suffix are not), so the counts reach the log.
 */
export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

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
  /** Graph file references outside the mapped set, dropped from the stored map (H4-5; flow steps included, H4-7). */
  graphFilesStripped: number;
  /** Graph line ranges outside the file's changed lines, dropped from the stored map (H4-5; flow steps included, H4-7). */
  graphRangesStripped: number;
  flows: MapSectionStatus;
  walkthrough: MapSectionStatus;
  /** Flow participants, messages and whole flows dropped for naming an unknown node (H4-7). */
  flowsStripped: number;
  /** Walkthrough focus ids and steps dropped for naming an unknown node or edge (H4-7). */
  walkthroughStripped: number;
  /** Token counts per stage, as the provider reported them (H4-7). */
  usageByStage: Record<AnalysisStage, StageUsage>;
  /** Project-memory entries the request carried that the analysis could use (P8-2). */
  memoryEntries: number;
  /** Entries refused before any use: malformed, or carrying a canary or prompt text (P8-2). */
  memoryDropped: number;
  /** Review calls sent with project memory (P8-2). */
  memoryReviews: number;
  /** Entries cited in the stored document (`briefing.memoryApplied`) (P8-2). */
  memoryCited: number;
  /** Citations of a handle the call was not given, dropped (P8-2). */
  memoryStripped: number;
}

/**
 * Where a failure was raised, for the log (H4-4). Content-free by construction: `origin` is a
 * fixed tag written in Rocky's source (an adapter's `LlmCallError.origin`, or `pipeline` for a
 * failure nothing classified) and `errorClass` is the thrown value's class name, checked
 * against an identifier shape; a message, a body or a value never gets in.
 */
export interface AnalysisDiagnostic {
  readonly origin: string;
  readonly errorClass?: string;
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
      readonly diagnostic?: AnalysisDiagnostic;
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
/** Fixed verdict reasons for a level the pipeline raised (round 2, N4). */
export const RAISED_FOR_FINDINGS =
  "Rocky raised this level to match the severity of the draft findings.";
export const RAISED_FOR_UNREVIEWED =
  "Rocky raised this level: files that carry risk were not reviewed by the AI. See the files it could not analyse.";
/** A file triaged critical floors the verdict at high (P4-4 review round 1, item 2). */
export const RAISED_FOR_TRIAGE =
  "Rocky raised this level: a file triaged critical needs a careful reviewer, whatever the drafts say.";

/**
 * Rocky's own briefing for when the AI briefing fails after its repair round (P4-4 review round 1,
 * item 1): the analysis is stored anyway, with `provenance.briefingUnavailable`, so a PR author who
 * can make the briefing fail cannot make the findings and the verdict disappear with it.
 */
export const FALLBACK_SUMMARY =
  "Rocky could not produce an AI briefing for this pull request. The level below comes from Rocky's rules, the triage and the draft findings. Read the files in the order shown.";
export const FALLBACK_REASON =
  "Set by Rocky from its rules, the triage and the draft findings, because the AI briefing was unavailable.";

export const DELETION_ONLY_DETAIL =
  "Only deleted lines: Rocky reviews new-side lines, so this file was not reviewed. Read the deletion by hand.";

/** The review's instructions when the file has project memory to apply (P8-2). */
const REVIEW_WITH_MEMORY = joinInstructions([REVIEW_INSTRUCTIONS, REVIEW_MEMORY_INSTRUCTIONS]);

const REVIEWED_LEVELS: ReadonlySet<TriagedFile["level"]> = new Set(["critical", "important"]);
const LEVEL_RANK: Readonly<Record<TriagedFile["level"], number>> = {
  critical: 3,
  important: 2,
  normal: 1,
  low: 0,
};

const UNANALYSED_REASON: Readonly<Record<UnitFailure, UnanalysedReason>> = {
  refused: "analysis-failed",
  truncated: "analysis-failed",
  invalid: "analysis-failed",
  too_large: "too-large",
  timeout: "timeout",
};

/** The same mapping for a whole-PR part: the map, its sections, the briefing. */
const PART_REASON: Readonly<Record<UnitFailure, MapSectionUnavailableReason>> = {
  refused: "analysis-failed",
  truncated: "analysis-failed",
  invalid: "analysis-failed",
  too_large: "too-large",
  timeout: "timeout",
};

/** The map as it is stored: the graph call's answer with the sections its own calls drew (H4-7). */
type StoredGraph = GraphAnswer & {
  readonly flows?: FlowsAnswer["flows"];
  readonly walkthrough?: Walkthrough;
};

/**
 * What the flows and walkthrough calls are told about the drawn map: ids, labels and kinds, so
 * they can name its nodes and edges, and nothing a card says beyond that (summaries and file
 * references stay out: fewer tokens, and nothing to echo). Model-written text, so it travels as
 * an untrusted part like the diff it describes.
 */
const graphOutline = (graph: GraphAnswer) => ({
  lanes: graph.lanes.map(({ id, label }) => ({ id, label })),
  nodes: graph.nodes.map(({ id, label, kind, lane, subtitle }) => ({
    id,
    label,
    kind,
    lane,
    ...(subtitle === undefined ? {} : { subtitle }),
  })),
  edges: graph.edges.map(({ id, from, to, kind, label }) => ({
    id,
    from,
    to,
    kind,
    ...(label === undefined ? {} : { label }),
  })),
});

const flowsOutline = (flows: FlowsAnswer["flows"]) =>
  flows.map((flow) => ({
    id: flow.id,
    title: flow.title,
    participants: flow.participants.map((participant) => participant.node),
    messages: flow.messages.map(({ id, from, to, label, kind }) => ({ id, from, to, label, kind })),
  }));

/** A cited finding as the document's checks see it: the handles are not part of a finding. */
const withoutCitations = (
  finding: ReviewFinding & { readonly memory: readonly string[] },
): ReviewFinding => {
  const copy: Record<string, unknown> = { ...finding };
  delete copy["memory"];
  return copy as ReviewFinding;
};

const DOCUMENT_PARTS: readonly DocumentPart[] = ["graph", "flows", "walkthrough", "briefing"];

const addUsage = (into: StageUsage, usage: LlmUsage | undefined): void => {
  if (usage === undefined) return;
  into.inputTokens += usage.inputTokens;
  into.outputTokens += usage.outputTokens;
  into.cacheRead += usage.cacheReadInputTokens;
  into.cacheWrite += usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens;
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
  /** The file went through review and came back valid (fresh or reused). */
  readonly reviewed?: boolean;
  readonly triage?: TriagedFile;
  readonly findings: readonly ReviewFinding[];
  readonly unanalysed?: UnanalysedReason;
  /** Fixed, pipeline-written text only. */
  readonly detail?: string;
  readonly unit?: FileUnit;
  /**
   * Project memory the unit cited, as stored entry ids (P8-2): per finding (same order as
   * `findings`) and applied without a finding.
   */
  readonly memory?: UnitMemory;
}

interface UnitMemory {
  readonly findings: readonly (readonly string[])[];
  readonly applied: readonly string[];
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
  const memory = usableMemory(request.memory);
  stats.memoryEntries = memory.entries.length;
  stats.memoryDropped = memory.dropped;
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
      // Counts only: every attempt the provider reported, or the answering one.
      const usage = stats.usageByStage[stage];
      if (result.attempts === undefined) addUsage(usage, result.usage);
      else for (const attempt of result.attempts) addUsage(usage, attempt.usage);
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
  // Units of another shape (an older `file_units`, a caller's mistake) are not reused.
  const previous =
    request.previous !== undefined && FileUnits.safeParse(request.previous.units).success
      ? request.previous
      : undefined;
  /**
   * One file's review. Without memory it is the review it always was; with memory (P8-2) the
   * entries go in their own untrusted part, the instructions gain the memory paragraph (a
   * literal), and the answer cites handles, resolved here against this call's selection: a
   * handle the call was not given is dropped and counted, never stored.
   */
  const reviewFile = async (
    parts: readonly LlmUntrustedText[],
    selection: readonly SelectedMemory[],
    check: (findings: readonly ReviewFinding[]) => ReturnType<typeof checkReview>,
    unitSignal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: { findings: ReviewFinding[]; memory: UnitMemory } }
    | { readonly ok: false; readonly reason: UnitFailure }
  > => {
    if (selection.length === 0) {
      const plain = await completeWithRepair(
        llm,
        {
          role: "review",
          instructions: REVIEW_INSTRUCTIONS,
          untrusted: parts,
          output: REVIEW_OUTPUT,
          maxOutputTokens: MAX_OUTPUT_TOKENS.review,
          check: (answer) => check(answer.findings),
        },
        observe("review"),
        unitSignal,
      );
      return plain.ok
        ? {
            ok: true,
            value: {
              findings: plain.value.findings,
              memory: { findings: plain.value.findings.map(() => []), applied: [] },
            },
          }
        : plain;
    }
    stats.memoryReviews++;
    const cited = await completeWithRepair(
      llm,
      {
        role: "review",
        instructions: REVIEW_WITH_MEMORY,
        untrusted: [...parts, memoryPart(selection)],
        output: REVIEW_MEMORY_OUTPUT,
        maxOutputTokens: MAX_OUTPUT_TOKENS.review,
        check: (answer) => check(answer.findings.map(withoutCitations)),
      },
      observe("review"),
      unitSignal,
    );
    if (!cited.ok) return cited;
    const resolve = (handles: readonly string[]) => {
      const { ids, stripped } = resolveHandles(selection, handles);
      stats.memoryStripped += stripped;
      return ids;
    };
    return {
      ok: true,
      value: {
        findings: cited.value.findings.map(withoutCitations),
        memory: {
          findings: cited.value.findings.map((finding) => resolve(finding.memory)),
          applied: resolve(cited.value.memoryApplied),
        },
      },
    };
  };

  const analyseFile = async (
    item: (typeof work)[number],
    unitSignal: AbortSignal,
  ): Promise<UnitOutcome> => {
    const { file, floor } = item;
    const fileFacts = facts(file);
    const selection = selectMemory(memory.entries, file.path);
    const key = unitKey(deps.sha256Hex, salt, file, memoryKeyOf(selection));
    /** Ids of this file's selection only: a citation outside it is never kept. */
    const offered = new Set(selection.map(({ entry }) => entry.id));
    const keep = (ids: readonly string[]) => ids.filter((id) => offered.has(id));
    const fileParts: LlmUntrustedText[] = [
      { label: "file_path", text: file.path },
      { label: "file_status", text: file.status },
      { label: "diff", text: file.patch },
    ];
    const reused = reusableUnit(previous, fileFacts, key);
    // A reused unit that carries prompt text is analysed again rather than failing the whole
    // document at the final check (P4-4 review round 1, N5).
    if (reused !== undefined && instructionLeaks(reused, fileParts).length === 0) {
      stats.reused++;
      const triage = applyFloor(reused.triage, floor);
      const applied = keep(reused.memory.applied);
      return {
        path: file.path,
        triage,
        findings: reused.findings,
        reviewed: REVIEWED_LEVELS.has(triage.level) && hasNewSide(file),
        ruleFloor: floor,
        unit: {
          path: file.path,
          key,
          reviewMinutes: reused.triage.reviewMinutes,
          ...(applied.length === 0 ? {} : { memoryApplied: applied }),
        },
        memory: { findings: reused.memory.findings.map(keep), applied },
      };
    }
    const context = { provenance: base, file: fileFacts, newFileLines: file.newFileLines };
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
    if (!hasNewSide(file) && file.deletions > 0) {
      // Only deleted lines: nothing to review on the new side, and it must not look reviewed and
      // clean (Fix B).
      return {
        path: file.path,
        findings: [],
        unanalysed: "analysis-failed",
        detail: DELETION_ONLY_DETAIL,
        ruleFloor: floor,
        level: triage.level,
      };
    }
    if (!hasNewSide(file)) {
      // No hunks at all (a pure rename or copy, a mode change, an empty file): there is no line
      // to review, so it stays triaged (review round 2, SF1).
      return { path: file.path, triage, findings: [], unit };
    }
    stats.reviewed++;
    const reviewed = await reviewFile(
      fileParts.filter((part) => part.label !== "file_status"),
      selection,
      (findings) => checkReview(context, triage, findings),
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
    const { applied } = reviewed.value.memory;
    return {
      path: file.path,
      triage,
      findings: reviewed.value.findings,
      reviewed: true,
      ruleFloor: floor,
      unit: applied.length === 0 ? unit : { ...unit, memoryApplied: [...applied] },
      memory: reviewed.value.memory,
    };
  };
  const outcomes = await mapBounded(
    work,
    deps.concurrency ?? DEFAULT_CONCURRENCY,
    signal,
    analyseFile,
  );

  const order = new Map(files.map((file, index) => [file.path, index] as const));
  const triaged: TriagedFile[] = [];
  const raw: {
    finding: ReviewFinding;
    path: string;
    seq: number;
    memory: readonly string[];
  }[] = [];
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
    for (const [index, finding] of outcome.findings.entries())
      raw.push({
        finding,
        path: outcome.path,
        seq: raw.length,
        memory: outcome.memory?.findings[index] ?? [],
      });
  }
  const byFileOrder = (a: { path: string }, b: { path: string }) =>
    (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0);
  // Risky files the AI reviewed and drafted nothing for (ADR 0015 R1): a model steered by the
  // file's own content can say "nothing here", so the reviewer is told to read them by hand.
  const readByHand = outcomes
    .filter(
      (outcome) =>
        outcome.unanalysed === undefined &&
        outcome.reviewed === true &&
        outcome.findings.length === 0 &&
        (outcome.ruleFloor !== undefined || outcome.triage?.level === "critical"),
    )
    .map((outcome) => ({ path: outcome.path }))
    .sort(byFileOrder);
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
  // Project memory cited anywhere (P8-2): each finding's refs first (in finding order), then the
  // entries reviews applied without a finding (in file order). The document requires every
  // finding's ref in `briefing.memoryApplied`, quoted identically: both are built here, from the
  // stored entries, never from model text.
  const entryById = new Map(memory.entries.map((entry) => [entry.id, entry] as const));
  const appliedIds: string[] = [];
  const cite = (id: string): boolean => {
    if (!entryById.has(id)) return false;
    if (!appliedIds.includes(id) && appliedIds.length < limits.MAX_MEMORY_APPLIED)
      appliedIds.push(id);
    return appliedIds.includes(id);
  };
  const refsOf = (ids: readonly string[]) =>
    ids
      .slice(0, limits.MAX_MEMORY_REFS_PER_FINDING)
      .filter(cite)
      .flatMap((id) => {
        const entry = entryById.get(id);
        return entry === undefined ? [] : [memoryRefOf(entry)];
      });
  const findings: Finding[] = raw.map(({ finding, path, memory: cited }, index) => ({
    ...finding,
    id: `F${index + 1}`,
    path,
    memory: refsOf(cited),
  }));
  for (const outcome of [...outcomes].sort(byFileOrder))
    for (const id of outcome.memory?.applied ?? []) cite(id);
  const memoryApplied = appliedIds.flatMap((id) => {
    const entry = entryById.get(id);
    return entry === undefined ? [] : [memoryRefOf(entry)];
  });
  stats.memoryCited = memoryApplied.length;
  /** A briefing no other part's check can trip over, with the memory the findings cite. */
  const stub: Briefing = { ...STUB_BRIEFING, memoryApplied };
  stats.findings = findings.length;
  const triageFiles = fitMinutes(triaged.sort(byFileOrder));

  const fileLines = Object.fromEntries(
    files.flatMap((file) =>
      file.newFileLines === undefined ? [] : [[file.path, file.newFileLines] as const],
    ),
  );
  /** The pipeline-written reasons for the sections a drawn map lacks (schema 1.3, H4-7). */
  interface SectionReasons {
    readonly flowsUnavailable?: MapSectionUnavailable | undefined;
    readonly walkthroughUnavailable?: MapSectionUnavailable | undefined;
  }
  const assemble = (
    briefing: Briefing,
    graph: StoredGraph | undefined,
    graphUnavailable: GraphUnavailable | undefined,
    briefingUnavailable?: BriefingUnavailable,
    sections: SectionReasons = {},
  ) =>
    parseAnalysisDocumentJson(
      JSON.stringify({
        // The lowest minor the document needs, so older readers keep reading (H4-5, S7).
        schemaVersion: requiredSchemaVersion({
          briefing,
          provenance: { graphUnavailable, ...sections },
        }),
        provenance: {
          ...base,
          generator: { ...base.generator, roles: generatorRoles(models, request.previous) },
          files: files.map(facts),
          unanalysed,
          ...(graphUnavailable === undefined ? {} : { graphUnavailable }),
          ...(briefingUnavailable === undefined ? {} : { briefingUnavailable }),
          ...(sections.flowsUnavailable === undefined
            ? {}
            : { flowsUnavailable: sections.flowsUnavailable }),
          ...(sections.walkthroughUnavailable === undefined
            ? {}
            : { walkthroughUnavailable: sections.walkthroughUnavailable }),
          readByHand,
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
    part: DocumentPart,
    briefing: Briefing,
    graph: StoredGraph | undefined,
    graphUnavailable: GraphUnavailable | undefined,
  ): UnitCheck => {
    const result = assemble(briefing, graph, graphUnavailable);
    if (result.ok) return [];
    const split = partitionIssues(result.error.issues);
    const foreign = DOCUMENT_PARTS.some((other) => other !== part && split[other].length > 0);
    if (split.other > 0 || foreign) return "unrepairable";
    return split[part];
  };

  // Units were checked one by one (fresh) or not at all (reused): check them together before
  // spending a call on the change map or the briefing. A failure here is not a model's to fix.
  const together = assemble(stub, undefined, undefined);
  if (!together.ok) throw new Failed("document_invalid");

  // --- Change map ----------------------------------------------------------------------------
  // The map shows code with behaviour (H4-5, ADR 0014 amendment): the graph model gets the
  // triaged files the deterministic scope keeps (logic, or the tests of a test-only PR) and
  // nothing else, so an excluded file's path or diff never reaches it. The scope is decided over
  // every file the rules left to the AI (S5): logic that could not be sent (binary, too large,
  // triage failed or refused) makes the map unavailable, never a map drawn from the tests. A
  // card may be backed only by a file the call carried, with a range inside that file's changed
  // lines: a stray reference or range is dropped and counted (`stripGraphRefs`, S6). A PR with
  // nothing to map gets the fixed reason `no-logic`, no call.
  let graph: GraphAnswer | undefined;
  let graphUnavailable: GraphUnavailable | undefined;
  /** What the graph call was given, for the calls that draw over its answer (H4-7). */
  let mapInput:
    | {
        readonly title: LlmUntrustedText;
        readonly files: readonly LlmUntrustedText[];
        readonly spans: MappedFiles;
      }
    | undefined;
  const triagedPaths = new Set(triageFiles.map((file) => file.path));
  const scope = changeMapScope(
    files
      .filter((file) => preTriage(file.path).kind !== "noise")
      .map((file) => ({ path: file.path, mappable: triagedPaths.has(file.path) })),
  );
  if (scope.kind === "none") {
    if (triageFiles.length > 0) graphUnavailable = { reason: "no-logic" };
  } else if (scope.kind === "unmappable") {
    // Every file of the deciding category was binary, too large, or failed its triage.
    const sizes = new Set(scope.paths);
    graphUnavailable = {
      reason: files.some((file) => sizes.has(file.path) && (file.binary || file.tooLarge))
        ? "too-large"
        : "analysis-failed",
    };
  } else {
    const inScope = new Set(scope.paths);
    const mapped = files.filter((file) => inScope.has(file.path));
    const spans: MappedFiles = new Map(
      mapped.map((file) => {
        const hunks = file.hunks.filter((hunk) => hunk.newLines > 0);
        const first = hunks[0];
        const last = hunks.at(-1);
        return [
          file.path,
          first === undefined || last === undefined
            ? undefined
            : { start: first.newStart, end: last.newStart + last.newLines - 1 },
        ];
      }),
    );
    const title: LlmUntrustedText = { label: "pr_title", text: request.pullRequest.title };
    const fileParts: LlmUntrustedText[] = mapped.flatMap((file, index) => [
      { label: `file.${index}.path`, text: file.path },
      { label: `file.${index}.diff`, text: file.patch },
    ]);
    const parts: LlmUntrustedText[] = [title, ...fileParts];
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
          // Checked as it will be stored: with stray references and ranges already dropped.
          check: (answer) =>
            checkPart("graph", stub, stripGraphRefs(answer, spans).answer, undefined),
        },
        observe("graph"),
        signal,
      );
      if (drawn.ok) {
        const kept = stripGraphRefs(drawn.value, spans);
        graph = kept.answer;
        mapInput = { title, files: fileParts, spans };
        stats.graphFilesStripped = kept.files;
        stats.graphRangesStripped = kept.ranges;
      } else graphUnavailable = { reason: PART_REASON[drawn.reason] };
    }
  }
  stats.graph =
    graph !== undefined ? "drawn" : graphUnavailable !== undefined ? "unavailable" : "none";

  // --- The map's flows and walkthrough (H4-7) ------------------------------------------------
  // Two more calls on the graph role, each its own enforced output, drawn over the stored map:
  // the sequences a reviewer must follow, then a short tour. Each gets what the graph call got
  // (the title and the mapped files, nothing else) plus the map's outline (ids, labels, kinds)
  // as an untrusted part, since it is model-written text. A participant, a focus id or a file
  // reference the map does not declare is dropped and counted (`stripFlowRefs`,
  // `stripWalkthroughRefs`), the rest is checked in the whole document, and a call that fails
  // after its repair round leaves its section absent with a fixed reason: the map, the findings
  // and the briefing are untouched. No map (nothing to map, too large, failed) means no call.
  let flows: FlowsAnswer["flows"] | undefined;
  let flowsUnavailable: MapSectionUnavailable | undefined;
  let walkthrough: Walkthrough | undefined;
  let walkthroughUnavailable: MapSectionUnavailable | undefined;
  const storedGraph = (): StoredGraph | undefined =>
    graph === undefined
      ? undefined
      : {
          ...graph,
          flows: flows ?? [],
          ...(walkthrough === undefined ? {} : { walkthrough }),
        };
  if (graph !== undefined && mapInput !== undefined) {
    const drawnMap = graph;
    const { title, files: mappedFiles, spans: mappedSpans } = mapInput;
    const ids = graphIds(drawnMap);
    const outline: LlmUntrustedText = {
      label: "graph",
      text: JSON.stringify(graphOutline(drawnMap)),
    };
    const over = (
      candidate: FlowsAnswer["flows"],
      steps: Walkthrough | undefined,
    ): StoredGraph => ({
      ...drawnMap,
      flows: candidate,
      ...(steps === undefined ? {} : { walkthrough: steps }),
    });
    const drawnFlows = await completeWithRepair(
      llm,
      {
        role: "graph",
        instructions: FLOWS_INSTRUCTIONS,
        untrusted: [title, outline, ...mappedFiles],
        output: FLOWS_OUTPUT,
        maxOutputTokens: MAX_OUTPUT_TOKENS.flows,
        check: (answer) => {
          const kept = stripFlowRefs(answer, ids, mappedSpans);
          // The document takes an empty list; an answer with nothing left is not worth storing.
          if (kept.answer.flows.length === 0) return ["flows: too_small"];
          const checked = checkPart("flows", stub, over(kept.answer.flows, undefined), undefined);
          // Issues sit on the stripped list; the model repairs its own answer (SF2).
          return checked === "unrepairable" ? checked : rebaseFlowIssues(checked, kept.index);
        },
      },
      observe("flows"),
      signal,
    );
    if (drawnFlows.ok) {
      const kept = stripFlowRefs(drawnFlows.value, ids, mappedSpans);
      flows = kept.answer.flows;
      stats.flowsStripped = kept.refs;
      stats.graphFilesStripped += kept.files;
      stats.graphRangesStripped += kept.ranges;
    } else flowsUnavailable = { reason: PART_REASON[drawnFlows.reason] };

    const drawnSteps = await completeWithRepair(
      llm,
      {
        role: "graph",
        instructions: WALKTHROUGH_INSTRUCTIONS,
        untrusted: [
          title,
          outline,
          { label: "flows", text: JSON.stringify(flowsOutline(flows ?? [])) },
          ...mappedFiles,
        ],
        output: WALKTHROUGH_OUTPUT,
        maxOutputTokens: MAX_OUTPUT_TOKENS.walkthrough,
        // Checked as it will be stored: too few steps left after stripping is the document's
        // own `steps: too_small`, sent back for the repair round.
        check: (answer) => {
          const kept = stripWalkthroughRefs(answer, ids);
          const checked = checkPart(
            "walkthrough",
            stub,
            over(flows ?? [], toWalkthrough(kept.answer)),
            undefined,
          );
          return checked === "unrepairable" ? checked : rebaseStepIssues(checked, kept.index);
        },
      },
      observe("walkthrough"),
      signal,
    );
    if (drawnSteps.ok) {
      const kept = stripWalkthroughRefs(drawnSteps.value, ids);
      walkthrough = toWalkthrough(kept.answer);
      stats.walkthroughStripped = kept.refs;
    } else walkthroughUnavailable = { reason: PART_REASON[drawnSteps.reason] };
  }
  stats.flows = flows !== undefined ? "drawn" : (flowsUnavailable?.reason ?? "skipped");
  stats.walkthrough =
    walkthrough !== undefined ? "drawn" : (walkthroughUnavailable?.reason ?? "skipped");
  const sections: SectionReasons = { flowsUnavailable, walkthroughUnavailable };

  // --- Briefing ------------------------------------------------------------------------------
  const floor = maxRisk(
    findingsFloor(findings),
    unreviewedFloor(unreviewed),
    triageFloor(triageFiles),
  );
  const minutes = Math.max(
    limits.MIN_REVIEW_MINUTES,
    triageFiles.reduce((total, file) => total + file.reviewMinutes, 0),
  );
  const toBriefing = (answer: BriefingAnswer): Briefing => ({
    // The TL;DR replaces the summary paragraph in what Rocky writes (H4-8, schema 1.4).
    tldr: answer.tldr,
    // The verdict never sits below what the findings say, nor below the risk of a file that was
    // not reviewed, whatever the model answered (Fix A). When it is raised, the model's reason
    // ("Looks fine.") no longer describes it, so a fixed Rocky reason replaces it (round 2, N4).
    verdict:
      RISK_RANK[answer.verdict.level] >= RISK_RANK[floor]
        ? answer.verdict
        : {
            level: floor,
            reason:
              RISK_RANK[findingsFloor(findings)] >= RISK_RANK[floor]
                ? RAISED_FOR_FINDINGS
                : RISK_RANK[unreviewedFloor(unreviewed)] >= RISK_RANK[floor]
                  ? RAISED_FOR_UNREVIEWED
                  : RAISED_FOR_TRIAGE,
          },
    estimatedReviewMinutes: minutes,
    reviewPath: answer.reviewPath,
    checkedOk: answer.checkedOk,
    memoryApplied,
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
      check: (answer) => checkPart("briefing", toBriefing(answer), storedGraph(), graphUnavailable),
    },
    observe("briefing"),
    signal,
  );
  // A briefing that fails after its repair round is replaced by Rocky's own (round 1, item 1).
  const briefingUnavailable: BriefingUnavailable | undefined = briefed.ok
    ? undefined
    : { reason: PART_REASON[briefed.reason] };
  const briefing: Briefing = briefed.ok
    ? toBriefing(briefed.value)
    : {
        summary: FALLBACK_SUMMARY,
        verdict: { level: floor, reason: FALLBACK_REASON },
        estimatedReviewMinutes: minutes,
        reviewPath: [...triageFiles]
          .sort(
            (a, b) =>
              LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.score - a.score || byFileOrder(a, b),
          )
          .slice(0, limits.MAX_REVIEW_PATH)
          .map((file) => ({
            path: file.path,
            why: `Triaged ${file.level} (score ${file.score}).`,
          })),
        checkedOk: [],
        memoryApplied,
      };

  // --- Final validation: the whole document, as it will be stored ----------------------------
  const final = assemble(briefing, storedGraph(), graphUnavailable, briefingUnavailable, sections);
  // Defence in depth: `toBriefing` already raised the verdict to a floor at least as high as the
  // stored-document rule, so this cannot trip unless that clamp breaks. It is the same check
  // `completeAnalysis` runs at the write (round 2, N3).
  if (!final.ok || belowVerdictFloor(final.value)) throw new Failed("document_invalid");
  // Defence in depth for the leak guard (ADR 0015 §3): every fresh answer and every reused unit
  // was checked on its own; this checks all model-written text together, so a copy spread over
  // several answers is caught too. Only the PR's own content may be quoted.
  const content: LlmUntrustedText[] = [
    { label: "pr_title", text: request.pullRequest.title },
    ...files.map((file) => ({ label: "diff", text: `${file.path}\n${file.patch}` })),
  ];
  const modelText = {
    briefing: final.value.briefing,
    triage: final.value.triage,
    findings: final.value.findings,
    graph: final.value.graph,
  };
  if (instructionLeaks(modelText, content).length > 0) throw new Failed("document_invalid");
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

const STAGES: readonly AnalysisStage[] = [
  "triage",
  "review",
  "graph",
  "flows",
  "walkthrough",
  "briefing",
];
const perStage = <T>(value: () => T): Record<AnalysisStage, T> =>
  Object.fromEntries(STAGES.map((stage) => [stage, value()])) as Record<AnalysisStage, T>;

const newStats = (): AnalysisStats => ({
  files: 0,
  noise: 0,
  reused: 0,
  analysed: 0,
  reviewed: 0,
  unanalysed: 0,
  findings: 0,
  calls: perStage(() => 0),
  repairs: 0,
  graph: "none",
  graphFilesStripped: 0,
  graphRangesStripped: 0,
  flows: "skipped",
  walkthrough: "skipped",
  flowsStripped: 0,
  walkthroughStripped: 0,
  usageByStage: perStage(() => ({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })),
  memoryEntries: 0,
  memoryDropped: 0,
  memoryReviews: 0,
  memoryCited: 0,
  memoryStripped: 0,
});

const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * The class name of a thrown `Error`, or `unknown`. The name is read from the prototype's
 * constructor (a function: code, not content), never from an own property, and only on a real
 * `Error`: a plain object or a proxy with a planted, identifier-shaped `constructor.name` is
 * `unknown`, as are primitives and anything whose lookup throws (H4-4, review round 1 S1).
 */
export const errorClassOf = (error: unknown): string => {
  if (!(error instanceof Error)) return "unknown";
  try {
    const constructor: unknown = (Object.getPrototypeOf(error) as object | null)?.constructor;
    if (typeof constructor !== "function") return "unknown";
    const name: unknown = constructor.name;
    return typeof name === "string" && CLASS_NAME.test(name) ? name : "unknown";
  } catch {
    return "unknown";
  }
};

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
      return {
        status: "failed",
        code: `llm_${error.kind as LlmFatalErrorKind}`,
        stats,
        ...(error.origin === undefined ? {} : { diagnostic: { origin: error.origin } }),
      };
    }
    // Anything else is a bug or a broken port; only its class name goes out (its message could
    // quote content).
    return {
      status: "failed",
      code: "internal_error",
      stats,
      diagnostic: { origin: "pipeline", errorClass: errorClassOf(error) },
    };
  }
};
