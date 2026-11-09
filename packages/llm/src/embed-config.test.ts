import { INDEX_VECTOR_DIMENSIONS } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { LlmConfigError } from "./config.js";
import { llmConfigFromEnv } from "./env.js";
import { createLlmRoles, envSecrets } from "./registry.js";
import { recordingAdapters } from "./testing.js";

/**
 * P9-1 (ADR 0040 §1, amending ADR 0012 §6): several embedding providers, chosen by configuration.
 * OpenAI is the default embedding provider; Voyage AI and any OpenAI-compatible server (Ollama,
 * vLLM) are the others. Embeddings stay off until the embed role is configured.
 */

const messageOf = (env: Record<string, string>): string => {
  try {
    llmConfigFromEnv(env);
  } catch (error) {
    if (error instanceof LlmConfigError) return error.message;
    throw error;
  }
  throw new Error("expected a config error");
};

describe("the embed role", () => {
  it("stays off when nothing is configured", () => {
    expect(llmConfigFromEnv({}).roles.embed).toBeNull();
    expect(llmConfigFromEnv({}).providers.openai).toBeUndefined();
  });

  it("defaults to OpenAI text-embedding-3-small at the index width", () => {
    const config = llmConfigFromEnv({ ROCKY_LLM_EMBED_PROVIDER: "openai" });
    expect(config.roles.embed).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: INDEX_VECTOR_DIMENSIONS,
    });
    expect(config.providers.openai).toEqual({ kind: "openai", apiKeyEnv: "OPENAI_API_KEY" });
    // The completion roles keep their providers.
    expect(config.roles.review.provider).toBe("anthropic");
  });

  it("is OpenAI when only a model is named", () => {
    const config = llmConfigFromEnv({ ROCKY_LLM_EMBED_MODEL: "text-embedding-3-large" });
    expect(config.roles.embed).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
      dimensions: 1024,
    });
  });

  it("follows ROCKY_LLM_PROVIDER when that provider has embeddings", () => {
    const config = llmConfigFromEnv({
      ROCKY_LLM_PROVIDER: "openai-compatible",
      ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1",
      ROCKY_LLM_TRIAGE_MODEL: "m",
      ROCKY_LLM_REVIEW_MODEL: "m",
      ROCKY_LLM_GRAPH_MODEL: "m",
      ROCKY_LLM_ASK_MODEL: "m",
      ROCKY_LLM_EMBED_MODEL: "nomic-embed-text",
      ROCKY_LLM_EMBED_DIMENSIONS: "768",
    });
    expect(config.roles.embed).toEqual({
      provider: "openai-compatible",
      model: "nomic-embed-text",
      dimensions: 768,
    });
  });

  it("takes Voyage AI with voyage-code-3 at 1024 by default", () => {
    const config = llmConfigFromEnv({ ROCKY_LLM_EMBED_PROVIDER: "voyage" });
    expect(config.roles.embed).toEqual({
      provider: "voyage",
      model: "voyage-code-3",
      dimensions: 1024,
    });
    expect(config.providers.voyage).toEqual({ kind: "voyage", apiKeyEnv: "VOYAGE_API_KEY" });
  });

  it("reads the hosted providers' own settings", () => {
    const config = llmConfigFromEnv({
      ROCKY_LLM_EMBED_PROVIDER: "openai",
      ROCKY_LLM_OPENAI_PLATFORM_API_KEY_ENV: "ACME_OPENAI_KEY",
      ROCKY_LLM_OPENAI_PLATFORM_BASE_URL: "https://gateway.acme.example/v1",
    });
    expect(config.providers.openai).toEqual({
      kind: "openai",
      apiKeyEnv: "ACME_OPENAI_KEY",
      baseUrl: "https://gateway.acme.example/v1",
    });
    const v = llmConfigFromEnv({
      ROCKY_LLM_EMBED_PROVIDER: "voyage",
      ROCKY_LLM_VOYAGE_API_KEY_ENV: "ACME_VOYAGE_KEY",
    });
    expect(v.providers.voyage).toEqual({ kind: "voyage", apiKeyEnv: "ACME_VOYAGE_KEY" });
  });

  it("refuses a width over the index width, for every provider", () => {
    expect(
      messageOf({ ROCKY_LLM_EMBED_PROVIDER: "openai", ROCKY_LLM_EMBED_DIMENSIONS: "1536" }),
    ).toMatch(/ROCKY_LLM_EMBED_DIMENSIONS: must be a whole number from 1 to 1024/);
    expect(
      messageOf({
        ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
        ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1",
        ROCKY_LLM_EMBED_MODEL: "big",
        ROCKY_LLM_EMBED_DIMENSIONS: "4096",
      }),
    ).toContain("ROCKY_LLM_EMBED_DIMENSIONS");
  });

  it("refuses a model outside a hosted provider's catalogue, and a width the model lacks", () => {
    expect(
      messageOf({
        ROCKY_LLM_EMBED_PROVIDER: "openai",
        ROCKY_LLM_EMBED_MODEL: "text-embedding-ada-002",
      }),
    ).toMatch(
      /ROCKY_LLM_EMBED_MODEL: unknown model for provider openai \(known: text-embedding-3-small, text-embedding-3-large\)/,
    );
    expect(
      messageOf({ ROCKY_LLM_EMBED_PROVIDER: "voyage", ROCKY_LLM_EMBED_DIMENSIONS: "768" }),
    ).toMatch(/ROCKY_LLM_EMBED_DIMENSIONS: model voyage-code-3 supports 256, 512, 1024/);
    expect(
      llmConfigFromEnv({ ROCKY_LLM_EMBED_PROVIDER: "voyage", ROCKY_LLM_EMBED_DIMENSIONS: "512" })
        .roles.embed?.dimensions,
    ).toBe(512);
  });

  it("refuses a hosted provider as a completion role, and a plain-http base URL for a key", () => {
    expect(messageOf({ ROCKY_LLM_REVIEW_PROVIDER: "openai" })).toMatch(
      /ROCKY_LLM_REVIEW_PROVIDER: provider openai has no completions/,
    );
    expect(
      messageOf({
        ROCKY_LLM_EMBED_PROVIDER: "voyage",
        ROCKY_LLM_VOYAGE_BASE_URL: "http://voyage.acme.example/v1",
      }),
    ).toMatch(/ROCKY_LLM_VOYAGE_BASE_URL: must be an https URL/);
  });

  it("still requires a model and a width for an OpenAI-compatible server", () => {
    const message = messageOf({
      ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
      ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1",
    });
    expect(message).toContain("ROCKY_LLM_EMBED_MODEL");
    expect(message).toContain("ROCKY_LLM_EMBED_DIMENSIONS: required");
  });

  it("is wired by the registry to the embed role's provider, purpose included", async () => {
    const adapters = recordingAdapters();
    const roles = createLlmRoles(
      llmConfigFromEnv({ ROCKY_LLM_EMBED_PROVIDER: "voyage" }),
      adapters.factories,
      envSecrets({}),
    );
    await roles.embedding()!.embed({ inputs: ["q"], purpose: "query" });
    expect(adapters.embedCalls).toEqual([
      { kind: "voyage", inputs: ["q"], purpose: "query", model: "voyage-code-3", dimensions: 1024 },
    ]);
  });
});
