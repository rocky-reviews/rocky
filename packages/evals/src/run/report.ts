/**
 * The eval report (P4-7): a versioned JSON document, validated on read so `compare` never gates
 * on a file it misunderstood. It holds scores, counts, ids, paths, line ranges and versions only:
 * no code, no diff, no prompt and no model text, so a report is safe to keep and to publish.
 *
 * Bump `REPORT_VERSION` on any breaking change to the shape and regenerate the fake baseline.
 */
import { createHash } from "node:crypto";
import { PROMPT_TEXTS } from "@rocky-reviews/core";
import { z } from "zod";

export const REPORT_FORMAT = "rocky-evals-report";
export const REPORT_VERSION = 1;

/** sha256 of every Rocky-authored text a model is shown (core's `PROMPT_TEXTS`). */
export const PROMPT_HASH = createHash("sha256").update(JSON.stringify(PROMPT_TEXTS)).digest("hex");

export const PLACEHOLDER_NOTICE =
  "NOT A REAL-MODEL RESULT. Placeholder for the live baseline: no model has been run. Replace it with a human run (packages/evals/README.md, 'Real-model baseline').";

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1);
const Severity = z.enum(["critical", "high", "medium", "low"]);
const Range = z.strictObject({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});

export const RoleModel = z.strictObject({
  provider: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
});
export type RoleModel = z.infer<typeof RoleModel>;
export const ReportModels = z.record(z.string(), RoleModel);
export type ReportModels = z.infer<typeof ReportModels>;

export const RoleUsage = z.strictObject({
  calls: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheWriteInputTokens: count,
  /** Models that answered (a refusal fallback may add one). */
  models: z.array(z.string()),
});
export type RoleUsage = z.infer<typeof RoleUsage>;

export const UsageReport = z.strictObject({
  byRole: z.record(z.string(), RoleUsage),
  /** Input + output + cache read + cache write tokens over every call. */
  totalTokens: count,
  /** The `--max-tokens` cap stopped the run. */
  capped: z.boolean(),
});
export type UsageReport = z.infer<typeof UsageReport>;

const Counts = {
  expected: count,
  produced: count,
  matched: count,
  tolerated: count,
  recall: rate,
  precision: rate,
  criticalProduced: count,
  criticalFalsePositives: count,
  criticalFalsePositiveRate: rate,
};

export const PrResult = z.strictObject({
  id: z.string(),
  /** `capped`: the token cap stopped it or it never started. */
  status: z.enum(["done", "failed", "capped"]),
  /** The pipeline's fixed failure code. */
  failure: z.string().nullable(),
  ...Counts,
  missed: z.array(z.string()),
  falsePositives: z.array(z.strictObject({ path: z.string(), severity: Severity, range: Range })),
});
export type PrResult = z.infer<typeof PrResult>;

export const Totals = z.strictObject({ prs: count, ...Counts });
export type Totals = z.infer<typeof Totals>;

export const InjectionResult = z.strictObject({
  fixture: z.string(),
  case: z.string(),
  channel: z.string(),
  technique: z.string(),
  goal: z.string(),
  status: z.enum(["done", "failed", "capped"]),
  failure: z.string().nullable(),
  /** The case is expected to fail closed (no document stored). */
  expectFailsClosed: z.boolean(),
  verdict: z.string().nullable(),
  cleanVerdict: z.string().nullable(),
  /** The stored verdict level differs from the clean PR's (null when either is missing). */
  verdictChanged: z.boolean().nullable(),
  /** V1: the verdict sits below the floor its own stored findings and triage set. */
  belowFloor: z.boolean(),
  /** F1 violations: findings, flags or review-path steps outside the diff. */
  outsideDiff: count,
  /** L1 violations: canary or prompt text in what was stored. */
  leaks: count,
  /** The payload's commands or links reached agent prompts or suggestions, or M1 markup was stored. */
  poisoned: z.boolean(),
});
export type InjectionResult = z.infer<typeof InjectionResult>;

export const InjectionTotals = z.strictObject({
  cases: count,
  unexpectedFailures: count,
  verdictChanged: count,
  belowFloor: count,
  outsideDiff: count,
  leaks: count,
  poisoned: count,
});
export type InjectionTotals = z.infer<typeof InjectionTotals>;

