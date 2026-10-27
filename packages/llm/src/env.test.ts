import { describe, expect, it } from "vitest";
import { LlmConfigError } from "./config.js";
import { llmConfigFromEnv } from "./env.js";

/** P4-1: role config from the environment, validated, failing fast with named variables. */

const errorOf = (env: Record<string, string>): LlmConfigError => {
  try {
    llmConfigFromEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError);
    return error as LlmConfigError;
  }
  throw new Error("expected an LlmConfigError");
};

const messageOf = (env: Record<string, string>): string => errorOf(env).message;

describe("llmConfigFromEnv defaults", () => {
  it("uses Haiku 5.5 for triage, Opus 5.5 for review, Sonnet 5.5 for graph and ask", () => {
    const config = llmConfigFromEnv({});
    expect(config.roles).toEqual({
      triage: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
      review: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
      graph: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
      ask: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
      embed: null,
    });
    expect(config.providers).toEqual({
      anthropic: { kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
    });
  });

  it("treats empty variables as unset, like the rest of the app config", () => {
    expect(llmConfigFromEnv({ ROCKY_LLM_REVIEW_MODEL: "", ROCKY_LLM_PROVIDER: "" })).toEqual(
      llmConfigFromEnv({}),
    );
  });

  it("ignores variables outside the ROCKY_LLM_ prefix", () => {
    expect(() =>
      llmConfigFromEnv({ ANTHROPIC_API_KEY: "x", ROCKY_KEK_CURRENT: "dev" }),
    ).not.toThrow();
  });
});

describe("switching provider through the environment", () => {
  it("moves every completion role to Bedrock with one variable plus its region", () => {
    const config = llmConfigFromEnv({
      ROCKY_LLM_PROVIDER: "bedrock",
      ROCKY_LLM_BEDROCK_REGION: "eu-west-1",
    });
    for (const role of ["triage", "review", "graph", "ask"] as const) {
      expect(config.roles[role].provider).toBe("bedrock");
    }
    expect(config.roles.review.model).toBe("claude-opus-5-5");
    expect(config.providers).toEqual({ bedrock: { kind: "bedrock", region: "eu-west-1" } });
  });

  it("moves one role and leaves the others on the default", () => {
    const config = llmConfigFromEnv({
      ROCKY_LLM_REVIEW_PROVIDER: "vertex",
      ROCKY_LLM_VERTEX_PROJECT_ID: "acme-ai",
      ROCKY_LLM_VERTEX_REGION: "global",
    });
    expect(config.roles.review.provider).toBe("vertex");
    expect(config.roles.triage.provider).toBe("anthropic");
    expect(config.providers.vertex).toEqual({
      kind: "vertex",
      projectId: "acme-ai",
      region: "global",
    });
  });

  it("configures Foundry with its own key variable name", () => {
    const config = llmConfigFromEnv({
      ROCKY_LLM_PROVIDER: "foundry",
      ROCKY_LLM_FOUNDRY_RESOURCE: "acme-foundry",
    });
    expect(config.providers.foundry).toEqual({
      kind: "foundry",
      resource: "acme-foundry",
      apiKeyEnv: "ANTHROPIC_FOUNDRY_API_KEY",
    });
  });

  it("requires an explicit model per role on an OpenAI-compatible server", () => {
    const base = {
      ROCKY_LLM_PROVIDER: "openai-compatible",
      ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1",
    };
    const message = messageOf(base);
    for (const name of ["TRIAGE", "REVIEW", "GRAPH", "ASK"]) {
      expect(message).toContain(`ROCKY_LLM_${name}_MODEL`);
    }
    const config = llmConfigFromEnv({
      ...base,
      ROCKY_LLM_TRIAGE_MODEL: "qwen2.5-coder:7b",
      ROCKY_LLM_REVIEW_MODEL: "qwen2.5-coder:32b",
      ROCKY_LLM_REVIEW_EFFORT: "high",
      ROCKY_LLM_GRAPH_MODEL: "qwen2.5-coder:14b",
      ROCKY_LLM_ASK_MODEL: "Qwen/Qwen2.5-Coder-14B-Instruct",
    });
    expect(config.roles.review).toEqual({
      provider: "openai-compatible",
      model: "qwen2.5-coder:32b",
      effort: "high",
    });
    expect(config.roles.triage).toEqual({
      provider: "openai-compatible",
      model: "qwen2.5-coder:7b",
    });
    expect(config.providers["openai-compatible"]).toEqual({
      kind: "openai-compatible",
      baseUrl: "http://ollama:11434/v1",
    });
  });

  it("overrides model and effort per role", () => {
    const config = llmConfigFromEnv({
      ROCKY_LLM_REVIEW_MODEL: "claude-fable-5-1",
      ROCKY_LLM_REVIEW_EFFORT: "xhigh",
      ROCKY_LLM_TRIAGE_EFFORT: "medium",
    });
    expect(config.roles.review).toEqual({
      provider: "anthropic",
      model: "claude-fable-5-1",
      effort: "xhigh",
    });
    expect(config.roles.triage.effort).toBe("medium");
  });

  it("enables the embed role only when it is configured explicitly", () => {
    const config = llmConfigFromEnv({
      ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
      ROCKY_LLM_EMBED_MODEL: "nomic-embed-text",
      ROCKY_LLM_EMBED_DIMENSIONS: "768",
      ROCKY_LLM_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      ROCKY_LLM_OPENAI_API_KEY_ENV: "OLLAMA_API_KEY",
    });
    expect(config.roles.embed).toEqual({
      provider: "openai-compatible",
      model: "nomic-embed-text",
      dimensions: 768,
    });
    expect(config.providers["openai-compatible"]).toEqual({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "OLLAMA_API_KEY",
    });
    expect(config.roles.review.provider).toBe("anthropic");
  });
});

describe("llmConfigFromEnv validation (fails fast, names the variable)", () => {
  it("rejects an unknown provider", () => {
    expect(messageOf({ ROCKY_LLM_REVIEW_PROVIDER: "gemini" })).toMatch(
      /ROCKY_LLM_REVIEW_PROVIDER: must be one of anthropic, bedrock, vertex, foundry, openai-compatible/,
    );
    expect(messageOf({ ROCKY_LLM_PROVIDER: "Anthropic" })).toContain("ROCKY_LLM_PROVIDER");
  });

  it("rejects an unknown or blank model", () => {
    expect(messageOf({ ROCKY_LLM_REVIEW_MODEL: "claude-opus-9" })).toMatch(
      /ROCKY_LLM_REVIEW_MODEL: unknown model for provider anthropic \(known: .*claude-opus-5-5/,
    );
    expect(messageOf({ ROCKY_LLM_REVIEW_MODEL: "   " })).toMatch(/ROCKY_LLM_REVIEW_MODEL: .*blank/);
  });

  it("rejects an effort outside the scale", () => {
    expect(messageOf({ ROCKY_LLM_TRIAGE_EFFORT: "ultra" })).toMatch(
      /ROCKY_LLM_TRIAGE_EFFORT: must be one of low, medium, high, xhigh, max/,
    );
  });

  it("rejects an effort the provider does not support", () => {
    const message = messageOf({
      ROCKY_LLM_PROVIDER: "openai-compatible",
      ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1",
      ROCKY_LLM_TRIAGE_MODEL: "m",
      ROCKY_LLM_REVIEW_MODEL: "m",
      ROCKY_LLM_REVIEW_EFFORT: "xhigh",
      ROCKY_LLM_GRAPH_MODEL: "m",
      ROCKY_LLM_ASK_MODEL: "m",
    });
    expect(message).toMatch(
      /ROCKY_LLM_REVIEW_EFFORT: effort xhigh is not supported by provider openai-compatible \(supported: low, medium, high\)/,
    );
  });

  it("rejects an effort the model does not support", () => {
    expect(
      messageOf({ ROCKY_LLM_TRIAGE_MODEL: "claude-haiku-4-5", ROCKY_LLM_TRIAGE_EFFORT: "low" }),
    ).toMatch(/ROCKY_LLM_TRIAGE_EFFORT: model claude-haiku-4-5 takes no effort setting/);
    // Without an explicit effort the role's default does not apply to a model that lacks one.
    expect(llmConfigFromEnv({ ROCKY_LLM_TRIAGE_MODEL: "claude-haiku-4-5" }).roles.triage).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("rejects an embed role on a provider without embeddings", () => {
    expect(
      messageOf({ ROCKY_LLM_EMBED_MODEL: "claude-opus-5-5", ROCKY_LLM_EMBED_DIMENSIONS: "1536" }),
    ).toMatch(/ROCKY_LLM_EMBED_PROVIDER: provider anthropic has no embeddings/);
  });

  it("requires a whole, bounded embedding dimension", () => {
    const base = {
      ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
      ROCKY_LLM_EMBED_MODEL: "nomic-embed-text",
      ROCKY_LLM_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
    };
    expect(messageOf(base)).toMatch(/ROCKY_LLM_EMBED_DIMENSIONS: required/);
    for (const value of ["abc", "1.5", "0", "-3", "100000"]) {
      expect(messageOf({ ...base, ROCKY_LLM_EMBED_DIMENSIONS: value }), value).toContain(
        "ROCKY_LLM_EMBED_DIMENSIONS",
      );
    }
  });

  it("requires the settings of a provider a role uses", () => {
    expect(messageOf({ ROCKY_LLM_PROVIDER: "bedrock" })).toMatch(
      /ROCKY_LLM_BEDROCK_REGION: required/,
    );
    const vertex = messageOf({ ROCKY_LLM_GRAPH_PROVIDER: "vertex" });
    expect(vertex).toContain("ROCKY_LLM_VERTEX_PROJECT_ID: required");
    expect(vertex).toContain("ROCKY_LLM_VERTEX_REGION: required");
    expect(messageOf({ ROCKY_LLM_PROVIDER: "foundry" })).toContain(
      "ROCKY_LLM_FOUNDRY_RESOURCE: required",
    );
  });

  it("rejects a key-name variable that is not an environment variable name", () => {
    expect(messageOf({ ROCKY_LLM_ANTHROPIC_API_KEY_ENV: "my key" })).toMatch(
      /ROCKY_LLM_ANTHROPIC_API_KEY_ENV: must name an environment variable/,
    );
  });

  it("rejects base URLs that carry credentials, a query or a non-http scheme", () => {
    for (const url of [
      "https://user:pw@api.example.com",
      "https://api.example.com/v1?key=1",
      "ftp://api.example.com",
      "not a url",
    ]) {
      expect(messageOf({ ROCKY_LLM_ANTHROPIC_BASE_URL: url }), url).toContain(
        "ROCKY_LLM_ANTHROPIC_BASE_URL",
      );
    }
    expect(
      llmConfigFromEnv({ ROCKY_LLM_ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic" })
        .providers.anthropic,
    ).toEqual({
      kind: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: "https://gateway.example.com/anthropic",
    });
  });

  it("rejects an unknown ROCKY_LLM_ variable, so a typo cannot pass silently", () => {
    expect(messageOf({ ROCKY_LLM_REVEIW_MODEL: "claude-opus-5-5" })).toMatch(
      /ROCKY_LLM_REVEIW_MODEL: unknown variable/,
    );
  });

  it("reports every problem at once", () => {
    const error = errorOf({
      ROCKY_LLM_TRIAGE_PROVIDER: "nope",
      ROCKY_LLM_REVIEW_MODEL: "nope",
      ROCKY_LLM_ASK_EFFORT: "nope",
    });
    expect(error.issues.map((issue) => issue.path).sort()).toEqual([
      "ROCKY_LLM_ASK_EFFORT",
      "ROCKY_LLM_REVIEW_MODEL",
      "ROCKY_LLM_TRIAGE_PROVIDER",
    ]);
  });
});
