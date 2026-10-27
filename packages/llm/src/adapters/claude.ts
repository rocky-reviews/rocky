import {
  AnthropicError,
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
import type { ProviderKind } from "../providers.js";
import { assertAmbientAtCall } from "./ambient.js";
import { callError, cancelledBy, kindForStatus, kindForType } from "./errors.js";
import { guarded, tokens, toResult, type Answer, type StopKind } from "./output.js";
import {
  cappedFetch,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  nonceSource,
  type AdapterTransport,
  type ByteBudget,
} from "./transport.js";
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
      ): ClaudeMessageStream;
    };
  };
}

/** The slice of a `BetaMessageStream` this adapter uses. */
export interface ClaudeMessageStream {
  on(event: "streamEvent", listener: (event: { readonly type: string }) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
}

export interface ClaudePlatform {
  readonly kind: Extract<ProviderKind, "anthropic" | "bedrock" | "vertex" | "foundry">;
  /** Canonical catalogue id → the platform's form, when the role sets no `platformModel`. */
  readonly modelId: (model: string) => string;
  /**
   * The SDK client for one call, over the call's capped `fetch` (T9). Keyed platforms read the key
   * here, at call time (T1); platform SDKs are imported here, on first use (N6).
   */
  readonly client: (fetch: typeof globalThis.fetch) => Promise<ClaudeMessagesClient>;
  /** Server-side refusal fallbacks for this canonical model (Anthropic API only; ADR 0013 §1). */
  readonly serverFallbacks: (model: string) => boolean;
}

/** These take only `budget_tokens` thinking; every other catalogued model takes adaptive. */
const NO_ADAPTIVE_THINKING: ReadonlySet<string> = new Set(["claude-haiku-4-5", "claude-opus-4-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** The models that take `fallbacks: "default"`; Haiku 5.5 and older models reject it. */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

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
  ...(platform.serverFallbacks(call.model)
    ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
    : {}),
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

const usageField = (value: unknown): UsageLike | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UsageLike)
    : undefined;

/**
 * The usage a stream has reported so far (`message_start`, then each `message_delta`), so a call
 * that fails part-way still tells metering what the provider counted (P4-5, ADR 0015). Later
 * fields win; a field a delta leaves out keeps its earlier value.
 */
export const reportedUsage = (
  previous: UsageLike | undefined,
  event: { readonly type: string },
): UsageLike | undefined => {
  const raw =
    event.type === "message_start"
      ? usageField((event as { message?: { usage?: unknown } }).message?.usage)
      : event.type === "message_delta"
        ? usageField((event as { usage?: unknown }).usage)
        : undefined;
  if (raw === undefined) return previous;
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged as UsageLike;
};

/** The call's error, carrying what the provider had reported before it failed. */
const withPartialUsage = (error: LlmCallError, reported: UsageLike | undefined): LlmCallError =>
  reported === undefined || error.partialUsage !== undefined
    ? error
    : new LlmCallError(error.kind, {
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        partialUsage: usageOf(reported),
      });

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

/** How a call ended, beyond the error itself: whose signal fired, and whether the cap did. */
export interface CallState {
  readonly signal: AbortSignal | undefined;
  readonly deadline?: AbortSignal;
  readonly budget?: ByteBudget;
  /** The stream began but never sent `message_stop`. */
  readonly unfinished?: () => boolean;
}

/** Node and undici codes for a link that failed, as opposed to a body that did not parse. */
const IO_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const codeOf = (value: unknown): unknown =>
  typeof value === "object" && value !== null ? (value as { code?: unknown }).code : undefined;

/**
 * An I/O failure: fetch's `TypeError` ("fetch failed", undici's "terminated") or a socket error
 * code, on the error or its cause. A `SyntaxError` from malformed event JSON is not one.
 */
export const isIoFailure = (cause: unknown): boolean => {
  if (cause instanceof TypeError) return true;
  const inner = typeof cause === "object" && cause !== null ? (cause as Error).cause : undefined;
  return [codeOf(cause), codeOf(inner)].some(
    (code) => typeof code === "string" && IO_CODES.has(code),
  );
};

/** Any failure → `LlmCallError`, with nothing from the provider but a retry hint (T7). */
export const toCallError = (error: unknown, state: CallState): LlmCallError => {
  if (isLlmCallError(error)) return error;
  if (cancelledBy(state.signal)) return new LlmCallError("cancelled");
  // A body past the cap wins over its status: an endpoint that sends that much is broken or
  // hostile, and a status it sent (401, 400) is not trusted to classify the failure (T9).
  if (state.budget?.exceeded === true) return new LlmCallError("server_error");
  if (state.deadline?.aborted === true) return new LlmCallError("timeout");
  if (error instanceof APIUserAbortError) return new LlmCallError("cancelled");
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
  if (error instanceof AnthropicError) {
    // The SDK wraps what failed mid-stream as `cause`: a dropped link is `network`; anything
    // else (malformed event JSON, an SDK invariant) is a broken answer (review round 2, nit 2).
    if (error.cause !== undefined) {
      return new LlmCallError(isIoFailure(error.cause) ? "network" : "server_error");
    }
    // The SDK's own "stream ended without producing a Message": the link dropped mid-answer (N3).
    if (state.unfinished?.() === true) return new LlmCallError("network");
  }
  // Unexpected (an SDK invariant, a programming error): never rethrown, its text may quote a body.
  return new LlmCallError("server_error");
};

/** Rejects with the signal's reason once it aborts; `release` drops the listener. */
const abortion = (signal: AbortSignal): { promise: Promise<never>; release: () => void } => {
  let release: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    release = () => signal.removeEventListener("abort", abort);
  });
  return { promise, release };
};

