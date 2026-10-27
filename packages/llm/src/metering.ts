import { randomUUID } from "node:crypto";
import {
  isLlmCallError,
  LLM_COMPLETION_ROLES,
  LlmMeteringError,
  type Clock,
  type CompletionRoleClient,
  type EmbeddingRoleClient,
  type LlmCompletionRole,
  type LlmCostStatus,
  type LlmRole,
  type LlmRoles,
  type LlmUsage,
  type LlmUsageOutcome,
  type LlmUsageRecord,
  type LlmUsageSink,
  type LlmUsageStatus,
  type LlmUsageTokens,
  type StructuredCompletionRequest,
  type StructuredCompletionResult,
} from "@rocky-reviews/core";
import type { Logger } from "@rocky-reviews/log";
import type { LlmConfig } from "./config.js";
import { costMicroUsd, modelPrice, priceTableAt, PRICE_TABLES, type PriceTable } from "./prices.js";

/**
 * Metering (P4-5, ADR 0015): wraps the `LlmRoles` handed to the pipeline so every call, whatever
 * its outcome, writes its usage before its result (or error) is handed on.
 *
 * - One record per attempt the provider reported: a server-side fallback chain is one record per
 *   model that ran, never summed into one (the provider bills each attempt at its own model).
 * - Failed calls are recorded too: with the partial usage the adapter saw, or as `unreported`
 *   with null tokens. Retries, repair rounds and refusals are ordinary calls and recorded alike.
 * - Records carry ids, enums and numbers only. Nothing from the request or the answer.
 * - A write that still fails after `writeAttempts` tries is logged as numbers and ids (so the
 *   usage is not lost) and fails the call with `LlmMeteringError`; every later call through the
 *   same wrapper is then refused before it reaches a provider (fail closed: no unmetered spend).
 */

/** What serves a role, for records of calls that failed before the provider stamped a result. */
export interface UsageTarget {
  readonly provider: string;
  readonly model: string;
}

export type LlmUsageTargets = Readonly<Record<LlmCompletionRole, UsageTarget>> & {
  readonly embed: UsageTarget | null;
};

export const usageTargetsFor = (config: LlmConfig): LlmUsageTargets => {
  const pick = (role: LlmCompletionRole): UsageTarget => ({
    provider: config.roles[role].provider,
    model: config.roles[role].model,
  });
  const embed = config.roles.embed;
  return Object.freeze({
    triage: pick("triage"),
    review: pick("review"),
    graph: pick("graph"),
    ask: pick("ask"),
    embed: embed === null ? null : { provider: embed.provider, model: embed.model },
  });
};

export interface MeteringOptions {
  readonly sink: LlmUsageSink;
  readonly targets: LlmUsageTargets;
  readonly log: Logger;
  readonly analysisId?: string;
  readonly clock?: Clock;
  readonly callId?: () => string;
  /** Tries per write (default 3). */
  readonly writeAttempts?: number;
  /** Delay before the n-th retry is `n × retryDelayMs` (default 100). */
  readonly retryDelayMs?: number;
  /** Price tables (tests); defaults to the published ones. */
  readonly priceTables?: readonly PriceTable[];
}

/** Running totals of what this wrapper recorded (the seam for the per-PR token limit, P4-6). */
export interface MeteredTotals {
  readonly calls: number;
  readonly records: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  /** Sum over `priced` records. */
  readonly costMicroUsd: number;
  /** Records without a price (`no_price`, `billing_unverified`, `no_usage`). */
  readonly unpriced: number;
}

export interface MeteredRoles extends LlmRoles {
  /** True once a usage write failed for good; every later call is refused. */
  readonly failed: boolean;
  totals(): MeteredTotals;
}

/** int4: the database column's range. A count outside it is not trusted. */
const MAX_TOKENS = 2_147_483_647;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const UNRECOGNISED = "unrecognised";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS;

const tokensOf = (usage: LlmUsage): LlmUsageTokens | null => {
  const tokens: LlmUsageTokens = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
    cacheWrite5mTokens: usage.cacheWrite5mInputTokens,
    cacheWrite1hTokens: usage.cacheWrite1hInputTokens,
  };
  return Object.values(tokens).every(isCount) ? tokens : null;
};

