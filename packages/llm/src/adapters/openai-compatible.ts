import {
  isLlmCallError,
  LlmCallError,
  type LlmProvider,
  type LlmUsage,
  type ProviderCompletionCall,
  type ProviderCompletionResult,
  type ProviderEmbeddingCall,
  type ProviderEmbeddingResult,
} from "@rocky-reviews/core";
import type { ProviderAdapterFactory } from "../registry.js";
import { callError, cancelledBy, kindForStatus } from "./errors.js";
import { count, guarded, optionalCount, toResult, ZERO_USAGE, type StopKind } from "./output.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  nonceSource,
  type AdapterTransport,
} from "./transport.js";
import { buildPrompt, checkOutputCap } from "./untrusted.js";

/**
 * OpenAI-compatible adapter for Ollama and vLLM (P4-2, ADR 0013 §5): `POST /chat/completions` and
 * `POST /embeddings` over `fetch`, no SDK. Structured output is `response_format: json_schema`,
 * with the schema also in the system message for servers that ignore it (the documented
 * fallback); the port's validator decides either way.
 */

const SCHEMA_NAME = /[^A-Za-z0-9_-]/g;

const endpoint = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${path}`;

/** Reads at most `cap` bytes; more is a broken server, not an answer. */
const readCapped = async (response: Response, cap: number): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    throw new LlmCallError("server_error");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new LlmCallError("server_error");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The provider's error message, read only to recognise a context-length failure. */
const errorMessage = (body: unknown): string | undefined => {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : undefined;
};

interface Exchange {
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One POST; failures become `LlmCallError` with only the status kind and retry hint (T7). */
const post = async (
  exchange: Exchange,
  url: string,
  key: string | undefined,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => {
  if (cancelledBy(signal)) throw new LlmCallError("cancelled");
  const timer = new AbortController();
  const clock = setTimeout(() => timer.abort(), exchange.timeoutMs);
  const timeout = timer.signal;
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const response = await exchange.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify(body),
      // A redirect could carry the key or PR content to another host (T3).
      redirect: "error",
      signal: combined,
    });
    const text = await readCapped(response, exchange.maxResponseBytes);
    const parsed = parseJson(text);
    if (!response.ok) {
      throw callError(kindForStatus(response.status, errorMessage(parsed)), response.headers);
    }
    // An answer is a JSON object; `null`, an array or a scalar is a broken server (S2).
    if (!isObject(parsed)) throw new LlmCallError("server_error");
    return parsed;
  } catch (error) {
    if (isLlmCallError(error)) throw error;
    if (cancelledBy(signal)) throw new LlmCallError("cancelled");
    if (timeout.aborted) throw new LlmCallError("timeout");
    throw new LlmCallError("network");
  } finally {
    clearTimeout(clock);
  }
};

/** An answer as received: every field is checked before use. */
interface ChatCompletion {
  readonly choices?: unknown;
  readonly usage?: unknown;
}

/**
 * OpenAI counts cached tokens inside `prompt_tokens`; the port counts them apart. Undefined when
 * the server sent no usage, or a block that cannot be trusted (P4-5 review 1, ADR 0016 §2): both
 * counts are required non-negative integers; `cached_tokens` is optional (absent or null is 0)
 * but, when present, must be a count no larger than `prompt_tokens`.
 */
const chatUsage = (usage: ChatCompletion["usage"]): LlmUsage | undefined => {
  if (!isObject(usage)) return undefined;
  const prompt = count(usage.prompt_tokens);
  const completion = count(usage.completion_tokens);
  const details = usage.prompt_tokens_details;
  if (details !== undefined && details !== null && !isObject(details)) return undefined;
  const cached = optionalCount(isObject(details) ? details["cached_tokens"] : undefined);
  if (prompt === undefined || completion === undefined || cached === undefined || cached > prompt) {
    return undefined;
  }
  return {
    ...ZERO_USAGE,
    inputTokens: prompt - cached,
    outputTokens: completion,
    cacheReadInputTokens: cached,
  };
};

const stopOf = (choice: unknown): StopKind => {
  if (!isObject(choice)) return "unexpected";
  const message = isObject(choice["message"]) ? choice["message"] : {};
  const refusal = message["refusal"];
  if (typeof refusal === "string" && refusal !== "") return "refused";
  switch (choice["finish_reason"]) {
    case "stop":
      return "complete";
    case "length":
      return "truncated";
    case "content_filter":
      return "refused";
    default:
      return "unexpected";
  }
};

/**
 * Embeddings by `index`, which must be exactly 0..n-1 (each once, integers only); anything else
 * could pair a vector with the wrong input (review round 1, item 3).
 */
const inInputOrder = (data: unknown, count: number): unknown[] => {
  if (!Array.isArray(data) || data.length !== count) throw new LlmCallError("invalid_request");
  const vectors: unknown[] = new Array<unknown>(count);
  const seen = new Set<number>();
  for (const entry of data) {
    const index = isObject(entry) ? entry["index"] : undefined;
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count ||
      seen.has(index)
    ) {
      throw new LlmCallError("invalid_request");
    }
    seen.add(index);
    vectors[index] = (entry as Record<string, unknown>)["embedding"];
  }
  return vectors;
};

export const openAiCompatibleAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"openai-compatible"> =>
  (settings, secrets) => {
    const exchange: Exchange = {
      fetch: transport.fetch ?? globalThis.fetch,
      timeoutMs: transport.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: transport.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    };
    const nonce = nonceSource(transport);
    /** Read at call time only (T1); a configured but empty key fails before anything is sent. */
    const key = (): string | undefined => {
      if (settings.apiKeyEnv === undefined) return undefined;
      const value = secrets.get(settings.apiKeyEnv);
      if (value === undefined || value === "") throw new LlmCallError("auth");
      return value;
    };

    const completeStructured = async <T>(
      call: ProviderCompletionCall<T>,
    ): Promise<ProviderCompletionResult<T>> => {
      checkOutputCap(call.maxOutputTokens);
      const prompt = buildPrompt(call, nonce);
      const schema = JSON.stringify(call.output.jsonSchema);
      const body = {
        model: call.model,
        messages: [
          {
            role: "system",
            content: `${prompt.system}\n\nOutput JSON schema:\n${schema}`,
          },
          { role: "user", content: [...prompt.parts, prompt.final].join("\n\n") },
        ],
        max_tokens: call.maxOutputTokens,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: call.output.name.replace(SCHEMA_NAME, "_").slice(0, 64),
            schema: call.output.jsonSchema,
            strict: true,
          },
        },
        ...(call.effort === undefined ? {} : { reasoning_effort: call.effort }),
      };
      const answer = (await post(
        exchange,
        endpoint(settings.baseUrl, "chat/completions"),
        key(),
        body,
        call.signal,
      )) as ChatCompletion;
      return guarded(() => {
        const choice: unknown = Array.isArray(answer.choices) ? answer.choices[0] : undefined;
        const message = isObject(choice) && isObject(choice["message"]) ? choice["message"] : {};
        const content = message["content"];
        return toResult(
          {
            stop: stopOf(choice),
            text: typeof content === "string" ? content : "",
            model: call.model,
            usage: chatUsage(answer.usage),
          },
          call.output,
        );
      });
    };

    const embed = async (call: ProviderEmbeddingCall): Promise<ProviderEmbeddingResult> => {
      const answer = (await post(
        exchange,
        endpoint(settings.baseUrl, "embeddings"),
        key(),
        { model: call.model, input: call.inputs, encoding_format: "float" },
        call.signal,
      )) as { data?: unknown; usage?: unknown };
      return guarded(() => {
        const vectors = inInputOrder(answer.data, call.inputs.length);
        // A wrong count or width would corrupt the vector index: refuse it (ADR 0012 §6).
        const valid = vectors.every(
          (vector): vector is number[] =>
            Array.isArray(vector) &&
            vector.length === call.dimensions &&
            vector.every((value) => typeof value === "number" && Number.isFinite(value)),
        );
        if (!valid) throw new LlmCallError("invalid_request");
        // No usage, or a malformed count: none recorded, never a zero (P4-5 review 1).
        const inputTokens = isObject(answer.usage)
          ? count(answer.usage["prompt_tokens"])
          : undefined;
        return {
          vectors: vectors as number[][],
          model: call.model,
          usage: inputTokens === undefined ? undefined : { inputTokens },
        };
      });
    };

    return { completeStructured, embed } satisfies LlmProvider;
  };
