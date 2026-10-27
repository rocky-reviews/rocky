import type {
  LlmAttemptUsage,
  LlmOutputSchema,
  LlmUsage,
  ProviderCompletionResult,
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
  readonly usage: LlmUsage;
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

/** A non-negative whole token count, or 0 for anything a server got wrong. */
export const tokens = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
