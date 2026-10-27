import type {
  LlmOutputSchema,
  LlmProvider,
  LlmRoles,
  StructuredCompletionResult,
} from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { LlmConfigError, type LlmConfig } from "./config.js";
import { llmConfigFromEnv } from "./env.js";
import { createLlmRoles, envSecrets } from "./registry.js";
import { recordingAdapters } from "./testing.js";

/**
 * P4-1 acceptance: switching provider requires no code change. `reviewOnePr` stands in for the
 * pipeline (P4-3): it only ever asks roles for work. The same function and the same adapter set
 * run against three environments; only the environment differs.
 */

const verdict: LlmOutputSchema<{ verdict: string }> = {
  name: "verdict",
  jsonSchema: { type: "object", properties: { verdict: { type: "string" } } },
  parse: (value) =>
    typeof value === "object" && value !== null && "verdict" in value
      ? { success: true, data: value as { verdict: string } }
      : { success: false, issues: ["verdict missing"] },
};

const reviewOnePr = async (roles: LlmRoles): Promise<StructuredCompletionResult<unknown>[]> => {
  const request = {
    instructions: "Review the diff.",
    untrusted: [{ label: "diff", text: "+ console.log(1)" }],
    output: verdict,
    maxOutputTokens: 1000,
  };
  return [
    await roles.completion("triage").complete(request),
    await roles.completion("review").complete(request),
  ];
};

const ENVIRONMENTS = {
  anthropic: {},
  bedrock: { ROCKY_LLM_PROVIDER: "bedrock", ROCKY_LLM_BEDROCK_REGION: "us-east-1" },
  local: {
    ROCKY_LLM_PROVIDER: "openai-compatible",
    ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1",
    ROCKY_LLM_TRIAGE_MODEL: "qwen2.5-coder:7b",
    ROCKY_LLM_REVIEW_MODEL: "qwen2.5-coder:32b",
    ROCKY_LLM_GRAPH_MODEL: "qwen2.5-coder:14b",
    ROCKY_LLM_ASK_MODEL: "qwen2.5-coder:14b",
  },
} as const;

describe("switching provider requires no code change", () => {
  it("routes the same pipeline code to whichever provider the environment names", async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, env] of Object.entries(ENVIRONMENTS)) {
      const adapters = recordingAdapters();
      const roles = createLlmRoles(llmConfigFromEnv(env), adapters.factories, envSecrets(env));
      const results = await reviewOnePr(roles);
      expect(results.every((result) => result.status === "ok")).toBe(true);
      seen[name] = adapters.calls.map(({ kind, role, model, effort }) => ({
        kind,
        role,
        model,
        effort,
      }));
    }
    expect(seen).toEqual({
      anthropic: [
        { kind: "anthropic", role: "triage", model: "claude-haiku-5-5", effort: "low" },
        { kind: "anthropic", role: "review", model: "claude-opus-5-5", effort: "high" },
      ],
      bedrock: [
        { kind: "bedrock", role: "triage", model: "claude-haiku-5-5", effort: "low" },
        { kind: "bedrock", role: "review", model: "claude-opus-5-5", effort: "high" },
      ],
      local: [
        { kind: "openai-compatible", role: "triage", model: "qwen2.5-coder:7b", effort: undefined },
        {
          kind: "openai-compatible",
          role: "review",
          model: "qwen2.5-coder:32b",
          effort: undefined,
        },
      ],
    });
  });

  it("mixes providers per role from config alone", async () => {
    const env = {
      ROCKY_LLM_REVIEW_PROVIDER: "vertex",
      ROCKY_LLM_VERTEX_PROJECT_ID: "acme-ai",
      ROCKY_LLM_VERTEX_REGION: "global",
    };
    const adapters = recordingAdapters();
    await reviewOnePr(createLlmRoles(llmConfigFromEnv(env), adapters.factories, envSecrets(env)));
    expect(adapters.calls.map((call) => [call.role, call.kind])).toEqual([
      ["triage", "anthropic"],
      ["review", "vertex"],
    ]);
  });

  it("passes the request through untouched, plus the role's target", async () => {
    const adapters = recordingAdapters();
    const roles = createLlmRoles(llmConfigFromEnv({}), adapters.factories, envSecrets({}));
    const signal = new AbortController().signal;
    const request = {
      instructions: "i",
      untrusted: [{ label: "title", text: "t" }],
      output: verdict,
      maxOutputTokens: 5,
      signal,
    };
    expect(roles.completion("ask").role).toBe("ask");
    await roles.completion("ask").complete(request);
    expect(adapters.calls[0]).toEqual({
      ...request,
      kind: "anthropic",
      role: "ask",
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
  });
});

