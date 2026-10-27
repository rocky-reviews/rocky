/**
 * Stage output contracts (P4-3, ADR 0014 §4). Each model call answers one of these, built from
 * the analysis document's own Zod schemas so a stage answer that validates here has exactly the
 * shape the document needs. Fields the pipeline owns are left out of what a model may say:
 *
 * - triage: no `path` (the pipeline knows which file it asked about) and no `noise` level (only
 *   the rules make a file noise);
 * - review: no `id`, `path` or `memory` (the pipeline assigns ids and the file; project memory is
 *   P8), so a finding can never land on a file other than the one reviewed;
 * - briefing: no `estimatedReviewMinutes` or `memoryApplied` (computed by the pipeline).
 */
import { z } from "zod";
import { Briefing, Finding, formatPath, Graph, limits, TriagedFile } from "@rocky-reviews/schema";
import type { LlmOutputSchema, LlmParseResult } from "../llm.js";

/** At most this many findings for one file; the document caps the PR at `MAX_FINDINGS`. */
export const MAX_FINDINGS_PER_FILE = 25;
/** At most this many issues go back to a model in a repair round. */
export const MAX_REPAIR_ISSUES = 50;

export const TriageAnswer = TriagedFile.omit({ path: true }).describe(
  "Triage for the one changed file in the pr_content blocks.",
);
export type TriageAnswer = z.output<typeof TriageAnswer>;

export const ReviewFinding = Finding.omit({ id: true, path: true, memory: true });
export type ReviewFinding = z.output<typeof ReviewFinding>;

export const ReviewAnswer = z
  .strictObject({
    findings: z.array(ReviewFinding).max(MAX_FINDINGS_PER_FILE),
  })
  .describe("Draft review comments for the one changed file in the pr_content blocks.");
export type ReviewAnswer = z.output<typeof ReviewAnswer>;

export const GraphAnswer = Graph;
export type GraphAnswer = z.output<typeof GraphAnswer>;

export const BriefingAnswer = Briefing.pick({
  summary: true,
  verdict: true,
  reviewPath: true,
  checkedOk: true,
}).describe("What a reviewer reads before the diff.");
export type BriefingAnswer = z.output<typeof BriefingAnswer>;

/** `findings[0].range: too_small` from a Zod issue: a schema path and a code, never a value. */
export const issueLine = (path: readonly PropertyKey[], code: string): string =>
  `${formatPath(path) || "(root)"}: ${code}`;

/**
 * The port's output contract for a stage schema: JSON Schema for the provider (input side, so
 * defaulted fields are optional) and a validator that never throws.
 */
export const outputSchema = <S extends z.ZodType>(
  name: string,
  schema: S,
): LlmOutputSchema<z.output<S>> => {
  const jsonSchema = Object.freeze(
    z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
  );
  return Object.freeze({
    name,
    jsonSchema,
    parse(value: unknown): LlmParseResult<z.output<S>> {
      try {
        const result = schema.safeParse(value);
        if (result.success) return { success: true, data: result.data };
        return {
          success: false,
          issues: result.error.issues
            .slice(0, MAX_REPAIR_ISSUES)
            .map((issue) => issueLine(issue.path, issue.code)),
        };
      } catch {
        // A hostile shape (nesting past the stack) is an invalid answer, not a crash.
        return { success: false, issues: ["(root): too_deep"] };
      }
    },
  });
};

export const TRIAGE_OUTPUT = outputSchema("rocky_triage", TriageAnswer);
export const REVIEW_OUTPUT = outputSchema("rocky_review", ReviewAnswer);
export const GRAPH_OUTPUT = outputSchema("rocky_graph", GraphAnswer);
export const BRIEFING_OUTPUT = outputSchema("rocky_briefing", BriefingAnswer);

/** Output caps per call. Thinking counts against them (ADR 0012 N9). P4-6 owns token budgets. */
export const MAX_OUTPUT_TOKENS = {
  triage: 16_000,
  review: 64_000,
  graph: 64_000,
  briefing: 16_000,
} as const;

/** Upper bound on the PR estimate; the document refuses more. */
export const MAX_REVIEW_MINUTES = limits.MAX_REVIEW_MINUTES;
