/**
 * What each pipeline stage sends a model besides PR content (P4-8): the role, Rocky's
 * instructions, the output contract and the output cap. For estimates made before a run (the
 * CLI's `--dry-run`); the pipeline itself names the same values at each call.
 */
import type { LlmCompletionRole, LlmOutputSchema, RockyInstructions } from "../llm.js";
import {
  BRIEFING_INSTRUCTIONS,
  FLOWS_INSTRUCTIONS,
  GRAPH_INSTRUCTIONS,
  REVIEW_INSTRUCTIONS,
  TRIAGE_INSTRUCTIONS,
  WALKTHROUGH_INSTRUCTIONS,
} from "./instructions.js";
import {
  BRIEFING_OUTPUT,
  FLOWS_OUTPUT,
  GRAPH_OUTPUT,
  MAX_OUTPUT_TOKENS,
  REVIEW_OUTPUT,
  TRIAGE_OUTPUT,
  WALKTHROUGH_OUTPUT,
} from "./outputs.js";
import type { AnalysisStage } from "./pipeline.js";

/**
 * Which stage a call belongs to, read from the role and the labels Rocky gives each stage's
 * parts: the briefing is the review role without a file, and the flows and walkthrough calls
 * (H4-7) are the graph role with the map's outline (`graph`) and, for the walkthrough, its
 * `flows`. A scripted model answers by stage; a real model sees the same labels. Throws for a
 * role the pipeline never calls.
 */
export const stageOf = (call: {
  readonly role: LlmCompletionRole;
  readonly labels: readonly string[];
}): AnalysisStage => {
  switch (call.role) {
    case "triage":
      return "triage";
    case "review":
      return call.labels.includes("file_path") ? "review" : "briefing";
    case "graph":
      return call.labels.includes("flows")
        ? "walkthrough"
        : call.labels.includes("graph")
          ? "flows"
          : "graph";
    default:
      throw new RangeError("not a pipeline stage");
  }
};

export interface StageTemplate {
  readonly role: LlmCompletionRole;
  readonly instructions: RockyInstructions;
  readonly output: LlmOutputSchema<unknown>;
  readonly maxOutputTokens: number;
}

export const STAGE_CALLS: Readonly<Record<AnalysisStage, StageTemplate>> = Object.freeze({
  triage: {
    role: "triage",
    instructions: TRIAGE_INSTRUCTIONS,
    output: TRIAGE_OUTPUT,
    maxOutputTokens: MAX_OUTPUT_TOKENS.triage,
  },
  review: {
    role: "review",
    instructions: REVIEW_INSTRUCTIONS,
    output: REVIEW_OUTPUT,
    maxOutputTokens: MAX_OUTPUT_TOKENS.review,
  },
  graph: {
    role: "graph",
    instructions: GRAPH_INSTRUCTIONS,
    output: GRAPH_OUTPUT,
    maxOutputTokens: MAX_OUTPUT_TOKENS.graph,
  },
  // The flows and the walkthrough are drawn by the graph role, each as its own call (H4-7).
  flows: {
    role: "graph",
    instructions: FLOWS_INSTRUCTIONS,
    output: FLOWS_OUTPUT,
    maxOutputTokens: MAX_OUTPUT_TOKENS.flows,
  },
  walkthrough: {
    role: "graph",
    instructions: WALKTHROUGH_INSTRUCTIONS,
    output: WALKTHROUGH_OUTPUT,
    maxOutputTokens: MAX_OUTPUT_TOKENS.walkthrough,
  },
  // The briefing is written by the review role.
  briefing: {
    role: "review",
    instructions: BRIEFING_INSTRUCTIONS,
    output: BRIEFING_OUTPUT,
    maxOutputTokens: MAX_OUTPUT_TOKENS.briefing,
  },
});
