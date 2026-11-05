/**
 * Stage output contracts (P4-3, ADR 0014 §4). Each model call answers one of these, built from
 * the analysis document's own Zod schemas so a stage answer that validates here has exactly the
 * shape the document needs. Fields the pipeline owns are left out of what a model may say:
 *
 * - triage: no `path` (the pipeline knows which file it asked about) and no `noise` level (only
 *   the rules make a file noise);
 * - review: no `id`, `path` or `memory` (the pipeline assigns ids and the file), so a finding can
 *   never land on a file other than the one reviewed. With project memory (P8-2) the model cites
 *   entries by the per-call handles it was given (`M1`, …), never by stored id or text: the
 *   pipeline resolves handles to `MemoryRef`s from the stored entries and drops unknown ones;
 * - briefing: no `estimatedReviewMinutes` or `memoryApplied` (computed by the pipeline), and the
 *   TL;DR instead of the summary paragraph (H4-8).
 */
import { z } from "zod";
import {
  BriefingFields,
  Finding,
  FLOW_MESSAGE_RULE,
  Flow,
  FlowMessageBase,
  flowMessageConsistent,
  formatPath,
  Graph,
  Id,
  limits,
  Tldr,
  TriagedFile,
  Verdict,
  WalkthroughStep,
} from "@rocky-reviews/schema";
import type { LlmOutputSchema, LlmParseResult } from "../llm.js";
import { providerJsonSchema } from "./provider-schema.js";

/** At most this many findings for one file; the document caps the PR at `MAX_FINDINGS`. */
export const MAX_FINDINGS_PER_FILE = 25;
/** At most this many issues go back to a model in a repair round. */
export const MAX_REPAIR_ISSUES = 50;
/** The flows call asks for one to three key sequences (as its prompt says); the document allows `MAX_FLOWS`. */
export const MIN_ANSWER_FLOWS = 1;
export const MAX_ANSWER_FLOWS = 3;
/** The walkthrough call asks for three to seven steps; the document allows 2 to 12. */
export const MIN_ANSWER_STEPS = 3;
export const MAX_ANSWER_STEPS = 7;

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

/** Most project-memory entries one review call is given (P8-2; `selectMemory`). */
export const MAX_MEMORY_PER_FILE = 12;

/**
 * The review answer when the file has project-memory entries (P8-2, ADR 0037). Each finding
 * cites the handles of the entries it relied on. A finding the model leaves out because of a
 * dismissal entry is not dropped silently: it goes in `suppressed`, whole (without a
 * suggestion), with the handle of the entry that covers it. The pipeline keeps it out only when
 * that entry is a dismissal the call was given and covers the finding's severity; otherwise it is
 * restored as a draft (fix round, ADR 0037 §4). Handles are `Id`s here; one the call did not
 * offer is dropped, never stored. Every list is required (no optional field is added to the
 * enforced grammar); empty when nothing applies.
 */
export const ReviewMemoryFinding = ReviewFinding.extend({
  memory: z
    .array(Id)
    .max(limits.MAX_MEMORY_REFS_PER_FINDING)
    .describe("Ids (M1, M2, …) of convention or decision entries this finding relies on."),
});
export type ReviewMemoryFinding = z.output<typeof ReviewMemoryFinding>;

export const SuppressedFinding = ReviewFinding.omit({ suggestion: true }).extend({
  entry: Id.describe("Id (M1, M2, …) of the dismissal entry that covers this finding."),
});
export type SuppressedFinding = z.output<typeof SuppressedFinding>;

export const ReviewMemoryAnswer = z
  .strictObject({
    findings: z.array(ReviewMemoryFinding).max(MAX_FINDINGS_PER_FILE),
    suppressed: z
      .array(SuppressedFinding)
      .max(MAX_FINDINGS_PER_FILE)
      .describe(
        "Findings left out because a dismissal entry covers them, each with that entry's id.",
      ),
  })
  .describe(
    "Draft review comments for the one changed file in the pr_content blocks, with the project-memory entries they relied on.",
  );
export type ReviewMemoryAnswer = z.output<typeof ReviewMemoryAnswer>;

/**
 * The graph call asks only for what the page draws (H4-5, ADR 0021): lanes, nodes and edges.
 * Flows, views and the walkthrough stay in the document schema (empty or absent) and come back
 * as their own calls with their UI. This projection is what makes the graph an enforced output
 * again: it has no recursive definition and stays under the API's optional-field limit (ADR 0013,
 * amendments H4-4 and H4-5).
 */
export const GraphAnswer = Graph.pick({ lanes: true, nodes: true, edges: true }).describe(
  "The change map of the pull request in the pr_content blocks: lanes, nodes and edges.",
);
export type GraphAnswer = z.output<typeof GraphAnswer>;

/**
 * The flows call (H4-7) asks for the key runtime sequences of the drawn map as its own enforced
 * output: the document's `Flow`, with the message's `payload` left out. The payload's sample is
 * a recursive JSON value, which no enforced grammar takes (H4-4), and the sequence is what the
 * reader needs; the rest of the message (participants, label, kind, delta, note, files, repeat)
 * is the document's own shape, so an answer that validates here is a `Flow` once stored. The
 * self-consistency rule is re-applied, since Zod cannot omit from a refined object.
 */
export const FlowMessageAnswer = FlowMessageBase.omit({ payload: true }).refine(
  flowMessageConsistent,
  FLOW_MESSAGE_RULE,
);
export type FlowMessageAnswer = z.output<typeof FlowMessageAnswer>;

export const FlowAnswer = Flow.extend({
  messages: z
    .array(FlowMessageAnswer)
    .min(limits.MIN_FLOW_MESSAGES)
    .max(limits.MAX_FLOW_MESSAGES)
    .describe("Ordered by array position."),
});
export type FlowAnswer = z.output<typeof FlowAnswer>;

