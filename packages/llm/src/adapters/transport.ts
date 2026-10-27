import type { BedrockMantleClientOptions } from "@anthropic-ai/bedrock-sdk";
import type { ClientOptions } from "@anthropic-ai/sdk";
import type { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { LlmCallError } from "@rocky-reviews/core";
import { newNonce } from "./untrusted.js";

/**
 * Transport options for the adapters (P4-2, ADR 0013 §7). Production passes none; tests inject
 * `fetch` and the platform credential sources so nothing reaches a live API.
 */
export interface AdapterTransport {
  readonly fetch?: typeof globalThis.fetch;
  /** SDK retries for 408/409/429/5xx and connection errors (default 2). */
  readonly maxRetries?: number;
  /** Deadline for a whole call in ms, streaming included (default 10 minutes; T9). */
  readonly timeoutMs?: number;
  /** Most bytes read from one response (default 16 MiB; T9). */
  readonly maxResponseBytes?: number;
  /** Delimiter ids for untrusted content (default: 96 random bits). */
  readonly nonce?: () => string;
  /** Bedrock: replaces the AWS default credential chain. */
  readonly bedrockCredentials?: BedrockMantleClientOptions["providerChainResolver"];
  /** Vertex: replaces Google application default credentials (a google-auth-library client). */
  readonly vertexAuth?: () => Promise<VertexAuthSource>;
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
/** A hostile or broken server cannot make the worker buffer more than this (T9). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_RETRIES = 2;

const silent = () => undefined;
/** A logger that drops everything: the SDK never logs request bodies, headers or model output. */
const SILENT_LOGGER = { error: silent, warn: silent, info: silent, debug: silent };

/**
 * Options every Claude SDK client gets (threats T1–T3). Each one is set explicitly so the
 * environment cannot change it: `ANTHROPIC_LOG` cannot turn on logging, OpenTelemetry content
 * capture cannot copy prompts into traces, and no redirect can carry `x-api-key` to another host.
 */
export const hardenedClientOptions = (
  transport: AdapterTransport,
  fetch: typeof globalThis.fetch,
) =>
  ({
    logLevel: "off",
    logger: SILENT_LOGGER,
    openTelemetry: false,
    fetchOptions: { redirect: "error" },
    maxRetries: transport.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeout: transport.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch,
  }) satisfies Partial<ClientOptions>;

/** Set when a response went past the byte cap, so the caller can tell it from a dropped link. */
export interface ByteBudget {
  exceeded: boolean;
}

/**
 * `fetch` whose response bodies stop after `cap` bytes (T9). The SDK reads error bodies and event
 * streams through it, so neither can grow without bound; past the cap the body errors and
 * `budget.exceeded` is set.
 */
export const cappedFetch =
  (base: typeof globalThis.fetch, cap: number, budget: ByteBudget): typeof globalThis.fetch =>
  async (input, init) => {
    const response = await base(input, init);
    const source = response.body;
    if (source === null) return response;
    const reader = source.getReader();
    let seen = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        seen += value.byteLength;
        if (seen > cap) {
          budget.exceeded = true;
          controller.error(new LlmCallError("server_error"));
          await reader.cancel().catch(() => undefined);
          return;
        }
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

export const nonceSource = (transport: AdapterTransport): (() => string) =>
  transport.nonce ?? newNonce;
