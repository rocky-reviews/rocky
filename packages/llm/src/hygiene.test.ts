import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { LlmConfigError, parseLlmConfig } from "./config.js";
import { llmConfigFromEnv } from "./env.js";
import { createLlmRoles, envSecrets } from "./registry.js";
import { recordingAdapters } from "./testing.js";

/**
 * P4-1 secret hygiene: the role config refers to credentials by variable name only. No config
 * dump, error message or registry object may carry a key, wherever the key was put by mistake.
 */

// Built at runtime so no scanner sees a key-shaped literal in the repo.
const KEY = ["sk", "ant", "api03", "Zq9x".repeat(10)].join("-");
const AWS = ["AKIA", "Q7W3E9R1T5Y2U8I4"].join("");

const secretEnv = {
  ANTHROPIC_API_KEY: KEY,
  ANTHROPIC_FOUNDRY_API_KEY: KEY,
  AWS_ACCESS_KEY_ID: AWS,
  OLLAMA_API_KEY: KEY,
};

const assertClean = (text: string, label: string) => {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain("Zq9xZq9x");
  expect(text, label).not.toContain(AWS);
};

const errorText = (fn: () => unknown, label = ""): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError);
    return [
      (error as Error).message,
      (error as Error).stack ?? "",
      JSON.stringify(error),
      JSON.stringify((error as LlmConfigError).issues),
      inspect(error, { depth: 10 }),
    ].join("\n");
  }
  throw new Error(`expected an LlmConfigError ${label}`);
};

describe("LLM config secret hygiene", () => {
  it("a loaded config names key variables and never holds their values", () => {
    const env = {
      ...secretEnv,
      ROCKY_LLM_REVIEW_PROVIDER: "foundry",
      ROCKY_LLM_FOUNDRY_RESOURCE: "acme",
      ROCKY_LLM_EMBED_PROVIDER: "openai-compatible",
      ROCKY_LLM_EMBED_MODEL: "nomic-embed-text",
      ROCKY_LLM_EMBED_DIMENSIONS: "768",
      ROCKY_LLM_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      ROCKY_LLM_OPENAI_API_KEY_ENV: "OLLAMA_API_KEY",
    };
    const config = llmConfigFromEnv(env);
    assertClean(JSON.stringify(config), "JSON");
    assertClean(inspect(config, { depth: 10 }), "inspect");
    expect(JSON.stringify(config)).toContain("ANTHROPIC_FOUNDRY_API_KEY");

    const adapters = recordingAdapters();
    const roles = createLlmRoles(config, adapters.factories, envSecrets(env));
    assertClean(inspect(roles, { depth: 10, showHidden: true }), "roles");
    assertClean(JSON.stringify(roles), "roles JSON");
  });

  it("a key pasted into any LLM variable is refused without being echoed", () => {
    const cases: Record<string, string>[] = [
      { ROCKY_LLM_ANTHROPIC_API_KEY_ENV: KEY },
      { ROCKY_LLM_FOUNDRY_API_KEY_ENV: KEY, ROCKY_LLM_PROVIDER: "foundry" },
      { ROCKY_LLM_OPENAI_API_KEY_ENV: KEY },
      { ROCKY_LLM_PROVIDER: KEY },
      { ROCKY_LLM_REVIEW_PROVIDER: KEY },
      { ROCKY_LLM_REVIEW_MODEL: KEY },
      { ROCKY_LLM_REVIEW_EFFORT: KEY },
      { ROCKY_LLM_EMBED_DIMENSIONS: KEY, ROCKY_LLM_EMBED_MODEL: "m" },
      { ROCKY_LLM_BEDROCK_REGION: KEY, ROCKY_LLM_PROVIDER: "bedrock" },
      { ROCKY_LLM_VERTEX_PROJECT_ID: KEY, ROCKY_LLM_PROVIDER: "vertex" },
      { ROCKY_LLM_FOUNDRY_RESOURCE: KEY, ROCKY_LLM_PROVIDER: "foundry" },
      { ROCKY_LLM_ANTHROPIC_BASE_URL: `https://x:${KEY}@api.example.com` },
      { ROCKY_LLM_ANTHROPIC_BASE_URL: `https://api.example.com/?key=${KEY}` },
      { ROCKY_LLM_OPENAI_BASE_URL: KEY },
      { ROCKY_LLM_ANTHROPIC_API_KEY: KEY },
    ];
    for (const env of cases) {
      const label = Object.keys(env)[0]!;
      assertClean(
        errorText(() => llmConfigFromEnv({ ...secretEnv, ...env }), label),
        label,
      );
    }
  });

  it("refuses a credential-shaped value even where the field's own format would accept it", () => {
    const text = errorText(() =>
      llmConfigFromEnv({ ROCKY_LLM_PROVIDER: "foundry", ROCKY_LLM_FOUNDRY_RESOURCE: KEY }),
    );
    expect(text).toContain(
      "ROCKY_LLM_FOUNDRY_RESOURCE: looks like a credential: name the variable that holds it instead",
    );
    assertClean(text, "resource");
  });

  it("an object config with a key in place of a value is refused without being echoed", () => {
    const roles = {
      triage: { provider: "anthropic", model: KEY },
      review: { provider: "openai-compatible", model: `bad ${KEY}` },
      graph: { provider: "anthropic", model: "claude-sonnet-5-5", effort: KEY },
      ask: { provider: KEY, model: "m" },
      embed: { provider: "openai-compatible", model: "m", dimensions: KEY },
    };
    const providers = {
      anthropic: { kind: "anthropic", apiKeyEnv: KEY, apiKey: KEY },
      "openai-compatible": { kind: "openai-compatible", baseUrl: `https://${KEY}@h` },
    };
    assertClean(
      errorText(() => parseLlmConfig({ providers, roles, [KEY]: KEY })),
      "object",
    );
  });
});
