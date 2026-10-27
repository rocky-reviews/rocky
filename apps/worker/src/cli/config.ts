import type { LlmCompletionRole } from "@rocky-reviews/core";
import {
  LlmConfigError,
  llmConfigFromEnv,
  type LlmConfig,
  type SecretSource,
} from "@rocky-reviews/llm";
import { ConfigError, githubAppFromEnv, type GitHubAppConfig } from "../config.js";

/**
 * The CLI's configuration (P4-8): the GitHub App (to read the pull request) and the LLM roles
 * (`ROCKY_LLM_*`, ADR 0012). No database: nothing is stored. Messages name variables, never values.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface CliConfig {
  readonly githubApp: GitHubAppConfig;
  readonly llm: LlmConfig;
}

export const cliConfigFromEnv = (env: Env): CliConfig => {
  const githubApp = githubAppFromEnv(env);
  if (githubApp === undefined) {
    throw new ConfigError(
      "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required to read the pull request from GitHub",
    );
  }
  let llm: LlmConfig;
  try {
    llm = llmConfigFromEnv(env);
  } catch (error) {
    if (error instanceof LlmConfigError) throw new ConfigError(error.message);
    throw new ConfigError("ROCKY_LLM_*: invalid LLM configuration");
  }
  return { githubApp, llm };
};

/** As the worker does (L6): once parsed, the app key lives on only in a KeyObject. */
export const loadCliConfig = (env: Record<string, string | undefined>): CliConfig => {
  const config = cliConfigFromEnv(env);
  delete env["GITHUB_APP_PRIVATE_KEY"];
  return config;
};

/** The variable that names each keyed provider's key variable (`*_API_KEY_ENV`). */
const KEY_ENV_VARIABLE = {
  anthropic: "ROCKY_LLM_ANTHROPIC_API_KEY_ENV",
  foundry: "ROCKY_LLM_FOUNDRY_API_KEY_ENV",
  "openai-compatible": "ROCKY_LLM_OPENAI_API_KEY_ENV",
} as const;

/**
 * A message per BYOK key variable that a provider in use reads its key from and that is unset.
 * Checked before the run so a missing key fails with its name instead of an `llm_auth` halfway
 * through. Only presence is checked: the adapters still read the key at call time, through the
 * same `SecretSource`. Bedrock and Vertex take credentials from their platform chain.
 */
export const missingKeys = (config: LlmConfig, secrets: SecretSource): string[] => {
  const used = new Set(
    Object.values(config.roles).flatMap((role) => (role === null ? [] : [role.provider])),
  );
  const messages: string[] = [];
  for (const kind of used) {
    const settings = config.providers[kind];
    if (settings === undefined || !(kind in KEY_ENV_VARIABLE)) continue;
    const name = "apiKeyEnv" in settings ? settings.apiKeyEnv : undefined;
    if (name === undefined || secrets.get(name) !== undefined) continue;
    messages.push(
      `${name} is not set: it holds the API key for the ${kind} provider (named by ${KEY_ENV_VARIABLE[kind as keyof typeof KEY_ENV_VARIABLE]})`,
    );
  }
  return messages;
};

/**
 * How many times a role's call can bill its input, for the spend cap: on the Anthropic API a
 * server-side refusal fallback (on unless `ROCKY_LLM_ANTHROPIC_FALLBACKS=off`, ADR 0013 §1) re-runs
 * the call on one fallback model inside the same request, so the input is reserved twice. Every
 * role on that provider counts, whether or not its model takes fallbacks: over-reserving is safe.
 */
export const inputAttemptsFor =
  (config: LlmConfig) =>
  (role: LlmCompletionRole): number => {
    const provider = config.roles[role].provider;
    const settings = config.providers.anthropic;
    return provider === "anthropic" && settings?.fallbacks !== "off" ? 2 : 1;
  };