export const FlowsAnswer = z
  .strictObject({
    flows: z.array(FlowAnswer).min(MIN_ANSWER_FLOWS).max(MAX_ANSWER_FLOWS),
  })
  .describe(
    "The key runtime sequences of the change map in the pr_content blocks, as ordered steps between its node ids.",
  );
export type FlowsAnswer = z.output<typeof FlowsAnswer>;

/**
 * The walkthrough call (H4-7) asks for a short tour of the map: the document's step heading,
 * body and id, with a focus of node and edge ids only. The document's `StepFocus` also takes
 * lanes, a stage (a view or a flow) and that flow's message ids; those need views and a staged
 * flow, which Rocky's pipeline does not draw, so the answer is the flat selection and the
 * pipeline writes it into the document's shape (`toWalkthrough`).
 */
export const StepFocusAnswer = z
  .strictObject({
    nodes: z.array(Id).max(limits.MAX_SCOPE_NODES).default([]),
    edges: z.array(Id).max(limits.MAX_SCOPE_EDGES).default([]),
  })
  .describe(
    "Node and edge ids that stay lit while the step plays; both empty means the whole map.",
  );
export type StepFocusAnswer = z.output<typeof StepFocusAnswer>;

export const WalkthroughStepAnswer = WalkthroughStep.pick({
  id: true,
  heading: true,
  body: true,
}).extend({ focus: StepFocusAnswer });
export type WalkthroughStepAnswer = z.output<typeof WalkthroughStepAnswer>;

export const WalkthroughAnswer = z
  .strictObject({
    steps: z
      .array(WalkthroughStepAnswer)
      .min(MIN_ANSWER_STEPS)
      .max(MAX_ANSWER_STEPS)
      .describe("Ordered by array position."),
  })
  .describe("An ordered tour of the change map in the pr_content blocks, for a reviewer.");
export type WalkthroughAnswer = z.output<typeof WalkthroughAnswer>;

/**
 * The briefing call (H4-8) answers with the TL;DR, required here though optional in the
 * document (documents before 1.4 carry the summary paragraph instead), and a verdict whose
 * reason is one short sentence: `MAX_VERDICT_REASON_ANSWER_LENGTH`, tighter than the document's
 * `MAX_REASON_LENGTH`, which stays so older documents still read.
 */
export const BriefingAnswer = BriefingFields.pick({
  reviewPath: true,
  checkedOk: true,
})
  .extend({
    tldr: Tldr,
    verdict: Verdict.extend({
      reason: Verdict.shape.reason
        .max(limits.MAX_VERDICT_REASON_ANSWER_LENGTH)
        .describe("One short sentence: what makes this PR this risky."),
    }).describe("The one-line risk call for the whole PR."),
  })
  .describe("What a reviewer reads before the diff.");
export type BriefingAnswer = z.output<typeof BriefingAnswer>;

/** `findings[0].range: too_small` from a Zod issue: a schema path and a code, never a value. */
export const issueLine = (path: readonly PropertyKey[], code: string): string =>
  `${formatPath(path) || "(root)"}: ${code}`;

/**
 * The port's output contract for a stage schema: JSON Schema for the provider (input side, so
 * defaulted fields are optional; `providerJsonSchema` folds the hand-written constraints a
 * provider transform cannot take, H4-4) and a validator that never throws. The validator is the
 * Zod schema itself, so nothing the sent schema leaves out is left unchecked.
 */
export const outputSchema = <S extends z.ZodType>(
  name: string,
  schema: S,
  options: { readonly mode?: LlmOutputSchema<unknown>["mode"] } = {},
): LlmOutputSchema<z.output<S>> => {
  const jsonSchema = Object.freeze(
    providerJsonSchema(
      z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
    ),
  );
  return Object.freeze({
    name,
    jsonSchema,
    mode: options.mode ?? "structured",
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
/** The review with project memory (P8-2): only sent when the file has entries to apply. */
export const REVIEW_MEMORY_OUTPUT = outputSchema("rocky_review_memory", ReviewMemoryAnswer);
/**
 * Enforced like the other roles (H4-5). The full graph could not be (H4-4: recursive `View` and
 * `JsonValue` definitions, more than 24 optional fields, a grammar too large with flows, views and
 * the walkthrough); lanes, nodes and edges compile. Prompt mode (`mode: "prompt"`) stays
 * available to any role that needs it.
 */
export const GRAPH_OUTPUT = outputSchema("rocky_graph", GraphAnswer);
/**
 * Each its own enforced output (H4-7): the flows compile without the payload's recursive sample,
 * and the walkthrough compiles on its own (it was the walkthrough on top of the graph that pushed
 * the combined grammar over its limit, H4-4). Both are checked by `wire-schema.test.ts`.
 */
export const FLOWS_OUTPUT = outputSchema("rocky_flows", FlowsAnswer);
export const WALKTHROUGH_OUTPUT = outputSchema("rocky_walkthrough", WalkthroughAnswer);
export const BRIEFING_OUTPUT = outputSchema("rocky_briefing", BriefingAnswer);

/** Output caps per call. Thinking counts against them (ADR 0012 N9). P4-6 owns token budgets. */
export const MAX_OUTPUT_TOKENS = {
  triage: 16_000,
  review: 64_000,
  graph: 64_000,
  flows: 16_000,
  walkthrough: 16_000,
  briefing: 16_000,
} as const;

/** Upper bound on the PR estimate; the document refuses more. */
export const MAX_REVIEW_MINUTES = limits.MAX_REVIEW_MINUTES;
