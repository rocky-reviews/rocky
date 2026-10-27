import type { BedrockMantleClientOptions } from "@anthropic-ai/bedrock-sdk";
import type { ClientOptions } from "@anthropic-ai/sdk";
import type { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { newNonce } from "./untrusted.js";

/**
 * Transport options for the adapters (P4-2, ADR 0013 §7). Production passes none; tests inject
 * `fetch` and the platform credential sources so nothing reaches a live API.
 */
export interface AdapterTransport {
  readonly fetch?: typeof globalThis.fetch;
  /** SDK retries for 408/409/429/5xx and connection errors (default 2). */
  readonly maxRetries?: number;
  /** Per-request timeout in ms (default 10 minutes). */
  readonly timeoutMs?: number;
  /** Delimiter ids for untrusted content (default: 96 random bits). */
  readonly nonce?: () => string;
  /** Bedrock: replaces the AWS default credential chain. */
  readonly bedrockCredentials?: BedrockMantleClientOptions["providerChainResolver"];
  /** Vertex: replaces Google application default credentials (a google-auth-library client). */
  readonly vertexAuthClient?: VertexAuthSource;
}

/** The part of a google-auth-library `AuthClient` the Vertex client uses. */
export interface VertexAuthSource {
  readonly projectId?: string | null | undefined;
  getRequestHeaders(): Promise<Headers>;
}

export type VertexAuthClient = NonNullable<
  NonNullable<ConstructorParameters<typeof AnthropicVertex>[0]>["authClient"]
>;

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_RETRIES = 2;

const silent = () => undefined;
/** A logger that drops everything: the SDK never logs request bodies, headers or model output. */
const SILENT_LOGGER = { error: silent, warn: silent, info: silent, debug: silent };

/**
 * Options every Claude SDK client gets (threats T1–T3). Each one is set explicitly so the
 * environment cannot change it: `ANTHROPIC_LOG` cannot turn on logging, OpenTelemetry content
 * capture cannot copy prompts into traces, and no redirect can carry `x-api-key` to another host.
 */
export const hardenedClientOptions = (transport: AdapterTransport) =>
  ({
    logLevel: "off",
    logger: SILENT_LOGGER,
    openTelemetry: false,
    fetchOptions: { redirect: "error" },
    maxRetries: transport.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeout: transport.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(transport.fetch === undefined ? {} : { fetch: transport.fetch }),
  }) satisfies Partial<ClientOptions>;

export const nonceSource = (transport: AdapterTransport): (() => string) =>
  transport.nonce ?? newNonce;
