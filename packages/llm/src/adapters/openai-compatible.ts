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
import { tokens, toResult, ZERO_USAGE, type StopKind } from "./output.js";
import { DEFAULT_TIMEOUT_MS, nonceSource, type AdapterTransport } from "./transport.js";
import { buildPrompt, checkOutputCap } from "./untrusted.js";

/**
 * OpenAI-compatible adapter for Ollama and vLLM (P4-2, ADR 0013 §5): `POST /chat/completions` and
 * `POST /embeddings` over `fetch`, no SDK. Structured output is `response_format: json_schema`,
 * with the schema also in the system message for servers that ignore it (the documented
 * fallback); the port's validator decides either way.
 */

/** A hostile or broken server cannot make the worker buffer more than this (T9). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const SCHEMA_NAME = /[^A-Za-z0-9_-]/g;

const endpoint = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${path}`;

/** Reads at most `MAX_RESPONSE_BYTES`; more is a broken server, not an answer. */
const readCapped = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
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
    if (size > MAX_RESPONSE_BYTES) {
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
}

/** One POST; failures become `LlmCallError` with only the status kind and retry hint (T7). */
const post = async (
  exchange: Exchange,
  url: string,
  key: string | undefined,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  if (cancelledBy(signal)) throw new LlmCallError("cancelled");
  const timeout = AbortSignal.timeout(exchange.timeoutMs);
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
    const text = await readCapped(response);
    const parsed = parseJson(text);
    if (!response.ok) {
      throw callError(kindForStatus(response.status, errorMessage(parsed)), response.headers);
    }
    if (parsed === undefined) throw new LlmCallError("server_error");
    return parsed;
  } catch (error) {
    if (isLlmCallError(error)) throw error;
    if (cancelledBy(signal)) throw new LlmCallError("cancelled");
    if (timeout.aborted) throw new LlmCallError("timeout");
    throw new LlmCallError("network");
  }
};

interface ChatChoice {
  readonly finish_reason?: unknown;
  readonly message?: { readonly content?: unknown; readonly refusal?: unknown };
}
interface ChatCompletion {
  readonly choices?: readonly ChatChoice[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly prompt_tokens_details?: { readonly cached_tokens?: unknown } | null;
  } | null;
}

/** OpenAI counts cached tokens inside `prompt_tokens`; the port counts them apart. */
const chatUsage = (usage: ChatCompletion["usage"]): LlmUsage => {
  if (usage === undefined || usage === null) return ZERO_USAGE;
  const prompt = tokens(usage.prompt_tokens);
  const cached = Math.min(tokens(usage.prompt_tokens_details?.cached_tokens), prompt);
  return {
    ...ZERO_USAGE,
    inputTokens: prompt - cached,
    outputTokens: tokens(usage.completion_tokens),
    cacheReadInputTokens: cached,
  };
};

const stopOf = (choice: ChatChoice | undefined): StopKind => {
  if (choice === undefined) return "unexpected";
  const refusal = choice.message?.refusal;
  if (typeof refusal === "string" && refusal !== "") return "refused";
  switch (choice.finish_reason) {
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

export const openAiCompatibleAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"openai-compatible"> =>
  (settings, secrets) => {
    const exchange: Exchange = {
      fetch: transport.fetch ?? globalThis.fetch,
      timeoutMs: transport.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
      const choice = Array.isArray(answer.choices) ? answer.choices[0] : undefined;
      const content = choice?.message?.content;
      return toResult(
        {
          stop: stopOf(choice),
          text: typeof content === "string" ? content : "",
          model: call.model,
          usage: chatUsage(answer.usage),
        },
        call.output,
      );
    };

    const embed = async (call: ProviderEmbeddingCall): Promise<ProviderEmbeddingResult> => {
      const answer = (await post(
        exchange,
        endpoint(settings.baseUrl, "embeddings"),
        key(),
        { model: call.model, input: call.inputs, encoding_format: "float" },
        call.signal,
      )) as {
        data?: readonly { index?: unknown; embedding?: unknown }[];
        usage?: { prompt_tokens?: unknown };
      };
      const data = Array.isArray(answer.data) ? answer.data : [];
      const vectors = [...data]
        .sort((a, b) => Number(a.index) - Number(b.index))
        .map((entry) => entry.embedding);
      // A wrong count or width would corrupt the vector index: refuse it (ADR 0012 §6).
      const valid =
        vectors.length === call.inputs.length &&
        vectors.every(
          (vector): vector is number[] =>
            Array.isArray(vector) &&
            vector.length === call.dimensions &&
            vector.every((value) => typeof value === "number" && Number.isFinite(value)),
        );
      if (!valid) throw new LlmCallError("invalid_request");
      return {
        vectors: vectors as number[][],
        model: call.model,
        usage: { inputTokens: tokens(answer.usage?.prompt_tokens) },
      };
    };

    return { completeStructured, embed } satisfies LlmProvider;
  };
