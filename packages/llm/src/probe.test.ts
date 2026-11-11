import { LlmCallError, type LlmProvider } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { LlmConfigError } from "./config.js";
import { llmConfigFromEnv } from "./env.js";
import { PROBE_MAX_OUTPUT_TOKENS, probeLlmConfig, probeTargets } from "./probe.js";
import { envSecrets } from "./registry.js";
import { recordingAdapters } from "./testing.js";

/**
 * P10-2: the setup wizard's provider test call. Fake adapters stand in for the transport: no
 * network, and the tests read what each adapter was sent.
 */

const clock = () => {
  let t = 1_000;
  return () => (t += 25);
};

describe("probeLlmConfig (P10-2)", () => {
  it("makes one minimal call per distinct provider and model, with no PR content", async () => {
    const adapters = recordingAdapters({ ok: true });
    const config = llmConfigFromEnv({ ROCKY_LLM_REVIEW_MODEL: "claude-opus-5-5" });
    const results = await probeLlmConfig(config, adapters.factories, envSecrets({}), {
      now: clock(),
    });
    const triage = config.roles.triage;
    const review = config.roles.review;
    expect(triage.model).not.toBe(review.model);
    const models = new Set(
      ["triage", "review", "graph", "ask"].map((r) => config.roles[r as "triage"].model),
    );
    expect(results).toHaveLength(models.size);
    expect(results.flatMap((r) => r.roles).sort()).toEqual(["ask", "graph", "review", "triage"]);
    expect(results.find((r) => r.roles.includes("review"))?.model).toBe("claude-opus-5-5");
    expect(results.every((r) => r.outcome === "ok" && r.durationMs === 25)).toBe(true);
    expect(adapters.calls).toHaveLength(results.length);
    for (const call of adapters.calls) {
      expect(call.untrusted).toEqual([]);
      expect(call.maxOutputTokens).toBe(PROBE_MAX_OUTPUT_TOKENS);
      expect(call.instructions.text).toMatch(/connectivity check/);
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    expect(results[0]).toMatchObject({ provider: "anthropic", model: triage.model });
  });

  it("counts any answer as working, and reports call failures by kind", async () => {
    const malformed = await probeLlmConfig(
      llmConfigFromEnv({}),
      recordingAdapters({ nope: 1 }).factories,
      envSecrets({}),
    );
    expect(malformed.every((r) => r.outcome === "answered")).toBe(true);

    const auth = await probeLlmConfig(
      llmConfigFromEnv({}),
      recordingAdapters({ ok: true }, { fail: "auth" }).factories,
      envSecrets({}),
    );
    expect(auth.every((r) => r.outcome === "auth")).toBe(true);

    const thrower: LlmProvider = {
      completeStructured: () => Promise.reject(new Error("socket hang up: secret-ish detail")),
    };
    const other = await probeLlmConfig(
      llmConfigFromEnv({}),
      { anthropic: () => thrower },
      envSecrets({}),
    );
    expect(other.map((r) => r.outcome)).toEqual(other.map(() => "failed"));
    expect(JSON.stringify(other)).not.toMatch(/socket|secret/);
  });

  it("tests the embedding model when one is configured, with one short input", async () => {
    const env = {
      ROCKY_LLM_PROVIDER: "openai-compatible",
      ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1",
      ROCKY_LLM_TRIAGE_MODEL: "qwen2.5-coder:7b",
      ROCKY_LLM_REVIEW_MODEL: "qwen2.5-coder:7b",
      ROCKY_LLM_GRAPH_MODEL: "qwen2.5-coder:7b",
      ROCKY_LLM_ASK_MODEL: "qwen2.5-coder:7b",
      ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
      ROCKY_LLM_EMBED_MODEL: "nomic-embed-text",
      ROCKY_LLM_EMBED_DIMENSIONS: "768",
    };
    const adapters = recordingAdapters({ ok: true });
    const results = await probeLlmConfig(llmConfigFromEnv(env), adapters.factories, envSecrets({}));
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      roles: ["triage", "review", "graph", "ask"],
      provider: "openai-compatible",
      outcome: "ok",
    });
    expect(results[1]).toMatchObject({
      roles: ["embed"],
      provider: "openai-compatible",
      model: "nomic-embed-text",
      outcome: "ok",
    });
    expect(adapters.embedCalls.map((c) => c.inputs)).toEqual([["rocky"]]);

    const narrow: LlmProvider = {
      completeStructured: (call) =>
        Promise.resolve({
          status: "ok",
          value: { ok: true } as never,
          model: call.model,
          usage: undefined,
        }),
      embed: () => Promise.resolve({ vectors: [[0, 1]], model: "m", usage: undefined }),
    };
    const wrong = await probeLlmConfig(
      llmConfigFromEnv(env),
      { "openai-compatible": () => narrow },
      envSecrets({}),
    );
    expect(wrong[1]?.outcome).toBe("wrong_dimensions");

    const failing: LlmProvider = {
      ...narrow,
      embed: () => Promise.reject(new LlmCallError("network")),
    };
    const down = await probeLlmConfig(
      llmConfigFromEnv(env),
      { "openai-compatible": () => failing },
      envSecrets({}),
    );
    expect(down[1]?.outcome).toBe("network");
  });

  it("lists the targets it would call, without calling anything", () => {
    const adapters = recordingAdapters({ ok: true });
    const config = llmConfigFromEnv({
      ROCKY_LLM_PROVIDER: "openai-compatible",
      ROCKY_LLM_OPENAI_BASE_URL: "http://ollama:11434/v1",
      ROCKY_LLM_TRIAGE_MODEL: "small",
      ROCKY_LLM_REVIEW_MODEL: "big",
      ROCKY_LLM_GRAPH_MODEL: "big",
      ROCKY_LLM_ASK_MODEL: "small",
      ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
      ROCKY_LLM_EMBED_MODEL: "nomic-embed-text",
      ROCKY_LLM_EMBED_DIMENSIONS: "768",
    });
    expect(probeTargets(config)).toEqual([
      { roles: ["triage", "ask"], provider: "openai-compatible", model: "small" },
      { roles: ["review", "graph"], provider: "openai-compatible", model: "big" },
      { roles: ["embed"], provider: "openai-compatible", model: "nomic-embed-text" },
    ]);
    expect(adapters.calls).toEqual([]);
  });

  it("throws only when no roles can be built", async () => {
    await expect(probeLlmConfig(llmConfigFromEnv({}), {}, envSecrets({}))).rejects.toBeInstanceOf(
      LlmConfigError,
    );
  });
});
