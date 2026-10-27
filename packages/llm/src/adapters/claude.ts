import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type {
  BetaMessage,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  isLlmCallError,
  LlmCallError,
  type LlmAttemptUsage,
  type LlmProvider,
  type LlmUsage,
  type ProviderCompletionCall,
  type ProviderCompletionResult,
} from "@rocky-reviews/core";
import { callError, cancelledBy, kindForStatus, kindForType } from "./errors.js";
import { tokens, toResult, type Answer, type StopKind } from "./output.js";
import { nonceSource, type AdapterTransport } from "./transport.js";
import { buildPrompt, checkOutputCap, type Prompt } from "./untrusted.js";

/**
 * The Claude Messages adapter shared by the Anthropic API, Bedrock, Vertex and Foundry (P4-2,
 * ADR 0013 §1–4). A platform supplies only its SDK client and its model-id rule; the request,
 * the result and the error mapping are the same everywhere.
 */

/** The slice of an Anthropic SDK client this adapter uses (every platform client has it). */
export interface ClaudeMessagesClient {
  readonly beta: {
    readonly messages: {
      stream(
        body: BetaMessageStreamParams,
        options?: { signal?: AbortSignal | undefined },
      ): { finalMessage(): Promise<BetaMessage> };
    };
  };
}

export interface ClaudePlatform {
  /** Canonical catalogue id → the platform's form, when the role sets no `platformModel`. */
  readonly modelId: (model: string) => string;
  /** The SDK client for one call. Keyed platforms read the key here, at call time (T1). */
  readonly client: () => ClaudeMessagesClient;
  /** Server-side refusal fallbacks (Anthropic API only; ADR 0013 §1). */
  readonly serverFallbacks: boolean;
}

/** These take only `budget_tokens` thinking; every other catalogued model takes adaptive. */
const NO_ADAPTIVE_THINKING: ReadonlySet<string> = new Set(["claude-haiku-4-5", "claude-opus-4-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const wireSchemas = new WeakMap<object, Record<string, unknown>>();

/** The schema the API accepts: the SDK strips constraints it rejects; the validator keeps them. */
const wireSchema = (schema: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const cached = wireSchemas.get(schema);
  if (cached !== undefined) return cached;
  if (schema["type"] !== "object") throw new LlmCallError("invalid_request");
  const transformed = jsonSchemaOutputFormat(schema as never).schema as Record<string, unknown>;
  wireSchemas.set(schema, transformed);
  return transformed;
};

const requestFor = (
  call: ProviderCompletionCall<unknown>,
  prompt: Prompt,
  platform: ClaudePlatform,
): BetaMessageStreamParams => ({
  model: call.platformModel ?? platform.modelId(call.model),
  max_tokens: call.maxOutputTokens,
  // The only cache breakpoint: Rocky's instructions, never PR content (T5).
  system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
  messages: [
    {
      role: "user",
      content: [...prompt.parts, prompt.final].map((text) => ({ type: "text" as const, text })),
    },
  ],
  output_config: {
    format: { type: "json_schema", schema: wireSchema(call.output.jsonSchema) },
    ...(call.effort === undefined ? {} : { effort: call.effort }),
  },
  ...(NO_ADAPTIVE_THINKING.has(call.model) ? {} : { thinking: { type: "adaptive" as const } }),
  ...(platform.serverFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
});

interface UsageLike {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: number | null;
    readonly ephemeral_1h_input_tokens?: number | null;
  } | null;
}

/**
 * Anthropic usage → `LlmUsage`. The TTL breakdown is used when it adds up to the write total; a
 * stream can carry a stale breakdown from `message_start`, and a platform may omit it. Otherwise
 * the total counts as 5-minute writes, the only TTL Rocky requests.
 */
export const usageOf = (usage: UsageLike): LlmUsage => {
  const total = tokens(usage.cache_creation_input_tokens);
  const fiveMinutes = tokens(usage.cache_creation?.ephemeral_5m_input_tokens);
  const oneHour = tokens(usage.cache_creation?.ephemeral_1h_input_tokens);
  const split = usage.cache_creation != null && fiveMinutes + oneHour === total;
  return {
    inputTokens: tokens(usage.input_tokens),
    outputTokens: tokens(usage.output_tokens),
    cacheReadInputTokens: tokens(usage.cache_read_input_tokens),
    cacheWrite5mInputTokens: split ? fiveMinutes : total,
    cacheWrite1hInputTokens: split ? oneHour : 0,
  };
};

const STOPS: Readonly<Record<string, StopKind>> = {
  end_turn: "complete",
  refusal: "refused",
  max_tokens: "truncated",
  model_context_window_exceeded: "truncated",
};

export const answerOf = (message: BetaMessage, requestedModel: string): Answer => {
  const content = message.content;
  // A mid-stream decline keeps its partial output before the last `fallback` block.
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  const text = content
    .slice(boundary + 1)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const iterations = message.usage.iterations ?? [];
  const fellBack =
    boundary >= 0 || iterations.some((iteration) => iteration.type === "fallback_message");
  const attempts: LlmAttemptUsage[] | undefined = fellBack
    ? iterations.flatMap((iteration) =>
        iteration.type === "message" || iteration.type === "fallback_message"
          ? [{ model: iteration.model ?? requestedModel, usage: usageOf(iteration) }]
          : [],
      )
    : undefined;
  return {
    stop: STOPS[message.stop_reason ?? ""] ?? "unexpected",
    text,
    model: fellBack ? message.model : requestedModel,
    usage: usageOf(message.usage),
    attempts: attempts !== undefined && attempts.length > 0 ? attempts : undefined,
  };
};

const providerMessage = (error: APIError): string | undefined => {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === "string" ? message : undefined;
};

/** Any failure → `LlmCallError`, with nothing from the provider but a retry hint (T7). */
export const toCallError = (error: unknown, signal: AbortSignal | undefined): LlmCallError => {
  if (isLlmCallError(error)) return error;
  if (error instanceof APIUserAbortError || cancelledBy(signal)) {
    return new LlmCallError("cancelled");
  }
  if (error instanceof APIConnectionTimeoutError) return new LlmCallError("timeout");
  if (error instanceof APIConnectionError) return new LlmCallError("network");
  if (error instanceof APIError) {
    // An `error` event mid-stream has no status: its type decides.
    if (error.status === undefined) return callError(kindForType(error.type));
    const kind =
      error.type === "overloaded_error"
        ? "overloaded"
        : kindForStatus(error.status, providerMessage(error));
    return callError(kind, error.headers);
  }
  // Unexpected (an SDK invariant, a programming error): never rethrown, its text may quote a body.
  return new LlmCallError("server_error");
};

export const claudeProvider = (
  platform: ClaudePlatform,
  transport: AdapterTransport,
): LlmProvider => {
  const nonce = nonceSource(transport);
  return {
    completeStructured: async <T>(
      call: ProviderCompletionCall<T>,
    ): Promise<ProviderCompletionResult<T>> => {
      checkOutputCap(call.maxOutputTokens);
      const prompt = buildPrompt(call, nonce);
      const params = requestFor(call, prompt, platform);
      if (cancelledBy(call.signal)) throw new LlmCallError("cancelled");
      let message: BetaMessage;
      try {
        const options = call.signal === undefined ? {} : { signal: call.signal };
        message = await platform.client().beta.messages.stream(params, options).finalMessage();
      } catch (error) {
        throw toCallError(error, call.signal);
      }
      return toResult(answerOf(message, call.model), call.output);
    },
  };
};
