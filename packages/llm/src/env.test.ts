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

describe("review round 1: catalogue, platform model ids, URLs, regions", () => {
  it("accepts the skill's active Claude models with their own effort levels (S1a)", () => {
    for (const model of [
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-5",
    ]) {
      expect(
        llmConfigFromEnv({ ROCKY_LLM_REVIEW_MODEL: model, ROCKY_LLM_REVIEW_EFFORT: "xhigh" }).roles
          .review.model,
      ).toBe(model);
    }
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(
        llmConfigFromEnv({ ROCKY_LLM_REVIEW_MODEL: model, ROCKY_LLM_REVIEW_EFFORT: "max" }).roles
          .review.effort,
      ).toBe("max");
      expect(
        messageOf({ ROCKY_LLM_REVIEW_MODEL: model, ROCKY_LLM_REVIEW_EFFORT: "xhigh" }),
      ).toContain(
        `effort xhigh is not supported by model ${model} (supported: low, medium, high, max)`,
      );
    }
    expect(
      messageOf({ ROCKY_LLM_REVIEW_MODEL: "claude-opus-4-5", ROCKY_LLM_REVIEW_EFFORT: "max" }),
    ).toContain("not supported by model claude-opus-4-5 (supported: low, medium, high)");
  });

  it("configures platform model ids per role without a code change (S1b)", () => {
    const bedrock = { ROCKY_LLM_PROVIDER: "bedrock", ROCKY_LLM_BEDROCK_REGION: "eu-west-1" };
    const profile = llmConfigFromEnv({
      ...bedrock,
      ROCKY_LLM_REVIEW_PLATFORM_MODEL: "eu.anthropic.claude-opus-5-5",
    });
    expect(profile.roles.review).toEqual({
      provider: "bedrock",
      model: "claude-opus-5-5",
      effort: "high",
      platformModel: "eu.anthropic.claude-opus-5-5",
    });
    const arn = "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/a1b2c3d4e5f6";
    expect(
      llmConfigFromEnv({ ...bedrock, ROCKY_LLM_TRIAGE_PLATFORM_MODEL: arn }).roles.triage
        .platformModel,
    ).toBe(arn);
    expect(
      llmConfigFromEnv({
        ROCKY_LLM_PROVIDER: "vertex",
        ROCKY_LLM_VERTEX_PROJECT_ID: "acme-ai",
        ROCKY_LLM_VERTEX_REGION: "global",
        ROCKY_LLM_TRIAGE_MODEL: "claude-haiku-4-5",
        ROCKY_LLM_TRIAGE_PLATFORM_MODEL: "claude-haiku-4-5@20251001",
      }).roles.triage,
    ).toEqual({
      provider: "vertex",
      model: "claude-haiku-4-5",
      platformModel: "claude-haiku-4-5@20251001",
    });
    expect(
      llmConfigFromEnv({
        ROCKY_LLM_PROVIDER: "foundry",
        ROCKY_LLM_FOUNDRY_RESOURCE: "acme-foundry",
        ROCKY_LLM_GRAPH_PLATFORM_MODEL: "sonnet-prod_eu",
      }).roles.graph.platformModel,
    ).toBe("sonnet-prod_eu");
  });

  it("checks a platform model id's shape only, and only where a platform takes one", () => {
    const bedrock = { ROCKY_LLM_PROVIDER: "bedrock", ROCKY_LLM_BEDROCK_REGION: "eu-west-1" };
    for (const bad of ["eu anthropic", "a\u0007b", "x".repeat(513), "-leading"]) {
      expect(messageOf({ ...bedrock, ROCKY_LLM_REVIEW_PLATFORM_MODEL: bad }), bad).toContain(
        "ROCKY_LLM_REVIEW_PLATFORM_MODEL: must be a platform model id",
      );
    }
    expect(messageOf({ ROCKY_LLM_REVIEW_PLATFORM_MODEL: "anthropic.claude-opus-5-5" })).toContain(
      "ROCKY_LLM_REVIEW_PLATFORM_MODEL: only bedrock, vertex and foundry take a platform model id",
    );
  });

  it("requires https for the Anthropic base URL (S2)", () => {
    expect(messageOf({ ROCKY_LLM_ANTHROPIC_BASE_URL: "http://127.0.0.1:8080" })).toContain(
      "ROCKY_LLM_ANTHROPIC_BASE_URL: must be an https URL",
    );
  });

  it("allows http to an OpenAI-compatible server only on loopback or without a key (S2)", () => {
    const roles = {
      ROCKY_LLM_PROVIDER: "openai-compatible",
      ROCKY_LLM_TRIAGE_MODEL: "m",
      ROCKY_LLM_REVIEW_MODEL: "m",
      ROCKY_LLM_GRAPH_MODEL: "m",
      ROCKY_LLM_ASK_MODEL: "m",
    };
    const keyed = { ...roles, ROCKY_LLM_OPENAI_API_KEY_ENV: "VLLM_API_KEY" };
    for (const url of [
      "http://127.0.0.1:8000/v1",
      "http://localhost:8000/v1",
      "http://[::1]:8000/v1",
    ]) {
      expect(
        () => llmConfigFromEnv({ ...keyed, ROCKY_LLM_OPENAI_BASE_URL: url }),
        url,
      ).not.toThrow();
    }
    expect(messageOf({ ...keyed, ROCKY_LLM_OPENAI_BASE_URL: "http://vllm:8000/v1" })).toContain(
      "ROCKY_LLM_OPENAI_BASE_URL: must be https when a key is sent (http only on 127.0.0.1, localhost or [::1])",
    );
    expect(() =>
      llmConfigFromEnv({ ...keyed, ROCKY_LLM_OPENAI_BASE_URL: "https://vllm.internal/v1" }),
    ).not.toThrow();
    expect(() =>
      llmConfigFromEnv({ ...roles, ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1" }),
    ).not.toThrow();
  });

  it("accepts @ in a base URL path but not userinfo (N3)", () => {
    expect(
      llmConfigFromEnv({ ROCKY_LLM_ANTHROPIC_BASE_URL: "https://gw/v1/@team" }).providers.anthropic
        ?.baseUrl,
    ).toBe("https://gw/v1/@team");
    expect(messageOf({ ROCKY_LLM_ANTHROPIC_BASE_URL: "https://user:pw@host" })).toContain(
      "must not carry credentials, a query or a fragment",
    );
  });

  it("falls back to AWS_REGION, then AWS_DEFAULT_REGION, for Bedrock (N8)", () => {
    const base = { ROCKY_LLM_PROVIDER: "bedrock" };
    expect(
      llmConfigFromEnv({ ...base, AWS_DEFAULT_REGION: "us-west-2" }).providers.bedrock,
    ).toEqual({ kind: "bedrock", region: "us-west-2" });
    expect(
      llmConfigFromEnv({ ...base, AWS_REGION: "eu-central-1", AWS_DEFAULT_REGION: "us-west-2" })
        .providers.bedrock?.region,
    ).toBe("eu-central-1");
    expect(
      llmConfigFromEnv({
        ...base,
        ROCKY_LLM_BEDROCK_REGION: "ap-south-1",
        AWS_REGION: "eu-central-1",
      }).providers.bedrock?.region,
    ).toBe("ap-south-1");
    expect(messageOf({ ...base, AWS_REGION: "not a region" })).toContain(
      "AWS_REGION: must be a region",
    );
    // AWS_REGION alone does not configure Bedrock for an install that does not use it.
    expect(llmConfigFromEnv({ AWS_REGION: "eu-central-1" }).providers.bedrock).toBeUndefined();
  });

  it("refuses a key-name variable that looks like a key (N1)", () => {
    for (const value of ["A".repeat(65), "A1B2C3D4E5F6A7B8C9D0"]) {
      expect(messageOf({ ROCKY_LLM_ANTHROPIC_API_KEY_ENV: value }), value).toContain(
        "ROCKY_LLM_ANTHROPIC_API_KEY_ENV: looks like a key, not a variable name",
      );
    }
    expect(() => llmConfigFromEnv({ ROCKY_LLM_ANTHROPIC_API_KEY_ENV: "ACME_KEY_2" })).not.toThrow();
  });
});

describe("platform constraints the adapters rely on (P4-2, ADR 0013)", () => {
  const bedrock = { ROCKY_LLM_PROVIDER: "bedrock", ROCKY_LLM_BEDROCK_REGION: "us-east-1" };
  const vertex = {
    ROCKY_LLM_PROVIDER: "vertex",
    ROCKY_LLM_VERTEX_PROJECT_ID: "acme-ai",
    ROCKY_LLM_VERTEX_REGION: "global",
  };
  const foundry = { ROCKY_LLM_PROVIDER: "foundry", ROCKY_LLM_FOUNDRY_RESOURCE: "acme-foundry" };

  it("refuses on Bedrock the models that only the legacy InvokeModel integration serves", () => {
    for (const model of ["claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-4-6"]) {
      expect(messageOf({ ...bedrock, ROCKY_LLM_REVIEW_MODEL: model }), model).toContain(
        "ROCKY_LLM_REVIEW_MODEL: unknown model for provider bedrock",
      );
      // The same model stays valid on the platforms that serve it.
      expect(
        llmConfigFromEnv({ ...vertex, ROCKY_LLM_REVIEW_MODEL: model }).roles.review.model,
      ).toBe(model);
    }
    for (const model of ["claude-opus-4-7", "claude-haiku-4-5", "claude-fable-5-1"]) {
      expect(llmConfigFromEnv({ ...bedrock, ROCKY_LLM_GRAPH_MODEL: model }).roles.graph.model).toBe(
        model,
      );
    }
  });

  it("keeps a Vertex model id to one URL path segment (T4)", () => {
    for (const bad of ["claude-opus-5-5/../../x", "models:streamRawPredict", "a/b"]) {
      expect(messageOf({ ...vertex, ROCKY_LLM_REVIEW_PLATFORM_MODEL: bad }), bad).toContain(
        "ROCKY_LLM_REVIEW_PLATFORM_MODEL: must be a Vertex model id",
      );
    }
    expect(
      llmConfigFromEnv({ ...vertex, ROCKY_LLM_REVIEW_PLATFORM_MODEL: "claude-opus-4-5@20251101" })
        .roles.review.platformModel,
    ).toBe("claude-opus-4-5@20251101");
  });

  it("keeps a Foundry platform model to a deployment name (T4)", () => {
    for (const bad of ["dep/../x", "dep:1", "d".repeat(65), "a@b"]) {
      expect(messageOf({ ...foundry, ROCKY_LLM_REVIEW_PLATFORM_MODEL: bad }), bad).toContain(
        "ROCKY_LLM_REVIEW_PLATFORM_MODEL: must be a Foundry deployment name",
      );
    }
    expect(
      llmConfigFromEnv({ ...foundry, ROCKY_LLM_REVIEW_PLATFORM_MODEL: "opus.prod_eu-1" }).roles
        .review.platformModel,
    ).toBe("opus.prod_eu-1");
  });

  it("still takes Bedrock ARNs and inference profiles, which need : and /", () => {
    const arn =
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5";
    expect(
      llmConfigFromEnv({ ...bedrock, ROCKY_LLM_REVIEW_PLATFORM_MODEL: arn }).roles.review
        .platformModel,
    ).toBe(arn);
  });
});
