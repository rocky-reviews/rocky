/**
 * What each pipeline stage sends a model besides PR content (P4-8): the role, Rocky's
 * instructions, the output contract and the output cap. For estimates made before a run (the
 * CLI's `--dry-run`); the pipeline itself names the same values at each call.
 */
import type { LlmCompletionRole, LlmOutputSchema, RockyInstructions } from "../llm.js";
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
} from "./outputs.js";
import type { AnalysisStage } from "./pipeline.js";

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
  // The briefing is written by the review role.
  briefing: {
    role: "review",
    instructions: BRIEFING_INSTRUCTIONS,
    output: BRIEFING_OUTPUT,
    maxOutputTokens: MAX_OUTPUT_TOKENS.briefing,
  },
});
