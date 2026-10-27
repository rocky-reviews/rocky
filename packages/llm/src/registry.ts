import {
  LLM_COMPLETION_ROLES,
  type CompletionRoleClient,
  type EmbeddingRoleClient,
  type LlmCompletionRole,
  type LlmProvider,
  type LlmRoles,
} from "@rocky-reviews/core";
import {
  isValidatedLlmConfig,
  LlmConfigError,
  type LlmConfig,
  type LlmConfigIssue,
  type ProviderSettingsOf,
} from "./config.js";
import type { ProviderKind } from "./providers.js";

/**
 * Role registry (P4-1, ADR 0012): resolves each role to the adapter of its configured provider.
 * Callers hold `LlmRoles` and never learn which provider, model or effort they got, so moving a
 * role to another provider is a config change only.
 */

/** Looks a credential up by the name the config holds. Env today; per-org BYOK later. */
export interface SecretSource {
  get(name: string): string | undefined;
}

export const envSecrets = (env: Readonly<Record<string, string | undefined>>): SecretSource => ({
  get: (name) => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  },
});

/** Builds an adapter from its provider's settings. Keys are read through `secrets`, by name. */
export type ProviderAdapterFactory<K extends ProviderKind> = (
  settings: ProviderSettingsOf<K>,
  secrets: SecretSource,
) => LlmProvider;

export type ProviderAdapters = { readonly [K in ProviderKind]?: ProviderAdapterFactory<K> };

export const createLlmRoles = (
  config: LlmConfig,
  adapters: ProviderAdapters,
  secrets: SecretSource,
): LlmRoles => {
  if (!isValidatedLlmConfig(config)) {
    throw new TypeError("createLlmRoles needs a config from parseLlmConfig or llmConfigFromEnv");
  }
  const issues: LlmConfigIssue[] = [];
  const instances = new Map<ProviderKind, LlmProvider | undefined>();

  const providerFor = (kind: ProviderKind, path: string): LlmProvider | undefined => {
    if (!instances.has(kind)) {
      const factory = adapters[kind] as ProviderAdapterFactory<ProviderKind> | undefined;
      const settings = config.providers[kind];
      // A validated config has settings for every provider a role uses.
      instances.set(
        kind,
        factory === undefined || settings === undefined ? undefined : factory(settings, secrets),
      );
    }
    const provider = instances.get(kind);
    if (provider === undefined) {
      issues.push({ path, message: `no adapter installed for provider ${kind}` });
    }
    return provider;
  };

  const completions = new Map<LlmCompletionRole, CompletionRoleClient>();
  for (const role of LLM_COMPLETION_ROLES) {
    const target = config.roles[role];
    const path = `roles.${role}.provider`;
    const provider = providerFor(target.provider, path);
    if (provider === undefined) continue;
    const complete = provider.completeStructured?.bind(provider);
    if (complete === undefined) {
      issues.push({ path, message: `the ${target.provider} adapter has no completions` });
      continue;
    }
    completions.set(role, {
      role,
      complete: async (request) => ({
        ...(await complete({
          ...request,
          role,
          model: target.model,
          platformModel: target.platformModel,
          effort: target.effort,
        })),
        // Stamped here, last, so metering always knows who served the call (review S3).
        provider: target.provider,
      }),
    });
  }

  let embedding: EmbeddingRoleClient | undefined;
  const embed = config.roles.embed;
  if (embed !== null) {
    const path = "roles.embed.provider";
    const provider = providerFor(embed.provider, path);
    const call = provider?.embed?.bind(provider);
    if (provider !== undefined && call === undefined) {
      issues.push({ path, message: `the ${embed.provider} adapter has no embeddings` });
    }
    if (call !== undefined) {
      embedding = {
        embed: async (request) => ({
          ...(await call({ ...request, model: embed.model, dimensions: embed.dimensions })),
          provider: embed.provider,
        }),
      };
    }
  }

  if (issues.length > 0) throw new LlmConfigError(issues);

  return {
    completion: (role) => {
      const client = completions.get(role);
      if (client === undefined) throw new TypeError("unknown completion role");
      return client;
    },
    embedding: () => embedding,
  };
};
