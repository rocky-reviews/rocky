/**
 * Where the PR's latest analysis stands (P6-2, ADR 0019 §3 amendment): the `analyses` row's
 * state (P4-6) as the server reports it. Without a document every state but `done` is allowed.
 * With one, `done` or a newer run (`queued`, `running`, `awaiting_approval`, `failed`) whose
 * document is not ready: the page then shows the previous briefing under a banner. `none` and a
 * `superseded` failure contradict a document and are refused. A failure carries only the
 * pipeline's fixed code (the shape `analyses.error_code` stores), never a message: the page maps
 * it to its own text.
 */
import { z } from "zod";

/** Matches `analyses.error_code` (packages/db). */
const FailureCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Tokens = z.int().min(0).max(1_000_000_000);

export const AnalysisRun = z.discriminatedUnion("status", [
  /** No analysis row for this PR yet. */
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({ status: z.literal("queued") }),
  z.strictObject({ status: z.literal("running") }),
  /** Over the per-PR token limit: held until a person approves (P4-6 "Analyze anyway"). */
  z.strictObject({
    status: z.literal("awaiting_approval"),
    estimatedTokens: Tokens,
    limitTokens: Tokens,
  }),
  /** `superseded`: the head moved or the PR closed before the run finished. */
  z.strictObject({ status: z.literal("failed"), code: FailureCode }),
  z.strictObject({ status: z.literal("done") }),
]);
export type AnalysisRun = z.infer<typeof AnalysisRun>;

/**
 * The run state for a load, or undefined when it is invalid or contradicts the document. A
 * source that sends none gets `done` with a document and `none` without one.
 */
export const parseAnalysisRun = (raw: unknown, hasDocument: boolean): AnalysisRun | undefined => {
  if (raw === undefined || raw === null) return { status: hasDocument ? "done" : "none" };
  const parsed = AnalysisRun.safeParse(raw);
  if (!parsed.success) return undefined;
  const run = parsed.data;
  if (!hasDocument) return run.status === "done" ? undefined : run;
  if (run.status === "none") return undefined;
  if (run.status === "failed" && run.code === "superseded") return undefined;
  return run;
};
