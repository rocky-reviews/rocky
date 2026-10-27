import { describe, expect, it } from "vitest";
import { LlmConfigError, parseLlmConfig } from "./config.js";
import { CLAUDE_MODELS, PROVIDER_CAPABILITIES, PROVIDER_KINDS } from "./providers.js";

/** P4-1: the role config as one validated object, whatever source it came from. */

const valid = () => ({
  providers: {
    anthropic: { kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
    "openai-compatible": { kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
  },
  roles: {
    triage: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
    review: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
    graph: { provider: "anthropic", model: "claude-sonnet-5-5" },
    ask: { provider: "openai-compatible", model: "llama3.1:8b", effort: "medium" },
    embed: { provider: "openai-compatible", model: "nomic-embed-text", dimensions: 768 },
  },
});

const without = <T extends object>(value: T, key: keyof T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Partial<T>;

const issuesOf = (input: unknown) => {
  try {
    parseLlmConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError);
    return (error as LlmConfigError).issues;
  }
  throw new Error("expected an LlmConfigError");
};

describe("parseLlmConfig", () => {
  it("accepts a complete config and returns it unchanged", () => {
    expect(parseLlmConfig(valid())).toEqual(valid());
  });

  it("accepts a disabled embed role", () => {
    const input = { ...valid(), roles: { ...valid().roles, embed: null } };
    expect(parseLlmConfig(input).roles.embed).toBeNull();
  });

  it("rejects a missing role", () => {
    const roles = without(valid().roles, "ask");
    expect(issuesOf({ ...valid(), roles })).toEqual([{ path: "roles.ask", message: "required" }]);
    const noEmbed = without(valid().roles, "embed");
    expect(issuesOf({ ...valid(), roles: noEmbed })).toEqual([
      { path: "roles.embed", message: "required (null disables embeddings)" },
    ]);
  });

  it("rejects unknown keys and non-objects", () => {
    expect(issuesOf({ ...valid(), extra: 1 })).toEqual([
      { path: "(root)", message: "unknown key extra" },
    ]);
    const roles = { ...valid().roles, review: { ...valid().roles.review, temperature: 0 } };
    expect(issuesOf({ ...valid(), roles })).toEqual([
      { path: "roles.review", message: "unknown key temperature" },
    ]);
    expect(issuesOf(null)).toEqual([{ path: "(root)", message: "must be an object" }]);
    expect(issuesOf("x")).toEqual([{ path: "(root)", message: "must be an object" }]);
  });

  it("does not echo an odd-looking unknown key", () => {
    const issues = issuesOf({ ...valid(), "sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz": 1 });
    expect(issues).toEqual([{ path: "(root)", message: "unknown key" }]);
  });

  it("requires a provider block for every provider a role uses", () => {
    const input = valid();
    const providers = without(input.providers, "openai-compatible");
    expect(issuesOf({ ...input, providers })).toEqual([
      { path: "roles.ask.provider", message: "provider openai-compatible is not configured" },
      { path: "roles.embed.provider", message: "provider openai-compatible is not configured" },
    ]);
  });

  it("rejects a provider block filed under another kind's name", () => {
    const input = valid();
    const providers = { ...input.providers, anthropic: { kind: "bedrock", region: "us-east-1" } };
    expect(issuesOf({ ...input, providers })).toEqual([
      { path: "providers.anthropic.kind", message: "must be anthropic" },
    ]);
  });

  it("rejects malformed regions and project ids", () => {
    const providers = {
      ...valid().providers,
      bedrock: { kind: "bedrock", region: "us east 1" },
      vertex: { kind: "vertex", projectId: "", region: "global" },
    };
    expect(issuesOf({ ...valid(), providers })).toEqual([
      { path: "providers.bedrock.region", message: "must be a region name such as us-east-1" },
      { path: "providers.vertex.projectId", message: "must not be blank" },
    ]);
  });

  it("rejects an over-long or whitespace model id on an open-model provider", () => {
    const roles = { ...valid().roles, ask: { provider: "openai-compatible", model: "a b" } };
    expect(issuesOf({ ...valid(), roles })).toEqual([
      {
        path: "roles.ask.model",
        message: "must be a model id without spaces (at most 200 characters)",
      },
    ]);
    const long = {
      ...valid().roles,
      ask: { provider: "openai-compatible", model: "a".repeat(201) },
    };
    expect(issuesOf({ ...valid(), roles: long })[0]?.path).toBe("roles.ask.model");
  });

  it("returns a frozen config", () => {
    const config = parseLlmConfig(valid());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.roles.review)).toBe(true);
    expect(Object.isFrozen(config.providers)).toBe(true);
  });
});

describe("provider capabilities", () => {
  it("describes every provider kind", () => {
    expect(Object.keys(PROVIDER_CAPABILITIES).sort()).toEqual([...PROVIDER_KINDS].sort());
  });

  it("offers the Claude catalogue on the four Claude platforms and any model on OpenAI-compatible", () => {
    for (const kind of ["anthropic", "bedrock", "vertex", "foundry"] as const) {
      expect(PROVIDER_CAPABILITIES[kind].models).toBe(CLAUDE_MODELS);
      expect(PROVIDER_CAPABILITIES[kind].embeddings).toBe(false);
    }
    expect(PROVIDER_CAPABILITIES["openai-compatible"].models).toBeUndefined();
    expect(PROVIDER_CAPABILITIES["openai-compatible"].embeddings).toBe(true);
  });

  it("includes the plan's default models with the full effort scale", () => {
    for (const id of ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(CLAUDE_MODELS.get(id)?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });
});