const ZERO_TOTALS: MeteredTotals = {
  calls: 0,
  records: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  costMicroUsd: 0,
  unpriced: 0,
};

const sqlstateOf = (error: unknown): string | undefined => {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Attempt {
  readonly model: string;
  readonly outcome: LlmUsageOutcome;
  readonly errorKind?: LlmUsageRecord["errorKind"];
  readonly usage: LlmUsage | undefined;
  /** The usage is what a failed call had reported so far. */
  readonly partial: boolean;
}

export const meterRoles = (roles: LlmRoles, options: MeteringOptions): MeteredRoles => {
  const { sink, targets, log } = options;
  const clock = options.clock ?? { now: () => new Date() };
  const newCallId = options.callId ?? randomUUID;
  const writeAttempts = Math.max(1, options.writeAttempts ?? 3);
  const retryDelayMs = options.retryDelayMs ?? 100;
  const tables = options.priceTables ?? PRICE_TABLES;
  let failed = false;
  let totals: MeteredTotals = ZERO_TOTALS;

  const recordOf = (
    callId: string,
    index: number,
    role: LlmRole,
    provider: string,
    attempt: Attempt,
  ): LlmUsageRecord => {
    const model = MODEL.test(attempt.model) ? attempt.model : UNRECOGNISED;
    const safeProvider = PROVIDER.test(provider) ? provider : UNRECOGNISED;
    const tokens = attempt.usage === undefined ? null : tokensOf(attempt.usage);
    if (attempt.usage !== undefined && tokens === null) {
      log.warn({ callId, role, attempt: index, errorCode: "llm_usage_out_of_range" }, "llm usage");
    }
    const usageStatus: LlmUsageStatus =
      tokens === null ? "unreported" : attempt.partial ? "partial" : "reported";
    const table = priceTableAt(clock.now(), tables);
    const price = table === undefined ? undefined : modelPrice(table, safeProvider, model);
    // A refusal before any output is billed only in some refusal categories, which Rocky does
    // not see; a failed call's partial usage has no published billing rule (ADR 0015 §3).
    const unverified =
      usageStatus === "partial" || (attempt.outcome === "refused" && tokens?.outputTokens === 0);
    let costStatus: LlmCostStatus;
    let cost: number | null = null;
    if (tokens === null) costStatus = "no_usage";
    else if (price === undefined) costStatus = "no_price";
    else if (unverified) costStatus = "billing_unverified";
    else {
      costStatus = "priced";
      cost = costMicroUsd(price, tokens);
    }
    return Object.freeze({
      callId,
      attempt: index,
      role,
      provider: safeProvider,
      model,
      ...(options.analysisId === undefined ? {} : { analysisId: options.analysisId }),
      outcome: attempt.outcome,
      ...(attempt.errorKind === undefined ? {} : { errorKind: attempt.errorKind }),
      usageStatus,
      tokens: tokens === null ? null : Object.freeze(tokens),
      costMicroUsd: cost,
      costStatus,
      priceVersion: table?.version ?? "none",
    });
  };

  const tally = (records: readonly LlmUsageRecord[]): void => {
    let next = { ...totals, calls: totals.calls + 1, records: totals.records + records.length };
    for (const record of records) {
      const t = record.tokens;
      next = {
        ...next,
        inputTokens: next.inputTokens + (t?.inputTokens ?? 0),
        outputTokens: next.outputTokens + (t?.outputTokens ?? 0),
        cacheReadTokens: next.cacheReadTokens + (t?.cacheReadTokens ?? 0),
        cacheWrite5mTokens: next.cacheWrite5mTokens + (t?.cacheWrite5mTokens ?? 0),
        cacheWrite1hTokens: next.cacheWrite1hTokens + (t?.cacheWrite1hTokens ?? 0),
        costMicroUsd: next.costMicroUsd + (record.costMicroUsd ?? 0),
        unpriced: next.unpriced + (record.costStatus === "priced" ? 0 : 1),
      };
    }
    totals = next;
  };

  /** Writes the records; on final failure logs them (numbers only) and fails closed. */
  const write = async (records: readonly LlmUsageRecord[]): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= writeAttempts; attempt++) {
      try {
        await sink.record(records);
        tally(records);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < writeAttempts) await wait(retryDelayMs * attempt);
      }
    }
    failed = true;
    const sqlstate = sqlstateOf(lastError);
    for (const record of records) {
      // The durable fallback for usage the database refused: ids, enums and counts only.
      // Field names avoid the log scrubber's credential rules (`code`, `*Tokens` beyond the
      // allowlisted input/output counts), which would redact them.
      log.error(
        {
          errorCode: "llm_usage_unrecorded",
          ...(sqlstate === undefined ? {} : { sqlstate }),
          analysisId: record.analysisId,
          callId: record.callId,
          attempt: record.attempt,
          role: record.role,
          provider: record.provider,
          model: record.model,
          outcome: record.outcome,
          usageStatus: record.usageStatus,
          inputTokens: record.tokens?.inputTokens,
          outputTokens: record.tokens?.outputTokens,
          cacheReadCount: record.tokens?.cacheReadTokens,
          cacheWrite5mCount: record.tokens?.cacheWrite5mTokens,
          cacheWrite1hCount: record.tokens?.cacheWrite1hTokens,
          costMicroUsd: record.costMicroUsd,
          costStatus: record.costStatus,
          priceVersion: record.priceVersion,
        },
        "llm usage not recorded",
      );
    }
    throw new LlmMeteringError();
  };

  const refuseIfFailed = (): void => {
    if (failed) throw new LlmMeteringError();
  };

  const attemptsOfResult = (result: StructuredCompletionResult<unknown>): Attempt[] => {
    const reported = result.attempts;
    if (reported === undefined || reported.length === 0) {
      return [{ model: result.model, outcome: result.status, usage: result.usage, partial: false }];
    }
    // Every attempt before the last is a model that declined; the last produced the result.
    return reported.map((attempt, index) => ({
      model: attempt.model,
      outcome: index === reported.length - 1 ? result.status : "refused",
      usage: attempt.usage,
      partial: false,
    }));
  };

  const attemptOfError = (error: unknown, target: UsageTarget | null): Attempt => ({
    model: target?.model ?? UNRECOGNISED,
    outcome: "error",
    ...(isLlmCallError(error) ? { errorKind: error.kind } : {}),
    usage: isLlmCallError(error) ? error.partialUsage : undefined,
    partial: true,
  });

  const completions = new Map<LlmCompletionRole, CompletionRoleClient>();
  for (const role of LLM_COMPLETION_ROLES) {
    completions.set(role, {
      role,
      complete: async <T>(
        request: StructuredCompletionRequest<T>,
      ): Promise<StructuredCompletionResult<T>> => {
        refuseIfFailed();
        const inner = roles.completion(role);
        const callId = newCallId();
        let result: StructuredCompletionResult<T>;
        try {
          result = await inner.complete(request);
        } catch (error) {
          const target = targets[role];
          await write([recordOf(callId, 0, role, target.provider, attemptOfError(error, target))]);
          throw error;
        }
        await write(
          attemptsOfResult(result).map((attempt, index) =>
            recordOf(callId, index, role, result.provider, attempt),
          ),
        );
        return result;
      },
    });
  }

  const innerEmbedding = roles.embedding();
  const embedding: EmbeddingRoleClient | undefined =
    innerEmbedding === undefined
      ? undefined
      : {
          embed: async (request) => {
            refuseIfFailed();
            const callId = newCallId();
            let result: Awaited<ReturnType<EmbeddingRoleClient["embed"]>>;
            try {
              result = await innerEmbedding.embed(request);
            } catch (error) {
              const target = targets.embed;
              await write([
                recordOf(
                  callId,
                  0,
                  "embed",
                  target?.provider ?? UNRECOGNISED,
                  attemptOfError(error, target),
                ),
              ]);
              throw error;
            }
            await write([
              recordOf(callId, 0, "embed", result.provider, {
                model: result.model,
                outcome: "ok",
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: 0,
                  cacheReadInputTokens: 0,
                  cacheWrite5mInputTokens: 0,
                  cacheWrite1hInputTokens: 0,
                },
                partial: false,
              }),
            ]);
            return result;
          },
        };

  return {
    completion: (role) => {
      const client = completions.get(role);
      if (client === undefined) throw new TypeError("unknown completion role");
      return client;
    },
    embedding: () => embedding,
    get failed() {
      return failed;
    },
    totals: () => totals,
  };
};
