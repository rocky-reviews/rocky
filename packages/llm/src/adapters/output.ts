import {
  isLlmCallError,
  LlmCallError,
  type LlmAttemptUsage,
  type LlmOutputSchema,
  type LlmUsage,
  type ProviderCompletionResult,
} from "@rocky-reviews/core";

/**
 * Turns a finished answer into the port's result (P4-2, ADR 0013 §3). Only a normal stop is
 * parsed; the validator decides `ok` versus `invalid_output`, and its issues are path-only.
 */

export type StopKind = "complete" | "refused" | "truncated" | "unexpected";

export interface Answer {
  readonly stop: StopKind;
  readonly text: string;
  readonly model: string;
  readonly usage: LlmUsage | undefined;
  readonly attempts?: readonly LlmAttemptUsage[] | undefined;
}

export const toResult = <T>(
  answer: Answer,
  output: LlmOutputSchema<T>,
): ProviderCompletionResult<T> => {
  const base = {
    model: answer.model,
    usage: answer.usage,
    ...(answer.attempts === undefined ? {} : { attempts: answer.attempts }),
  };
  switch (answer.stop) {
    case "refused":
    case "truncated":
      return { status: answer.stop, ...base };
    case "unexpected":
      return { status: "invalid_output", ...base, issues: ["(root): unexpected_stop"] };
    case "complete": {
      let value: unknown;
      try {
        value = JSON.parse(answer.text);
      } catch {
        return { status: "invalid_output", ...base, issues: ["(root): invalid_json"] };
      }
      const parsed = output.parse(value);
      return parsed.success
        ? { status: "ok", value: parsed.data, ...base }
        : { status: "invalid_output", ...base, issues: parsed.issues };
    }
  }
};

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
};

/** A non-negative whole token count, or undefined for anything a server got wrong. */
export const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * An optional count (cache fields a provider leaves out when nothing was cached): absent or null
 * is 0, a present malformed value is undefined (the whole usage block is then not trusted).
 */
export const optionalCount = (value: unknown): number | undefined =>
  value === undefined || value === null ? 0 : count(value);

/**
 * Runs post-processing of an untrusted answer (review round 1, S2). Anything thrown that is not an
 * `LlmCallError` (a validator tripping on a hostile shape, a missed guard) becomes `server_error`:
 * a raw error could carry provider or model text, and the port promises `LlmCallError` only.
 */
export const guarded = <R>(read: () => R): R => {
  try {
    return read();
  } catch (error) {
    if (isLlmCallError(error)) throw error;
    throw new LlmCallError("server_error");
  }
};
