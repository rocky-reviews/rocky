import Anthropic from "@anthropic-ai/sdk";
import { isLlmCallError, LlmCallError } from "@rocky-reviews/core";
import type { ProviderAdapterFactory, SecretSource } from "../registry.js";
import { assertAmbientAtBoot } from "./ambient.js";
import { claudeProvider, FALLBACK_MODELS, type ClaudeMessagesClient } from "./claude.js";
import {
  hardenedClientOptions,
  type AdapterTransport,
  type VertexAuthClient,
  type VertexAuthSource,
} from "./transport.js";

/**
 * Client factories for the four Claude platforms (P4-2, ADR 0013 §1). Each one pins its host from
 * validated config, so no `ANTHROPIC_*_BASE_URL` variable can redirect a key or PR content (T3).
 * Every call builds its own client over that call's capped `fetch` (T9); keyed platforms read the
 * key at that moment (T1), with ambient Anthropic credentials disabled (T2). The Bedrock, Vertex
 * and Foundry SDKs are imported on first use, so a worker that never calls them never loads them.
 */

const ANTHROPIC_API = "https://api.anthropic.com";
const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Reads a configured key at call time; a missing one fails before anything is sent. */
const keyFrom = (secrets: SecretSource, name: string): string => {
  const key = secrets.get(name);
  if (key === undefined || key === "") throw new LlmCallError("auth");
  return key;
};

const never = () => false;

/**
 * Loads a platform SDK on first use (N6). A failed import does not heal by retrying (a missing or
 * broken install), so it is fatal: `invalid_request`, never a retryable kind (review round 2).
 */
const load = async <M>(module: () => Promise<M>): Promise<M> => {
  try {
    return await module();
  } catch {
    throw new LlmCallError("invalid_request");
  }
};

export const anthropicAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"anthropic"> =>
  (settings, secrets) => {
    assertAmbientAtBoot("anthropic");
    const fallbacks = settings.fallbacks !== "off";
    return claudeProvider(
      {
        kind: "anthropic",
        modelId: (model) => model,
        client: (fetch) =>
          Promise.resolve(
            new Anthropic({
              ...hardenedClientOptions(transport, fetch),
              apiKey: keyFrom(secrets, settings.apiKeyEnv),
              authToken: null,
              baseURL: settings.baseUrl ?? ANTHROPIC_API,
            }),
          ),
        serverFallbacks: (model) => fallbacks && FALLBACK_MODELS.has(model),
      },
      transport,
    );
  };

export const foundryAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"foundry"> =>
  (settings, secrets) => {
    assertAmbientAtBoot("foundry");
    return claudeProvider(
      {
        kind: "foundry",
        // Foundry's default deployment name is the canonical id; `platformModel` names others.
        modelId: (model) => model,
        client: async (fetch) => {
          const apiKey = keyFrom(secrets, settings.apiKeyEnv);
          const { AnthropicFoundry } = await load(() => import("@anthropic-ai/foundry-sdk"));
          return new AnthropicFoundry({
            ...hardenedClientOptions(transport, fetch),
            apiKey,
            authToken: null,
            resource: settings.resource,
            // `null`, not `undefined`: undefined would read ANTHROPIC_FOUNDRY_BASE_URL.
            baseURL: null,
          }) as unknown as ClaudeMessagesClient;
        },
        serverFallbacks: never,
      },
      transport,
    );
  };

export const bedrockAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"bedrock"> =>
  (settings) => {
    assertAmbientAtBoot("bedrock");
    return claudeProvider(
      {
        kind: "bedrock",
        modelId: (model) => `anthropic.${model}`,
        // AWS credentials come from the default chain (or AWS_BEARER_TOKEN_BEDROCK); Rocky holds
        // none. The client resolves them per request, so a failed lookup is not cached.
        client: async (fetch) => {
          const { AnthropicBedrockMantle } = await load(() => import("@anthropic-ai/bedrock-sdk"));
          return new AnthropicBedrockMantle({
            ...hardenedClientOptions(transport, fetch),
            awsRegion: settings.region,
            baseURL: `https://bedrock-mantle.${settings.region}.api.aws/anthropic`,
            ...(transport.bedrockCredentials === undefined
              ? {}
              : { providerChainResolver: transport.bedrockCredentials }),
          });
        },
        serverFallbacks: never,
      },
      transport,
    );
  };

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

/** Google application default credentials, as the Vertex client would build them. */
const applicationDefault = async (): Promise<VertexAuthSource> => {
  const { GoogleAuth } = await load(() => import("google-auth-library"));
  return new GoogleAuth({ scopes: GOOGLE_CLOUD_SCOPE }).getClient();
};

/**
 * One auth client per adapter, built on first use and reused (it caches its token). A failed
 * lookup is dropped, not cached: the Vertex client would otherwise keep the rejected promise for
 * the life of the process (review round 1, S3). Its error text is dropped too.
 */
export const vertexAuthOnce = (source: () => Promise<VertexAuthSource>) => {
  let pending: Promise<VertexAuthSource> | undefined;
  return async (): Promise<VertexAuthSource> => {
    const lookup = (pending ??= source());
    try {
      return await lookup;
    } catch (error) {
      // Only this lookup is dropped: a late failure must not discard a newer one.
      if (pending === lookup) pending = undefined;
      throw isLlmCallError(error) ? error : new LlmCallError("network");
    }
  };
};

export const vertexAdapter =
  (transport: AdapterTransport): ProviderAdapterFactory<"vertex"> =>
  (settings) => {
    assertAmbientAtBoot("vertex");
    const auth = vertexAuthOnce(transport.vertexAuth ?? applicationDefault);
    return claudeProvider(
      {
        kind: "vertex",
        modelId: (model) => VERTEX_DATED_IDS[model] ?? model,
        client: async (fetch) => {
          const authClient = (await auth()) as unknown as VertexAuthClient;
          const { AnthropicVertex } = await load(() => import("@anthropic-ai/vertex-sdk"));
          return new AnthropicVertex({
            ...hardenedClientOptions(transport, fetch),
            region: settings.region,
            projectId: settings.projectId,
            baseURL: vertexBaseUrl(settings.region),
            authClient,
          });
        },
        serverFallbacks: never,
      },
      transport,
    );
  };
