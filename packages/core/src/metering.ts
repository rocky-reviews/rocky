/**
 * Metering port (P4-5, ADR 0016). Every LLM call becomes one usage record per attempt the
 * provider reported: who (role, provider, model), what came back (outcome), what the provider
 * reported (tokens, or that it reported none) and what it costs at list price (micro-USD, or why
 * it has no price). A record holds ids, enums and numbers only: never a prompt, code, a diff or
 * model output. `packages/llm` builds the records; `packages/db` stores them.
 */
import type { LlmErrorKind, LlmRole } from "./llm.js";

/** How the attempt ended. `error`: the call threw (the error kind is recorded alongside). */
export const LLM_USAGE_OUTCOMES = [
  "ok",
  "refused",
  "truncated",
  "invalid_output",
  "error",
] as const;
export type LlmUsageOutcome = (typeof LLM_USAGE_OUTCOMES)[number];

/**
 * - `reported`: the provider reported this attempt's usage in a finished response.
 * - `partial`: the call failed after the provider had reported some usage (a stream that broke
 *   after `message_start`); the counts are what it reported so far.
 * - `unreported`: the provider reported nothing usable (a call that failed before any answer, or
 *   counts out of range). Token columns are null: Rocky never invents a count.
 */
export const LLM_USAGE_STATUSES = ["reported", "partial", "unreported"] as const;
export type LlmUsageStatus = (typeof LLM_USAGE_STATUSES)[number];

/**
 * - `priced`: `costMicroUsd` is the list price of the reported tokens under `priceVersion`.
 * - `no_price`: the price table has no verified entry for this provider and model (an unknown
 *   model, a platform whose prices are not verified, a local server). Never guessed.
 * - `billing_unverified`: the tokens are known but whether the provider bills them is not (a
 *   refusal before any output, whose billing depends on a category Rocky does not see; partial
 *   usage of a failed call).
 * - `no_usage`: nothing was reported, so there is nothing to price.
 */
export const LLM_COST_STATUSES = ["priced", "no_price", "billing_unverified", "no_usage"] as const;
export type LlmCostStatus = (typeof LLM_COST_STATUSES)[number];

export interface LlmUsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
}

export interface LlmUsageRecord {
  /** One id per role call; a server-side fallback chain shares it across its attempts. */
  readonly callId: string;
  /** 0-based position of the attempt inside the call (a fallback chain has several). */
  readonly attempt: number;
  readonly role: LlmRole;
  /** The provider kind (`anthropic`, `bedrock`, …), as the registry stamped it. */
  readonly provider: string;
  /** The canonical model id that ran this attempt (a fallback may have switched it). */
  readonly model: string;
  /** The analysis the call was made for, when there is one. */
  readonly analysisId?: string;
  readonly outcome: LlmUsageOutcome;
  /** Set exactly when `outcome` is `error`. */
  readonly errorKind?: LlmErrorKind;
  readonly usageStatus: LlmUsageStatus;
  /** Null exactly when `usageStatus` is `unreported`. */
  readonly tokens: LlmUsageTokens | null;
  /** Integer micro-USD at list price; null exactly when `costStatus` is not `priced`. */
  readonly costMicroUsd: number | null;
  readonly costStatus: LlmCostStatus;
  /** The price table version consulted (`none` when no table was in effect). */
  readonly priceVersion: string;
}

/** Where usage records go: one write per call, awaited before the call's result is handed on. */
export interface LlmUsageSink {
  /** Must be idempotent per `(callId, attempt)`: a write retried after an unclear failure. */
  record(records: readonly LlmUsageRecord[]): Promise<void>;
}

/** The metering write failed; the call's usage was logged (numbers and ids only) instead. */
export class LlmMeteringError extends Error {
  override readonly name = "LlmMeteringError";
  constructor() {
    super("llm usage could not be recorded");
  }
}

export const isLlmMeteringError = (value: unknown): value is LlmMeteringError =>
  value instanceof LlmMeteringError;
