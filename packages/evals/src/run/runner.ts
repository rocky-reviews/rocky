/**
 * The eval runner (P4-7): every seeded PR through the real pipeline (`analyzePullRequest`) on the
 * roles it is given, scored with `scoreFindings`; optionally the injection corpus on pr-847 and
 * pr-912, reported separately. PRs run one after another; the pipeline runs a PR's unit calls
 * concurrently as it does in the worker. One meter counts tokens over the whole run and stops it
 * at `maxTokens`.
 */
import { createHash } from "node:crypto";
import {
  analyzePullRequest,
  isLlmCallError,
  PIPELINE_VERSION,
  type AnalysisOutcome,
  type AnalysisRequest,
  type Clock,
  type LlmRoles,
} from "@rocky-reviews/core";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { INJECTION_CORPUS, type InjectionCase } from "../injection/corpus.js";
import {
  injectCase,
  injectionRequest,
  INJECTION_FIXTURES,
  type InjectionFixture,
} from "../injection/inject.js";
import { scoreFindings } from "../score.js";
import { SEEDED_PRS, type SeededPr } from "../seeded/index.js";
import { injectionResult, injectionTotals } from "./injection.js";
import { createMeter } from "./meter.js";
import {
  PROMPT_HASH,
  REPORT_FORMAT,
  REPORT_VERSION,
  totalsOf,
  type EvalReport,
  type InjectionResult,
  type PrResult,
  type ReportModels,
} from "./report.js";

export type EvalSubject =
  | { readonly kind: "seeded"; readonly pr: SeededPr }
  | {
      readonly kind: "injection";
      readonly fixture: InjectionFixture;
      readonly case: InjectionCase;
    };

export interface RunOptions {
  readonly kind: "fake" | "live";
  readonly models: ReportModels;
  /** Live: the same roles for every subject. Fake: a script per subject. */
  readonly rolesFor: (subject: EvalSubject) => LlmRoles;
  readonly maxTokens: number;
  readonly injection: boolean;
  /** Seeded PR ids to run (all when absent). */
  readonly only?: readonly string[];
  readonly clock: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  /** One line per finished PR or case: ids and scores only. */
  readonly onProgress?: (line: string) => void;
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export const seededRequest = (pr: SeededPr): AnalysisRequest => ({
  repo: { owner: "acme", name: "rocky-app" },
  pullRequest: { number: pr.number, title: pr.title },
  base: { sha: pr.base, ref: "main" },
  head: { sha: pr.head, ref: "feat/seeded" },
  diff: pr.diff(),
  diffTruncated: false,
});

const prResult = (pr: SeededPr, outcome: AnalysisOutcome | "capped"): PrResult => {
  const findings =
    outcome !== "capped" && outcome.status === "done" ? outcome.document.findings : [];
  const score = scoreFindings(pr.expected, findings, pr.tolerated);
  return {
    id: pr.id,
    status: outcome === "capped" ? "capped" : outcome.status,
    failure: outcome === "capped" || outcome.status === "done" ? null : outcome.code,
    expected: score.expected,
    produced: score.produced,
    matched: score.matched,
    tolerated: score.tolerated,
    recall: score.recall,
    precision: score.precision,
    criticalProduced: score.criticalProduced,
    criticalFalsePositives: score.criticalFalsePositives,
    criticalFalsePositiveRate: score.criticalFalsePositiveRate,
    missed: [...score.missed],
    // Where, not what: no model text in the report.
    falsePositives: score.falsePositives.map(({ path, severity, range }) => ({
      path,
      severity,
      range: { start: range.start, end: range.end },
    })),
  };
};

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

export const runEvals = async (options: RunOptions): Promise<EvalReport> => {
  const meter = createMeter({
    maxTokens: options.maxTokens,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const createdAt = options.clock.now().toISOString();
  const analyse = async (subject: EvalSubject, request: AnalysisRequest) => {
    if (meter.capped()) return "capped" as const;
    try {
      const outcome = await analyzePullRequest(request, {
        llm: meter.wrap(options.rolesFor(subject)),
        clock: options.clock,
        sha256Hex,
        generator: { name: "rocky-evals", version: PIPELINE_VERSION },
        unitKeySalt: `evals:${options.kind}`,
      });
      return meter.capped() && outcome.status === "failed" ? ("capped" as const) : outcome;
    } catch (error) {
      // The pipeline rethrows a cancelled call (as it does an abort): here, the cap's refusal.
      if (meter.capped() && isLlmCallError(error) && error.kind === "cancelled") return "capped";
      throw error;
    }
  };

  const { only } = options;
  const selected =
    only === undefined ? SEEDED_PRS : SEEDED_PRS.filter((pr) => only.includes(pr.id));
  const prs: PrResult[] = [];
  const clean = new Map<string, AnalysisDocument>();
  for (const pr of selected) {
    const outcome = await analyse({ kind: "seeded", pr }, seededRequest(pr));
    if (outcome !== "capped" && outcome.status === "done") clean.set(pr.id, outcome.document);
    const result = prResult(pr, outcome);
    prs.push(result);
    options.onProgress?.(
      `${result.id}: ${result.status}${result.failure === null ? "" : ` (${result.failure})`}, recall ${percent(result.recall)}, precision ${percent(result.precision)}`,
    );
  }

  let injection: EvalReport["injection"] = null;
  if (options.injection) {
    const cases: InjectionResult[] = [];
    for (const fixture of INJECTION_FIXTURES) {
      for (const c of INJECTION_CORPUS) {
        const outcome = await analyse(
          { kind: "injection", fixture, case: c },
          injectionRequest(c, fixture),
        );
        const result = injectionResult(
          c,
          fixture,
          injectCase(c, fixture),
          outcome,
          clean.get(fixture.name),
        );
        cases.push(result);
        options.onProgress?.(`${fixture.name} ${c.id}: ${result.status}`);
      }
    }
    injection = { cases, total: injectionTotals(cases) };
  }

  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    kind: options.kind,
    notice: null,
    createdAt,
    pipelineVersion: PIPELINE_VERSION,
    promptHash: PROMPT_HASH,
    models: options.models,
    options: {
      maxTokens: options.maxTokens,
      injection: options.injection,
      only: options.only === undefined ? null : [...options.only],
    },
    usage: meter.usage(),
    prs,
    total: totalsOf(prs),
    injection,
  };
};
