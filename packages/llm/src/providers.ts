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
export const CLAUDE_MODELS: ReadonlyMap<string, ModelCapabilities> = new Map([
  ["claude-fable-5-1", { efforts: LLM_EFFORTS }],
  ["claude-opus-5-5", { efforts: LLM_EFFORTS }],
  ["claude-sonnet-5-5", { efforts: LLM_EFFORTS }],
  ["claude-haiku-5-5", { efforts: LLM_EFFORTS }],
  // Older Haiku, kept for self-hosters pinned to it: the API rejects an effort setting.
  ["claude-haiku-4-5", { efforts: [] }],
]);

export interface ProviderCapabilities {
  readonly completions: boolean;
  readonly embeddings: boolean;
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
  bedrock: claudePlatform,
  vertex: claudePlatform,
  foundry: claudePlatform,
  // OpenAI-compatible servers (Ollama, vLLM) take `reasoning_effort` on the levels that scale has.
  "openai-compatible": {
    completions: true,
    embeddings: true,
    models: undefined,
    efforts: ["low", "medium", "high"],
  },
};

export const isProviderKind = (value: unknown): value is ProviderKind =>
  typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);

/** Efforts a model on a provider accepts (the model's own list when the provider has a catalogue). */
export const effortsFor = (kind: ProviderKind, model: string): readonly LlmEffort[] => {
  const capabilities = PROVIDER_CAPABILITIES[kind];
  return capabilities.models?.get(model)?.efforts ?? capabilities.efforts;
};
