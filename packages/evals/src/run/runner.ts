/**
 * The eval runner (P4-7): every seeded PR through the real pipeline (`analyzePullRequest`) on the
 * roles it is given, scored with `scoreFindings`; optionally the injection corpus on pr-847 and
 * pr-912, reported separately; optionally the project-memory eval (P8-2) and the Ask eval (P9-2). PRs run one after another; the pipeline runs a PR's unit calls
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
  type EmbeddingRoleClient,
  type EmbeddingSpace,
  type LlmRoles,
} from "@rocky-reviews/core";
import { runAskInjection, type AskInjectionChannel } from "../ask/injection.js";
import { runAskEval } from "../ask/run.js";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { INJECTION_CORPUS, type InjectionCase } from "../injection/corpus.js";
import {
  injectCase,
  injectionRequest,
  INJECTION_FIXTURES,
  type InjectionFixture,
} from "../injection/inject.js";
import { pinTriage, type TriagePin } from "../memory/pin.js";
import { runMemoryEval, type MemoryStep } from "../memory/run.js";
import { scoreFindings } from "../score.js";
import { SEEDED_PRS, type SeededPr } from "../seeded/index.js";
import { injectionResult, injectionTotals } from "./injection.js";
import { createMeter } from "./meter.js";
import {
  AskEvalReport,
  AskInjectionReport,
  MemoryEvalReport,
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
    }
  /** One of the project-memory eval's three analyses (P8-2). */
  | { readonly kind: "memory"; readonly step: MemoryStep }
  /** The Ask eval's questions (P9-2). */
  | { readonly kind: "ask" }
  /** One corpus case planted in one of Ask's inputs (P9-3, `--ask --injection`). */
  | {
      readonly kind: "ask_injection";
      readonly case: InjectionCase;
      readonly channel: AskInjectionChannel;
    };

/** What the Ask eval embeds with (P9-2): the index and the questions share one space. */
export interface AskEmbedding {
  readonly client: EmbeddingRoleClient;
  readonly space: EmbeddingSpace;
}

export interface RunOptions {
  readonly kind: "fake" | "live";
  readonly models: ReportModels;
  /** Live: the same roles for every subject. Fake: a script per subject. */
  readonly rolesFor: (subject: EvalSubject) => LlmRoles;
  readonly maxTokens: number;
  readonly injection: boolean;
  /** Run the project-memory eval (P8-2) after the seeded PRs and the corpus. */
  readonly memory?: boolean;
  /** How many times the memory eval's three analyses run (default 1; a live rate, P8-2). */
  readonly memoryTrials?: number;
  /**
   * Run the Ask eval (P9-2) last, embedding with this.
   */
  readonly ask?: AskEmbedding;
  /**
   * Run the injection corpus on the Ask channel (P9-3, `--ask-injection`): the `ask` role only,
   * on fixed excerpts; no embedding is spent and no embedding provider is needed.
   */
  readonly askInjection?: boolean;
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
  const analyse = async (
    subject: EvalSubject,
    request: AnalysisRequest,
    /** An eval-harness wrapper over the roles (the memory eval's triage pin); identity otherwise. */
    wrap: (roles: LlmRoles) => LlmRoles = (roles) => roles,
  ) => {
    if (meter.capped()) return "capped" as const;
    try {
      const outcome = await analyzePullRequest(request, {
        llm: meter.wrap(wrap(options.rolesFor(subject))),
        clock: options.clock,
        sha256Hex,
        generator: { name: "rocky-evals", version: PIPELINE_VERSION },
        unitKeySalt: `evals:${options.kind}`,
      });
      // A call refused by the cap leaves the analysis incomplete even if the pipeline recovered.
      return meter.capped() ? ("capped" as const) : outcome;
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

  let memory: EvalReport["memory"] = null;
  if (options.memory === true) {
    const result = await runMemoryEval(
      async (step, request, { pinTriage: level }) => {
        const subject = { kind: "memory", step } as const;
        if (level === null) return { outcome: await analyse(subject, request) };
        let pin: TriagePin | undefined;
        const outcome = await analyse(subject, request, (roles) => {
          pin = pinTriage(roles, level);
          return pin.roles;
        });
        return { outcome, answered: pin?.answered };
      },
      { trials: options.memoryTrials ?? 1 },
    );
    // Parsed into the report's own shape: codes, levels, counts and seeded ids only.
    memory = MemoryEvalReport.parse(result);
    options.onProgress?.(
      `memory: ${result.status}, ${result.pass ? "pass" : "FAIL"} (${result.passes}/${result.trials.length} trials)`,
    );
  }

  let ask: EvalReport["ask"] = null;
  if (options.ask !== undefined) {
    const result = await runAskEval({
      llm: meter.wrap(options.rolesFor({ kind: "ask" })),
      embedding: options.ask.client,
      space: options.ask.space,
      capped: () => meter.capped(),
      // A live run must cite the answering code; the fake proves the guard only (score.ts).
      gate: options.kind === "live" ? "on_target" : "guard",
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    // Parsed into the report's own shape: ids, codes and counts only.
    ask = AskEvalReport.parse(result);
    options.onProgress?.(
      `ask: ${result.validlyCited}/${result.questions} answered with valid citations, ${result.pass ? "pass" : "FAIL"}`,
    );
  }

  let askInjection: EvalReport["askInjection"] = null;
  if (options.askInjection === true) {
    const result = await runAskInjection({
      rolesFor: (c, channel) =>
        meter.wrap(options.rolesFor({ kind: "ask_injection", case: c, channel })),
      capped: () => meter.capped(),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    // Parsed into the report's own shape: ids, codes, counts and booleans only.
    askInjection = AskInjectionReport.parse(result);
    const t = result.total;
    options.onProgress?.(
      `ask injection: ${t.cases} cases; leaks ${t.leaks}, outside ${t.outside}, markup ${t.markup}, echoed ${t.echoed}, failed ${t.failed}`,
    );
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
      memory: options.memory === true,
      ask: options.ask !== undefined,
      askInjection: options.askInjection === true,
      only: options.only === undefined ? null : [...options.only],
    },
    usage: meter.usage(),
    prs,
    total: totalsOf(prs),
    injection,
    memory,
    ask,
    askInjection,
  };
};
