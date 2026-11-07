import { LLM_EFFORTS, type LlmEffort } from "@rocky-reviews/core";

/**
 * Provider kinds and what each can do (P4-1, ADR 0012). Config validation reads this table; the
 * adapters themselves arrive in P4-2. Adding a provider means a row here plus an adapter, never a
 * change to a role or to the pipeline.
 */

export const PROVIDER_KINDS = [
  "anthropic",
  "bedrock",
  "vertex",
  "foundry",
  "openai-compatible",
  // Hosted embedding providers (P9-1, ADR 0040 §1): embeddings only.
  "openai",
  "voyage",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ModelCapabilities {
  /** Effort levels the model accepts; empty means the model takes no effort setting. */
  readonly efforts: readonly LlmEffort[];
}

/**
 * Claude models Rocky accepts, by canonical Claude API id. The platform adapter turns the id into
 * its platform's form (Bedrock prefixes `anthropic.`; Vertex uses the bare id) in P4-2.
 * Source: Anthropic's model table and effort reference (claude-api skill, cached 2026-10-06).
 */
const NO_XHIGH: readonly LlmEffort[] = ["low", "medium", "high", "max"];
const UP_TO_HIGH: readonly LlmEffort[] = ["low", "medium", "high"];

export const CLAUDE_MODELS: ReadonlyMap<string, ModelCapabilities> = new Map([
  ["claude-fable-5-1", { efforts: LLM_EFFORTS }],
  ["claude-fable-5", { efforts: LLM_EFFORTS }],
  ["claude-opus-5-5", { efforts: LLM_EFFORTS }],
  ["claude-opus-5", { efforts: LLM_EFFORTS }],
  ["claude-opus-4-8", { efforts: LLM_EFFORTS }],
  ["claude-opus-4-7", { efforts: LLM_EFFORTS }],
  // `xhigh` arrived with Opus 4.7.
  ["claude-opus-4-6", { efforts: NO_XHIGH }],
  ["claude-opus-4-5", { efforts: UP_TO_HIGH }],
  ["claude-sonnet-5-5", { efforts: LLM_EFFORTS }],
  ["claude-sonnet-5", { efforts: LLM_EFFORTS }],
  ["claude-sonnet-4-6", { efforts: NO_XHIGH }],
  ["claude-haiku-5-5", { efforts: LLM_EFFORTS }],
  // The API rejects an effort setting on Haiku 4.5.
  ["claude-haiku-4-5", { efforts: [] }],
]);

/**
 * Claude on Amazon Bedrock serves the Messages API (Mantle, the adapter's client) for Opus 4.7 and
 * later and Haiku 4.5. Opus 4.6, Opus 4.5 and Sonnet 4.6 exist only on the legacy InvokeModel
 * integration, so config refuses them on Bedrock (P4-2, ADR 0013 §1; source: Claude in Amazon
 * Bedrock, supported models, read 2026-10-27).
 */
const BEDROCK_LEGACY_ONLY = new Set(["claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-4-6"]);
export const BEDROCK_MODELS: ReadonlyMap<string, ModelCapabilities> = new Map(
  [...CLAUDE_MODELS].filter(([model]) => !BEDROCK_LEGACY_ONLY.has(model)),
);

/**
 * An embedding model a hosted provider serves (P9-1, ADR 0040 §1): the widths it can return.
 * `widths` lists the only accepted widths; without it, any width from 1 to `maxDimensions` (the
 * provider shortens the vector, as OpenAI's `dimensions` does).
 */
export interface EmbeddingModelCapabilities {
  readonly maxDimensions: number;
  readonly widths?: readonly number[];
}

/**
 * OpenAI's current embedding models; `text-embedding-ada-002` is left out (a fixed 1536 wide,
 * over the index width). Source: OpenAI embeddings guide ("dimensions" parameter), as known
 * 2026-11-06; re-check before a live run.
 */
export const OPENAI_EMBEDDING_MODELS: ReadonlyMap<string, EmbeddingModelCapabilities> = new Map([
  ["text-embedding-3-small", { maxDimensions: 1536 }],
  ["text-embedding-3-large", { maxDimensions: 3072 }],
]);

const VOYAGE_WIDTHS = [256, 512, 1024, 2048] as const;
/**
 * Voyage AI models that take `output_dimension` (256, 512, 1024, 2048). Source: Voyage AI
 * embeddings docs, as known 2026-11-06; re-check before a live run.
 */
export const VOYAGE_EMBEDDING_MODELS: ReadonlyMap<string, EmbeddingModelCapabilities> = new Map(
  ["voyage-code-3", "voyage-3.5", "voyage-3.5-lite", "voyage-3-large"].map((model) => [
    model,
    { maxDimensions: 2048, widths: VOYAGE_WIDTHS },
  ]),
);

export interface ProviderCapabilities {
  readonly completions: boolean;
  readonly embeddings: boolean;
  /** Accepted embedding models; undefined means any well-formed id. */
  readonly embeddingModels?: ReadonlyMap<string, EmbeddingModelCapabilities>;
  /** Accepted models; undefined means any well-formed id (local servers serve what they load). */
  readonly models: ReadonlyMap<string, ModelCapabilities> | undefined;
  /** Effort levels for models outside a catalogue. */
  readonly efforts: readonly LlmEffort[];
}

const claudePlatform: ProviderCapabilities = {
  completions: true,
  // Anthropic has no embeddings endpoint, on any of its platforms.
  embeddings: false,
  models: CLAUDE_MODELS,
  efforts: LLM_EFFORTS,
};

export const PROVIDER_CAPABILITIES: Readonly<Record<ProviderKind, ProviderCapabilities>> = {
  anthropic: claudePlatform,
  bedrock: { ...claudePlatform, models: BEDROCK_MODELS },
  vertex: claudePlatform,
  foundry: claudePlatform,
  // OpenAI-compatible servers (Ollama, vLLM) take `reasoning_effort` on the levels that scale has.
  "openai-compatible": {
    completions: true,
    embeddings: true,
    models: undefined,
    efforts: ["low", "medium", "high"],
  },
  openai: {
    completions: false,
    embeddings: true,
    embeddingModels: OPENAI_EMBEDDING_MODELS,
    models: undefined,
    efforts: [],
  },
  voyage: {
    completions: false,
    embeddings: true,
    embeddingModels: VOYAGE_EMBEDDING_MODELS,
    models: undefined,
    efforts: [],
  },
};

export const isProviderKind = (value: unknown): value is ProviderKind =>
  typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);

/** Efforts a model on a provider accepts (the model's own list when the provider has a catalogue). */
export const effortsFor = (kind: ProviderKind, model: string): readonly LlmEffort[] => {
  const capabilities = PROVIDER_CAPABILITIES[kind];
  return capabilities.models?.get(model)?.efforts ?? capabilities.efforts;
};
