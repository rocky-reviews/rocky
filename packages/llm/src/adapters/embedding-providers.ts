import {
  LlmCallError,
  type LlmProvider,
  type ProviderEmbeddingCall,
  type ProviderEmbeddingResult,
} from "@rocky-reviews/core";
import type { ProviderAdapterFactory, SecretSource } from "../registry.js";
import { endpoint, inInputOrder, isObject, post, type Exchange } from "./openai-compatible.js";
import { count, guarded } from "./output.js";
import { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, type AdapterTransport } from "./transport.js";

/**
 * Hosted embedding providers (P9-1, ADR 0040 §1): OpenAI (the default) and Voyage AI. Both are
 * `POST {baseUrl}/embeddings` with a bearer key, over the same hardened `post` as the
 * OpenAI-compatible adapter: no redirects (the key and the code would follow), a deadline, a
 * byte cap, fixed error kinds and no provider text. Neither has completions.
 *
 * The answer is checked as strictly as the OpenAI-compatible one (ADR 0013 §5): indices exactly
 * 0..n-1, every vector `dimensions` wide and finite, usage a non-negative integer or none.
 */

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const VOYAGE_BASE_URL = "https://api.voyageai.com/v1";

const exchangeOf = (transport: AdapterTransport): Exchange => ({
  fetch: transport.fetch ?? globalThis.fetch,
  timeoutMs: transport.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  maxResponseBytes: transport.maxResponseBytes ?? MAX_RESPONSE_BYTES,
});

/** Read at call time only; a missing key fails before anything is sent. */
const keyOf = (secrets: SecretSource, name: string): string => {
  const value = secrets.get(name);
  if (value === undefined || value === "") throw new LlmCallError("auth");
  return value;
};

/** Vectors in input order, each `dimensions` wide; anything else is refused, never stored. */
const vectorsOf = (data: unknown, call: ProviderEmbeddingCall): number[][] => {
  const vectors = inInputOrder(data, call.inputs.length);
  const valid = vectors.every(
    (vector): vector is number[] =>
      Array.isArray(vector) &&
      vector.length === call.dimensions &&
      vector.every((value) => typeof value === "number" && Number.isFinite(value)),
  );
  if (!valid) throw new LlmCallError("invalid_request");
  return vectors as number[][];
};

const result = (
  call: ProviderEmbeddingCall,
  answer: Record<string, unknown>,
  tokensField: "prompt_tokens" | "total_tokens",
): ProviderEmbeddingResult =>
  guarded(() => {
    const vectors = vectorsOf(answer["data"], call);
    const usage = answer["usage"];
    const inputTokens = isObject(usage) ? count(usage[tokensField]) : undefined;
    return {
      vectors,
      model: call.model,
      usage: inputTokens === undefined ? undefined : { inputTokens },
    };
  });

/**
 * OpenAI: `dimensions` shortens `text-embedding-3-*` vectors to the configured width (at most the
 * index width, ADR 0040 §3); `purpose` has no OpenAI counterpart.
 */
export const openAiAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"openai"> =>
  (settings, secrets) => {
    const exchange = exchangeOf(transport);
    const embed = async (call: ProviderEmbeddingCall): Promise<ProviderEmbeddingResult> => {
      const key = keyOf(secrets, settings.apiKeyEnv);
      const answer = await post(
        exchange,
        endpoint(settings.baseUrl ?? OPENAI_BASE_URL, "embeddings"),
        key,
        {
          model: call.model,
          input: call.inputs,
          encoding_format: "float",
          dimensions: call.dimensions,
        },
        call.signal,
      );
      return result(call, answer, "prompt_tokens");
    };
    return { embed } satisfies LlmProvider;
  };

/**
 * Voyage AI: `input_type` tells the indexed text (`document`) from a question (`query`), which
 * its retrieval models embed differently; `output_dimension` sets the width; `truncation` cuts
 * an over-long input instead of failing the batch (chunks are capped well below the limit).
 */
export const voyageAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"voyage"> =>
  (settings, secrets) => {
    const exchange = exchangeOf(transport);
    const embed = async (call: ProviderEmbeddingCall): Promise<ProviderEmbeddingResult> => {
      const key = keyOf(secrets, settings.apiKeyEnv);
      const answer = await post(
        exchange,
        endpoint(settings.baseUrl ?? VOYAGE_BASE_URL, "embeddings"),
        key,
        {
          model: call.model,
          input: call.inputs,
          input_type: call.purpose ?? "document",
          output_dimension: call.dimensions,
          output_dtype: "float",
          truncation: true,
        },
        call.signal,
      );
      return result(call, answer, "total_tokens");
    };
    return { embed } satisfies LlmProvider;
  };
