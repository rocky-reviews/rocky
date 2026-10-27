import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { LlmCallError } from "@rocky-reviews/core";
import type { ProviderAdapterFactory, SecretSource } from "../registry.js";
import { claudeProvider, type ClaudeMessagesClient } from "./claude.js";
import {
  hardenedClientOptions,
  type AdapterTransport,
  type VertexAuthClient,
} from "./transport.js";

/**
 * Client factories for the four Claude platforms (P4-2, ADR 0013 §1). Each one pins its host from
 * validated config, so no `ANTHROPIC_*_BASE_URL` variable can redirect a key or PR content (T3).
 * Keyed platforms build a client per call from a key read at that moment (T1), with ambient
 * Anthropic credentials disabled (T2).
 */

const ANTHROPIC_API = "https://api.anthropic.com";

/** Reads a configured key at call time; a missing one fails before anything is sent. */
const keyFrom = (secrets: SecretSource, name: string): string => {
  const key = secrets.get(name);
  if (key === undefined || key === "") throw new LlmCallError("auth");
  return key;
};

/** Built on first use, so a boot without platform credentials does not reach for them. */
const lazily = <C>(make: () => C): (() => C) => {
  let client: C | undefined;
  return () => (client ??= make());
};

export const anthropicAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"anthropic"> =>
  (settings, secrets) =>
    claudeProvider(
      {
        modelId: (model) => model,
        client: (): ClaudeMessagesClient =>
          new Anthropic({
            ...hardenedClientOptions(transport),
            apiKey: keyFrom(secrets, settings.apiKeyEnv),
            authToken: null,
            baseURL: settings.baseUrl ?? ANTHROPIC_API,
          }),
        serverFallbacks: true,
      },
      transport,
    );

export const foundryAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"foundry"> =>
  (settings, secrets) =>
    claudeProvider(
      {
        // Foundry's default deployment name is the canonical id; `platformModel` names others.
        modelId: (model) => model,
        client: (): ClaudeMessagesClient =>
          new AnthropicFoundry({
            ...hardenedClientOptions(transport),
            apiKey: keyFrom(secrets, settings.apiKeyEnv),
            authToken: null,
            resource: settings.resource,
            // `null`, not `undefined`: undefined would read ANTHROPIC_FOUNDRY_BASE_URL.
            baseURL: null,
          }) as unknown as ClaudeMessagesClient,
        serverFallbacks: false,
      },
      transport,
    );

export const bedrockAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"bedrock"> =>
  (settings) =>
    claudeProvider(
      {
        modelId: (model) => `anthropic.${model}`,
        // AWS credentials come from the default chain (or AWS_BEARER_TOKEN_BEDROCK); Rocky holds
        // none, so one client is reused and its credential cache with it.
        client: lazily(
          (): ClaudeMessagesClient =>
            new AnthropicBedrockMantle({
              ...hardenedClientOptions(transport),
              awsRegion: settings.region,
              baseURL: `https://bedrock-mantle.${settings.region}.api.aws/anthropic`,
              ...(transport.bedrockCredentials === undefined
                ? {}
                : { providerChainResolver: transport.bedrockCredentials }),
            }),
        ),
        serverFallbacks: false,
      },
      transport,
    );

/** Vertex serves the pre-4.6 models under dated ids only (Claude on Vertex AI, model table). */
const VERTEX_DATED_IDS: Readonly<Record<string, string>> = {
  "claude-opus-4-5": "claude-opus-4-5@20251101",
  "claude-haiku-4-5": "claude-haiku-4-5@20251001",
};

/** The Vertex endpoint for a region, as the Vertex client derives it (pinned here, T3). */
export const vertexBaseUrl = (region: string): string => {
  switch (region) {
    case "global":
      return "https://aiplatform.googleapis.com/v1";
    case "us":
    case "eu":
      return `https://aiplatform.${region}.rep.googleapis.com/v1`;
    default:
      return `https://${region}-aiplatform.googleapis.com/v1`;
  }
};

export const vertexAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"vertex"> =>
  (settings) =>
    claudeProvider(
      {
        modelId: (model) => VERTEX_DATED_IDS[model] ?? model,
        client: lazily(
          (): ClaudeMessagesClient =>
            new AnthropicVertex({
              ...hardenedClientOptions(transport),
              region: settings.region,
              projectId: settings.projectId,
              baseURL: vertexBaseUrl(settings.region),
              ...(transport.vertexAuthClient === undefined
                ? {}
                : { authClient: transport.vertexAuthClient as unknown as VertexAuthClient }),
            }),
        ),
        serverFallbacks: false,
      },
      transport,
    );
