import { testAppKeys } from "@rocky-reviews/forge-github/testing";
import { envSecrets, llmConfigFromEnv } from "@rocky-reviews/llm";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.js";
import { cliConfigFromEnv, loadCliConfig, missingKeys } from "./config.js";

/** P4-8: the CLI's configuration. Messages name variables, never values. */

const keys = testAppKeys();
const APP = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: keys.privateKeyPem };

describe("cliConfigFromEnv", () => {
  it("needs the GitHub App, not a database", () => {
    const config = cliConfigFromEnv({ ...APP });
    expect(config.githubApp.auth.appId).toBe(123456);
    expect(config.llm.roles.review.provider).toBe("anthropic");
  });

  it("names the missing GitHub App variables", () => {
    expect(() => cliConfigFromEnv({})).toThrow(ConfigError);
    expect(() => cliConfigFromEnv({})).toThrow(/GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/);
    expect(() => cliConfigFromEnv({ GITHUB_APP_ID: "1" })).toThrow(/must be set together/);
  });

  it("names a bad ROCKY_LLM_* variable, never its value", () => {
    const run = () => cliConfigFromEnv({ ...APP, ROCKY_LLM_REVIEW_EFFORT: "sk-ant-not-an-effort" });
    expect(run).toThrow(/ROCKY_LLM_REVIEW_EFFORT/);
    try {
      run();
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-ant");
    }
  });

  it("loadCliConfig removes the parsed app key from the environment", () => {
    const env: Record<string, string | undefined> = { ...APP };
    loadCliConfig(env);
    expect(env["GITHUB_APP_PRIVATE_KEY"]).toBeUndefined();
  });
});

describe("missingKeys", () => {
  it("names the BYOK variable a provider in use reads its key from", () => {
    const config = llmConfigFromEnv({});
    expect(missingKeys(config, envSecrets({}))).toEqual([
      "ANTHROPIC_API_KEY is not set: it holds the API key for the anthropic provider (named by ROCKY_LLM_ANTHROPIC_API_KEY_ENV)",
    ]);
    expect(missingKeys(config, envSecrets({ ANTHROPIC_API_KEY: "" }))).toHaveLength(1);
    expect(missingKeys(config, envSecrets({ ANTHROPIC_API_KEY: "sk-test" }))).toEqual([]);
  });

  it("follows a renamed key variable and every provider in use", () => {
    const config = llmConfigFromEnv({
      ROCKY_LLM_ANTHROPIC_API_KEY_ENV: "MY_CLAUDE_KEY",
      ROCKY_LLM_TRIAGE_PROVIDER: "openai-compatible",
      ROCKY_LLM_TRIAGE_MODEL: "qwen3",
      ROCKY_LLM_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      ROCKY_LLM_OPENAI_API_KEY_ENV: "LOCAL_KEY",
    });
    const missing = missingKeys(config, envSecrets({ LOCAL_KEY: "k" }));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/^MY_CLAUDE_KEY is not set/);
    expect(missingKeys(config, envSecrets({ MY_CLAUDE_KEY: "k" }))).toEqual([
      "LOCAL_KEY is not set: it holds the API key for the openai-compatible provider (named by ROCKY_LLM_OPENAI_API_KEY_ENV)",
    ]);
  });

  it("asks nothing of providers whose credentials come from the platform chain", () => {
    const config = llmConfigFromEnv({ ROCKY_LLM_PROVIDER: "bedrock", AWS_REGION: "us-east-1" });
    expect(missingKeys(config, envSecrets({}))).toEqual([]);
  });
});