export const claudeProvider = (
  platform: ClaudePlatform,
  transport: AdapterTransport,
): LlmProvider => {
  const nonce = nonceSource(transport);
  const baseFetch = transport.fetch ?? globalThis.fetch;
  const timeoutMs = transport.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = transport.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return {
    completeStructured: async <T>(
      call: ProviderCompletionCall<T>,
    ): Promise<ProviderCompletionResult<T>> => {
      assertAmbientAtCall(platform.kind);
      checkOutputCap(call.maxOutputTokens);
      const prompt = buildPrompt(call, nonce);
      const params = requestFor(call, prompt, platform);
      if (cancelledBy(call.signal)) throw new LlmCallError("cancelled");
      // The SDK's `timeout` stops once headers arrive, and covers neither credential lookups nor
      // its own auth middleware; this deadline covers the whole call (T9, review round 2 S1).
      const timer = new AbortController();
      const clock = setTimeout(() => timer.abort(), timeoutMs);
      const deadline = timer.signal;
      const signal =
        call.signal === undefined ? deadline : AbortSignal.any([call.signal, deadline]);
      const ended = abortion(signal);
      const budget: ByteBudget = { exceeded: false };
      let started = false;
      let stopped = false;
      let reported: UsageLike | undefined;
      const state: CallState = {
        signal: call.signal,
        deadline,
        budget,
        unfinished: () => started && !stopped,
      };
      const exchange = async (): Promise<BetaMessage> => {
        const client = await platform.client(cappedFetch(baseFetch, cap, budget));
        const stream = client.beta.messages.stream(params, { signal });
        stream.on("streamEvent", (event) => {
          started = true;
          reported = reportedUsage(reported, event);
          if (event.type === "message_stop") stopped = true;
        });
        const final = await stream.finalMessage();
        // The SDK returns the partial message when the stream ends early: that is a dropped link.
        if (!stopped) throw new LlmCallError("network");
        return final;
      };
      let message: BetaMessage;
      try {
        // Credential lookups take no signal: the race ends the call; the lookup is abandoned.
        message = await Promise.race([exchange(), ended.promise]);
      } catch (error) {
        throw withPartialUsage(toCallError(error, state), reported);
      } finally {
        clearTimeout(clock);
        ended.release();
      }
      return guarded(() => toResult(answerOf(message, call.model), call.output));
    },
  };
};