export const EvalReport = z
  .strictObject({
    format: z.literal(REPORT_FORMAT),
    version: z.literal(REPORT_VERSION),
    /** `fake`: scripted roles (tests the harness); `live`: real models; `placeholder`: neither. */
    kind: z.enum(["fake", "live", "placeholder"]),
    notice: z.string().nullable(),
    createdAt: z.iso.datetime(),
    pipelineVersion: z.string(),
    promptHash: z.string().regex(/^[0-9a-f]{64}$/),
    models: ReportModels,
    options: z.strictObject({
      maxTokens: z.number().int().positive(),
      injection: z.boolean(),
      only: z.array(z.string()).nullable(),
    }),
    usage: UsageReport,
    prs: z.array(PrResult),
    total: Totals,
    injection: z
      .strictObject({ cases: z.array(InjectionResult), total: InjectionTotals })
      .nullable(),
  })
  .refine((report) => (report.kind === "placeholder") === (report.notice === PLACEHOLDER_NOTICE), {
    message: "a placeholder carries PLACEHOLDER_NOTICE, and only a placeholder does",
    path: ["notice"],
  })
  .superRefine((report, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    if (report.kind === "placeholder") {
      if (report.prs.length > 0) issue(["prs"], "a placeholder holds no results");
      return;
    }
    report.prs.forEach((pr, index) => {
      for (const message of countIssues(pr)) issue(["prs", index], message);
    });
    const total = totalsOf(report.prs);
    for (const key of Object.keys(total) as (keyof Totals)[])
      if (!same(total[key], report.total[key]))
        issue(["total", key], "totals must be the sums of the PRs");
    const anyCapped =
      report.prs.some((pr) => pr.status === "capped") ||
      (report.injection?.cases ?? []).some((c) => c.status === "capped");
    if (anyCapped !== report.usage.capped)
      issue(["usage", "capped"], "capped must be set exactly when a PR or case was capped");
  });
export type EvalReport = z.infer<typeof EvalReport>;

/** Rates are ratios of the counts beside them; float noise only. */
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const ratio = (part: number, whole: number, empty: number) => (whole === 0 ? empty : part / whole);

const countIssues = (counts: z.infer<typeof PrResult>): string[] => [
  ...(counts.matched > counts.expected ? ["matched exceeds expected"] : []),
  ...(counts.matched > counts.produced ? ["matched exceeds produced"] : []),
  ...(counts.criticalFalsePositives > counts.criticalProduced
    ? ["critical false positives exceed criticals produced"]
    : []),
  ...(same(counts.recall, ratio(counts.matched, counts.expected, 1))
    ? []
    : ["recall is not matched / expected"]),
  ...(same(counts.precision, ratio(counts.matched, counts.produced, 1))
    ? []
    : ["precision is not matched / produced"]),
  ...(same(
    counts.criticalFalsePositiveRate,
    ratio(counts.criticalFalsePositives, counts.criticalProduced, 0),
  )
    ? []
    : ["critical false-positive rate is not the ratio of its counts"]),
];

export type ReportParse =
  | { readonly ok: true; readonly report: EvalReport }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * `baseline`: what a gate compares against must be a complete run (not capped, no `--only`,
 * every PR done). `report`: what is gated must not be capped or partial; a failed PR is a result
 * (it found nothing). Placeholders parse in any purpose so `compare` can refuse them by name.
 */
export interface ParseOptions {
  readonly purpose?: "any" | "baseline" | "report";
}

const purposeIssues = (report: EvalReport, purpose: ParseOptions["purpose"]): string[] => {
  if (purpose === undefined || purpose === "any" || report.kind === "placeholder") return [];
  const who = purpose === "baseline" ? "a baseline" : "a gated report";
  return [
    ...(report.usage.capped ? [`usage.capped: ${who} cannot be capped`] : []),
    ...(report.options.only === null ? [] : [`options.only: ${who} must run every seeded PR`]),
    ...(purpose === "baseline"
      ? report.prs.flatMap((pr, index) =>
          pr.status === "done" ? [] : [`prs.${index}.status: every baseline PR must be done`],
        )
      : []),
  ];
};

export const parseReport = (value: unknown, options: ParseOptions = {}): ReportParse => {
  const parsed = EvalReport.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  const issues = purposeIssues(parsed.data, options.purpose);
  return issues.length === 0 ? { ok: true, report: parsed.data } : { ok: false, issues };
};

/** Micro-averaged totals: sums of counts, rates from the sums. */
export const totalsOf = (prs: readonly PrResult[]): Totals => {
  const sum = (key: keyof typeof Counts) => prs.reduce((n, pr) => n + pr[key], 0);
  const expected = sum("expected");
  const produced = sum("produced");
  const matched = sum("matched");
  const criticalProduced = sum("criticalProduced");
  const criticalFalsePositives = sum("criticalFalsePositives");
  return {
    prs: prs.length,
    expected,
    produced,
    matched,
    tolerated: sum("tolerated"),
    recall: expected === 0 ? 1 : matched / expected,
    precision: produced === 0 ? 1 : matched / produced,
    criticalProduced,
    criticalFalsePositives,
    criticalFalsePositiveRate:
      criticalProduced === 0 ? 0 : criticalFalsePositives / criticalProduced,
  };
};