describe("createLlmRoles", () => {
  it("creates one adapter per provider kind, with its settings; keys are read only by name", async () => {
    const adapters = recordingAdapters();
    const env = { ANTHROPIC_API_KEY: "test-key" };
    const roles = createLlmRoles(llmConfigFromEnv(env), adapters.factories, envSecrets(env));
    expect(adapters.created).toEqual([
      { kind: "anthropic", settings: { kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" } },
    ]);
    expect(adapters.secretsRead).toEqual([]);
    await reviewOnePr(roles);
    expect(adapters.secretsRead).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]);
  });

  it("resolves a key by the name the config holds", () => {
    const env = { MY_KEY: "test-key" };
    const secrets = envSecrets(env);
    expect(secrets.get("MY_KEY")).toBe("test-key");
    expect(secrets.get("MISSING")).toBeUndefined();
    expect(envSecrets({ EMPTY: "" }).get("EMPTY")).toBeUndefined();
  });

  it("fails fast when a configured provider has no adapter installed", () => {
    const env = { ROCKY_LLM_REVIEW_PROVIDER: "bedrock", ROCKY_LLM_BEDROCK_REGION: "us-east-1" };
    const factories = { ...recordingAdapters().factories };
    delete factories.bedrock;
    expect(() => createLlmRoles(llmConfigFromEnv(env), factories, envSecrets(env))).toThrow(
      new LlmConfigError([
        { path: "roles.review.provider", message: "no adapter installed for provider bedrock" },
      ]),
    );
  });

  it("fails fast when an adapter lacks what a role needs", () => {
    const completionsOnly = (): LlmProvider => ({
      completeStructured: () => Promise.reject(new Error("unused")),
    });
    const embeddingsOnly = (): LlmProvider => ({
      embed: () => Promise.reject(new Error("unused")),
    });
    const config = llmConfigFromEnv({
      ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
      ROCKY_LLM_EMBED_MODEL: "nomic-embed-text",
      ROCKY_LLM_EMBED_DIMENSIONS: "768",
      ROCKY_LLM_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
    });
    expect(() =>
      createLlmRoles(
        config,
        { anthropic: embeddingsOnly, "openai-compatible": completionsOnly },
        envSecrets({}),
      ),
    ).toThrow(
      new LlmConfigError([
        { path: "roles.triage.provider", message: "the anthropic adapter has no completions" },
        { path: "roles.review.provider", message: "the anthropic adapter has no completions" },
        { path: "roles.graph.provider", message: "the anthropic adapter has no completions" },
        { path: "roles.ask.provider", message: "the anthropic adapter has no completions" },
        {
          path: "roles.embed.provider",
          message: "the openai-compatible adapter has no embeddings",
        },
      ]),
    );
  });

  it("has no embedding client while the embed role is disabled", () => {
    const roles = createLlmRoles(
      llmConfigFromEnv({}),
      recordingAdapters().factories,
      envSecrets({}),
    );
    expect(roles.embedding()).toBeUndefined();
  });

  it("sends embeddings to the embed role's provider with model and dimensions", async () => {
    const env = {
      ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
      ROCKY_LLM_EMBED_MODEL: "nomic-embed-text",
      ROCKY_LLM_EMBED_DIMENSIONS: "768",
      ROCKY_LLM_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
    };
    const adapters = recordingAdapters();
    const roles = createLlmRoles(llmConfigFromEnv(env), adapters.factories, envSecrets(env));
    const result = await roles.embedding()?.embed({ inputs: ["a", "b"] });
    expect(result?.vectors).toHaveLength(2);
    expect(result?.vectors[0]).toHaveLength(768);
    expect(adapters.embedCalls).toEqual([
      { kind: "openai-compatible", inputs: ["a", "b"], model: "nomic-embed-text", dimensions: 768 },
    ]);
  });

  it("rejects an unknown completion role at runtime", () => {
    const roles = createLlmRoles(
      llmConfigFromEnv({}),
      recordingAdapters().factories,
      envSecrets({}),
    );
    expect(() => roles.completion("embed" as never)).toThrow(/unknown completion role/);
  });

  it("refuses a config object that did not come from parseLlmConfig", () => {
    const forged = JSON.parse(JSON.stringify(llmConfigFromEnv({}))) as LlmConfig;
    expect(() => createLlmRoles(forged, recordingAdapters().factories, envSecrets({}))).toThrow(
      /parseLlmConfig/,
    );
  });
});
