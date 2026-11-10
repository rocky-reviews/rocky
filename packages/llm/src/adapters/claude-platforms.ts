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
 * key at that moment (T1), with ambient Anthropic credentials disabled (T2): a key passed in code
 * is the 1.x client's only credential, so neither the `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
 * variables nor the SDK's profile and workload-identity chain (`ANTHROPIC_PROFILE`,
 * `ANTHROPIC_CONFIG_DIR`, `ANTHROPIC_FEDERATION_RULE_ID`, ...) are read; the Bedrock and Vertex
 * clients never consult that chain. The Bedrock, Vertex and Foundry SDKs are imported on first
 * use, so a worker that never calls them never loads them.
 */

const ANTHROPIC_API = "https://api.anthropic.com";
const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/**
 * The catalogue's models older than Claude 4.7 (`CLAUDE_MODELS`, `providers.ts`). Bedrock accepts
 * the SDK's API version (`2026-10-21`) for 4.7 and later only, and Vertex is assumed to follow the
 * same rule (none was published when this was written), so each of the two keeps these models on
 * its previous wire version (ADR 0013, amendment "1.x SDKs"). On Bedrock only Haiku 4.5 gets
 * this far: config refuses the other three there (`BEDROCK_MODELS`).
 */
const PRE_4_7_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);
const BEDROCK_PREVIOUS_API_VERSION = "2023-06-01";
/** Sent as the `anthropic-version` header; the Vertex client moves it into the body and drops the header. */
const VERTEX_PREVIOUS_API_VERSION = "vertex-2023-10-16";

/** A platform's `apiVersion`: its previous version for a pre-4.7 model, the SDK's default otherwise. */
const previousVersionFor =
  (version: string) =>
  (model: string): string | undefined =>
    PRE_4_7_MODELS.has(model) ? version : undefined;

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
        // The 1.x SDK sends the key as `Authorization: Bearer` (API version 2026-10-21); a
        // gateway at `baseUrl` must accept that form.
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
        // The Foundry client keeps sending the key as `x-api-key`.
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
        apiVersion: previousVersionFor(BEDROCK_PREVIOUS_API_VERSION),
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
        apiVersion: previousVersionFor(VERTEX_PREVIOUS_API_VERSION),
      },
      transport,
    );
  };
