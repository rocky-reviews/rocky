import { isLlmCallError, type LlmProvider, type ProviderEmbeddingCall } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import type { OpenAiSettings, VoyageSettings } from "../config.js";
import { envSecrets } from "../registry.js";
import { providerAdapters } from "./index.js";
import {
  fakeFetch,
  json,
  TEST_KEY,
  type FakeResponse,
  type RecordedRequest,
} from "./test-support.js";

/**
 * P9-1 (ADR 0040 §1): contract tests for the hosted embedding providers, OpenAI and Voyage AI,
 * with documentation-shaped responses (`fixtures/openai/`, `fixtures/voyage/`). Requests go to an
 * injected `fetch`; nothing reaches a live API (no key is configured, and live calls need the
 * maintainer's go).
 */

const OPENAI: OpenAiSettings = { kind: "openai", apiKeyEnv: "ROCKY_TEST_OPENAI_KEY" };
const VOYAGE: VoyageSettings = { kind: "voyage", apiKeyEnv: "ROCKY_TEST_VOYAGE_KEY" };
const SECRETS = { ROCKY_TEST_OPENAI_KEY: TEST_KEY, ROCKY_TEST_VOYAGE_KEY: TEST_KEY };

const openAi = (
  responses: FakeResponse[],
  settings: OpenAiSettings = OPENAI,
  secrets: Record<string, string> = SECRETS,
): { provider: LlmProvider; requests: RecordedRequest[] } => {
  const fake = fakeFetch(...responses);
  const factory = providerAdapters({ fetch: fake.fetch }).openai!;
  return { provider: factory(settings, envSecrets(secrets)), requests: fake.requests };
};

const voyage = (
  responses: FakeResponse[],
  settings: VoyageSettings = VOYAGE,
  secrets: Record<string, string> = SECRETS,
): { provider: LlmProvider; requests: RecordedRequest[] } => {
  const fake = fakeFetch(...responses);
  const factory = providerAdapters({ fetch: fake.fetch }).voyage!;
  return { provider: factory(settings, envSecrets(secrets)), requests: fake.requests };
};

const call = (overrides: Partial<ProviderEmbeddingCall> = {}): ProviderEmbeddingCall => ({
  inputs: ["src/a.ts\nexport const a = 1;", "src/b.ts\nexport const b = 2;"],
  model: "text-embedding-3-small",
  dimensions: 4,
  ...overrides,
});

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
};

describe("OpenAI embeddings (the default embedding provider)", () => {
  it("asks for the configured width and returns the vectors in input order with usage", async () => {
    const { provider, requests } = openAi([json("openai/embeddings.json")]);
    expect(await provider.embed!(call())).toEqual({
      vectors: [
        [0.5, 0.5, 0.5, 0.5],
        [0, 0.6, 0.8, 0],
      ],
      model: "text-embedding-3-small",
      usage: { inputTokens: 9 },
    });
    const request = requests[0]!;
    expect(request.url.toString()).toBe("https://api.openai.com/v1/embeddings");
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("error");
    expect(request.headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(request.body).toEqual({
      model: "text-embedding-3-small",
      input: call().inputs,
      encoding_format: "float",
      dimensions: 4,
    });
  });

  it("uses a configured https base URL (a gateway)", async () => {
    const { provider, requests } = openAi([json("openai/embeddings.json")], {
      ...OPENAI,
      baseUrl: "https://gateway.acme.example/openai/v1/",
    });
    await provider.embed!(call());
    expect(requests[0]!.url.toString()).toBe("https://gateway.acme.example/openai/v1/embeddings");
  });

  it("fails with auth before sending anything when the key is missing", async () => {
    const { provider, requests } = openAi([json("openai/embeddings.json")], OPENAI, {});
    const error = await rejection(provider.embed!(call()));
    expect(isLlmCallError(error) && error.kind).toBe("auth");
    expect(requests).toHaveLength(0);
  });

  it("maps a rate limit to a retryable error with the server's hint, and drops its text", async () => {
    const { provider } = openAi([json("openai/error-429.json", 429, { "retry-after-ms": "20" })]);
    const error = await rejection(provider.embed!(call()));
    expect(isLlmCallError(error) && error.kind).toBe("rate_limited");
    expect(isLlmCallError(error) && error.retryAfterMs).toBe(20);
    expect(String(error)).not.toContain("Rate limit reached");
  });

  it("refuses an answer of the wrong width or count", async () => {
    for (const overrides of [{ dimensions: 8 }, { inputs: ["a", "b", "c"] }]) {
      const { provider } = openAi([json("openai/embeddings.json")]);
      const error = await rejection(provider.embed!(call(overrides)));
      expect(isLlmCallError(error) && error.kind).toBe("invalid_request");
    }
  });

  it("has no completions", () => {
    expect(openAi([]).provider.completeStructured).toBeUndefined();
  });
});

describe("Voyage AI embeddings", () => {
  const voyageCall = (overrides: Partial<ProviderEmbeddingCall> = {}) =>
    call({ model: "voyage-code-3", ...overrides });

  it("sends input_type and output_dimension and reads total_tokens", async () => {
    const { provider, requests } = voyage([json("voyage/embeddings.json")]);
    expect(await provider.embed!(voyageCall())).toEqual({
      vectors: [
        [0.4, 0.3, 0.2, 0.1],
        [0.1, 0.2, 0.3, 0.4],
      ],
      model: "voyage-code-3",
      usage: { inputTokens: 14 },
    });
    const request = requests[0]!;
    expect(request.url.toString()).toBe("https://api.voyageai.com/v1/embeddings");
    expect(request.redirect).toBe("error");
    expect(request.headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(request.body).toEqual({
      model: "voyage-code-3",
      input: call().inputs,
      input_type: "document",
      output_dimension: 4,
      output_dtype: "float",
      truncation: true,
    });
  });

  it("embeds a question as a query", async () => {
    const { provider, requests } = voyage([json("voyage/embeddings.json")]);
    await provider.embed!(voyageCall({ purpose: "query" }));
    expect(requests[0]!.body["input_type"]).toBe("query");
  });

  it("maps a refused key to auth without echoing the provider's detail", async () => {
    const { provider } = voyage([json("voyage/error-401.json", 401)]);
    const error = await rejection(provider.embed!(voyageCall()));
    expect(isLlmCallError(error) && error.kind).toBe("auth");
    expect(String(error)).not.toContain("Provided API key");
  });

  it("reports no usage rather than a guessed zero when the count is missing or malformed", async () => {
    for (const usage of ["null", '{"total_tokens":-1}', '{"total_tokens":"14"}', "{}"]) {
      const { provider } = voyage([
        {
          body: `{"data":[{"index":0,"embedding":[1,0,0,0]}],"usage":${usage}}`,
          headers: { "content-type": "application/json" },
        },
      ]);
      expect((await provider.embed!(voyageCall({ inputs: ["a"] }))).usage, usage).toBeUndefined();
    }
  });

  it("refuses a malformed answer", async () => {
    for (const body of ["null", '{"data":[{"index":0,"embedding":[1,"x",0,0]}]}', '{"data":{}}']) {
      const { provider } = voyage([{ body }]);
      const error = await rejection(provider.embed!(voyageCall({ inputs: ["a"] })));
      expect(isLlmCallError(error), body).toBe(true);
    }
  });

  it("has no completions", () => {
    expect(voyage([]).provider.completeStructured).toBeUndefined();
  });
});
