/**
 * Token accounting and the spend cap for an eval run (P4-7). Not billing: P4-5 meters cost into
 * `llm_usage`; this only counts tokens per role so a report can show them and `--max-tokens` can
 * stop a run. The cap is checked before every call, so a run overshoots it by at most the calls
 * already in flight (the pipeline's concurrency). A refused call is a `cancelled` LlmCallError,
 * which fails the analysis it belongs to; the runner marks it and everything after it `capped`.
 *
 * Retryable failures (rate limits, overload) are retried twice, waiting the provider's hint or
 * 2 s, then 4 s, as the worker's queue would; anything else is returned as it came.
 */
import {
  isLlmCallError,
  LlmCallError,
  type CompletionRoleClient,
  type LlmCompletionRole,
  type LlmRoles,
  type LlmUsage,
  type StructuredCompletionResult,
} from "@rocky-reviews/core";
import type { RoleUsage, UsageReport } from "./report.js";

export const RETRIES = 2;

export interface MeterOptions {
  readonly maxTokens: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Meter {
  wrap(roles: LlmRoles): LlmRoles;
  usage(): UsageReport;
  capped(): boolean;
}

const tokensOf = (usage: LlmUsage): number =>
  usage.inputTokens +
  usage.outputTokens +
  usage.cacheReadInputTokens +
  usage.cacheWrite5mInputTokens +
  usage.cacheWrite1hInputTokens;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createMeter = ({ maxTokens, sleep = wait }: MeterOptions): Meter => {
  const byRole = new Map<LlmCompletionRole, { -readonly [K in keyof RoleUsage]: RoleUsage[K] }>();
  let total = 0;
  let capped = false;

  const record = (role: LlmCompletionRole, result: StructuredCompletionResult<unknown>) => {
    const entry = byRole.get(role) ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      models: [],
    };
    entry.calls++;
    for (const attempt of result.attempts ?? [{ model: result.model, usage: result.usage }]) {
      entry.inputTokens += attempt.usage.inputTokens;
      entry.outputTokens += attempt.usage.outputTokens;
      entry.cacheReadInputTokens += attempt.usage.cacheReadInputTokens;
      entry.cacheWriteInputTokens +=
        attempt.usage.cacheWrite5mInputTokens + attempt.usage.cacheWrite1hInputTokens;
      total += tokensOf(attempt.usage);
      if (!entry.models.includes(attempt.model)) entry.models = [...entry.models, attempt.model];
    }
    byRole.set(role, entry);
  };

  const wrapClient = (client: CompletionRoleClient): CompletionRoleClient => ({
    role: client.role,
    complete: async (request) => {
      for (let attempt = 0; ; attempt++) {
        if (total >= maxTokens) {
          capped = true;
          throw new LlmCallError("cancelled");
        }
        try {
          const result = await client.complete(request);
          record(client.role, result);
          return result;
        } catch (error) {
          if (!isLlmCallError(error) || !error.retryable || attempt >= RETRIES) throw error;
          await sleep(error.retryAfterMs ?? 2_000 * 2 ** attempt);
        }
      }
    },
  });

  return {
    wrap: (roles) => ({
      completion: (role) => wrapClient(roles.completion(role)),
      embedding: () => roles.embedding(),
    }),
    usage: () => ({
      byRole: Object.fromEntries([...byRole].map(([role, entry]) => [role, { ...entry }])),
      totalTokens: total,
      capped,
    }),
    capped: () => capped,
  };
};
