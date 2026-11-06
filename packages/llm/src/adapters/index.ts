import type { ProviderAdapters } from "../registry.js";
import {
  anthropicAdapter,
  bedrockAdapter,
  foundryAdapter,
  vertexAdapter,
} from "./claude-platforms.js";
import { openAiAdapter, voyageAdapter } from "./embedding-providers.js";
import { openAiCompatibleAdapter } from "./openai-compatible.js";
import type { AdapterTransport } from "./transport.js";

/**
 * The provider adapters (P4-2, ADR 0013), as the factory map `createLlmRoles` takes. Production
 * passes no transport; tests inject `fetch` and platform credential sources.
 */
export const providerAdapters = (transport: AdapterTransport = {}): ProviderAdapters => ({
  anthropic: anthropicAdapter(transport),
  bedrock: bedrockAdapter(transport),
  vertex: vertexAdapter(transport),
  foundry: foundryAdapter(transport),
  "openai-compatible": openAiCompatibleAdapter(transport),
  openai: openAiAdapter(transport),
  voyage: voyageAdapter(transport),
});

export type { AdapterTransport, VertexAuthSource } from "./transport.js";
