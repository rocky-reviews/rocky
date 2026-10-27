import {
  GRAPH_MAX_INPUT_CHARS,
  MAX_REPAIR_ROUNDS,
  parseUnifiedDiff,
  preTriage,
  STAGE_CALLS,
  type AnalysisStage,
  type DiffFailure,
  type DiffFile,
  type LlmUntrustedText,
} from "@rocky-reviews/core";
import { estimateInputTokens } from "./budget.js";

/**
 * `--dry-run` (P4-8): what the pipeline would do with this diff, without a model. The rules
 * pre-triage is exact (it is the pipeline's own); the calls after it are a plan:
 *
 * - one triage call per file the rules leave to the AI;
 * - a review call per file the triage puts at critical or important (unknown before triage: a
 *   file the rules floor at important is certain, every other file with new-side lines may be);
 * - one change-map call (skipped when the PR is over the graph's input budget) and one briefing.
 *
 * Token figures use the budget's own input estimate and each stage's output cap, which is what the
 * cap check reserves for a call in flight. "Certain" counts the certain calls once; "worst case"
 * counts every possible call and every repair round. Real answers are usually far below the caps.
 */

export type FileDisposition = "noise" | "binary" | "too-large" | "triage";

export interface PlannedFile {
  readonly path: string;
  readonly disposition: FileDisposition;
  /** The rule behind a noise file or a floor. */
  readonly rule?: string;
  /** The level the rules floor the triage at. */
  readonly floor?: string;
}

export interface PlannedCall {
  readonly stage: AnalysisStage;
  readonly path?: string;
  /** Certain (`true`) or only if the triage asks for it. */
  readonly certain: boolean;
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
}

export type Plan =
  | {
      readonly ok: true;
      readonly files: readonly PlannedFile[];
      readonly calls: readonly PlannedCall[];
      readonly graphSkipped: boolean;
      readonly certainTokens: number;
      readonly worstCaseTokens: number;
    }
  | { readonly ok: false; readonly code: DiffFailure | "diff_truncated" | "diff_empty" };

/** Briefing input per triaged file (its triage and findings as JSON): a rough allowance. */
const BRIEFING_CHARS_PER_FILE = 1_200;

const estimate = (stage: AnalysisStage, untrusted: readonly LlmUntrustedText[]): number => {
  const call = STAGE_CALLS[stage];
  return estimateInputTokens({
    instructions: call.instructions,
    untrusted,
    output: call.output,
    maxOutputTokens: call.maxOutputTokens,
  });
};

export const planAnalysis = (diff: string, title: string, truncated: boolean): Plan => {
  if (truncated) return { ok: false, code: "diff_truncated" };
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  if (parsed.files.length === 0) return { ok: false, code: "diff_empty" };

  const files: PlannedFile[] = [];
  const calls: PlannedCall[] = [];
  const triaged: DiffFile[] = [];
  for (const file of parsed.files) {
    const rule = preTriage(file.path);
    if (rule.kind === "noise") {
      files.push({ path: file.path, disposition: "noise", rule: rule.rule });
      continue;
    }
    if (file.binary || file.tooLarge) {
      files.push({ path: file.path, disposition: file.binary ? "binary" : "too-large" });
      continue;
    }
    files.push({
      path: file.path,
      disposition: "triage",
      ...(rule.rule === undefined ? {} : { rule: rule.rule }),
      ...(rule.floor === undefined ? {} : { floor: rule.floor }),
    });
    triaged.push(file);
    const parts = {
      path: { label: "file_path", text: file.path },
      diff: { label: "diff", text: file.patch },
    };
    calls.push({
      stage: "triage",
      path: file.path,
      certain: true,
      inputTokens: estimate("triage", [
        parts.path,
        { label: "file_status", text: file.status },
        parts.diff,
      ]),
      maxOutputTokens: STAGE_CALLS.triage.maxOutputTokens,
    });
    if (file.hunks.some((hunk) => hunk.newLines > 0)) {
      calls.push({
        stage: "review",
        path: file.path,
        certain: rule.floor !== undefined,
        inputTokens: estimate("review", [parts.path, parts.diff]),
        maxOutputTokens: STAGE_CALLS.review.maxOutputTokens,
      });
    }
  }

  const graphParts: LlmUntrustedText[] = [
    { label: "pr_title", text: title },
    ...triaged.flatMap((file, index) => [
      { label: `file.${index}.path`, text: file.path },
      { label: `file.${index}.diff`, text: file.patch },
    ]),
  ];
  const graphChars = graphParts.reduce((sum, part) => sum + part.text.length, 0);
  const graphSkipped = triaged.length === 0 || graphChars > GRAPH_MAX_INPUT_CHARS;
  if (!graphSkipped) {
    calls.push({
      stage: "graph",
      certain: true,
      inputTokens: estimate("graph", graphParts),
      maxOutputTokens: STAGE_CALLS.graph.maxOutputTokens,
    });
  }
  calls.push({
    stage: "briefing",
    certain: true,
    inputTokens: estimate("briefing", [
      { label: "pr_title", text: title },
      { label: "triage", text: "x".repeat(BRIEFING_CHARS_PER_FILE * triaged.length) },
      { label: "findings", text: "" },
      { label: "noise", text: "" },
      { label: "unanalysed", text: "" },
    ]),
    maxOutputTokens: STAGE_CALLS.briefing.maxOutputTokens,
  });

  const cost = (call: PlannedCall) => call.inputTokens + call.maxOutputTokens;
  const certainTokens = calls.filter((c) => c.certain).reduce((sum, c) => sum + cost(c), 0);
  const worstCaseTokens = calls.reduce((sum, c) => sum + cost(c) * (1 + MAX_REPAIR_ROUNDS), 0);
  return { ok: true, files, calls, graphSkipped, certainTokens, worstCaseTokens };
};
