/**
 * LLM port (P4-1, ADR 0012). The pipeline asks a *role* for a structured completion or for
 * embeddings; which provider, model and effort serve that role is configuration, resolved in
 * `packages/llm`. Nothing here names a vendor SDK, and nothing here carries a credential.
 */

/** Roles that return one schema-validated JSON document (ADR 0004). */
export const LLM_COMPLETION_ROLES = ["triage", "review", "graph", "ask"] as const;
export type LlmCompletionRole = (typeof LLM_COMPLETION_ROLES)[number];

export const LLM_ROLES = [...LLM_COMPLETION_ROLES, "embed"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/**
 * Provider-neutral effort scale, lowest to highest. Each provider adapter maps a level to its
 * own parameters (P4-2); config validation rejects a level the provider or model lacks.
 */
export const LLM_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type LlmEffort = (typeof LLM_EFFORTS)[number];

export const isLlmRole = (value: unknown): value is LlmRole =>
  typeof value === "string" && (LLM_ROLES as readonly string[]).includes(value);

export const isLlmEffort = (value: unknown): value is LlmEffort =>
  typeof value === "string" && (LLM_EFFORTS as readonly string[]).includes(value);

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
}

export type LlmParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: readonly string[] };

/** The output contract: a JSON Schema for the provider and a validator for the result. */
export interface LlmOutputSchema<T> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown): LlmParseResult<T>;
}

/** PR content (code, titles, comments). Always untrusted; adapters delimit it (P4-4). */
export interface LlmUntrustedText {
  readonly label: string;
  readonly text: string;
}

export interface StructuredCompletionRequest<T> {
  /** Rocky-authored instructions. Never contains PR content. */
  readonly instructions: string;
  readonly untrusted: readonly LlmUntrustedText[];
  readonly output: LlmOutputSchema<T>;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

/** No side effects either way: a result is data for a human to accept or dismiss. */
export type StructuredCompletionResult<T> =
  | {
      readonly status: "ok";
      readonly value: T;
      readonly model: string;
      readonly usage: LlmUsage;
    }
  | {
      readonly status: "refused" | "truncated" | "invalid_output";
      readonly model: string;
      readonly usage: LlmUsage;
    };

export interface EmbeddingRequest {
  readonly inputs: readonly string[];
  readonly signal?: AbortSignal;
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly model: string;
  readonly usage: { readonly inputTokens: number };
}

/** What the registry hands a provider: the request plus the role's configured target. */
export interface ProviderCompletionCall<T> extends StructuredCompletionRequest<T> {
  readonly role: LlmCompletionRole;
  readonly model: string;
  /** Undefined: the provider's own default for the model. */
  readonly effort: LlmEffort | undefined;
}

export interface ProviderEmbeddingCall extends EmbeddingRequest {
  readonly model: string;
  readonly dimensions: number;
}

/**
 * A provider adapter (Anthropic, Bedrock, Vertex, Foundry, OpenAI-compatible; P4-2). An adapter
 * implements what its platform supports; the registry refuses a role whose provider lacks it.
 */
export interface LlmProvider {
  completeStructured?<T>(call: ProviderCompletionCall<T>): Promise<StructuredCompletionResult<T>>;
  embed?(call: ProviderEmbeddingCall): Promise<EmbeddingResult>;
}

/** A completion role as the pipeline sees it: no provider, model or effort in sight. */
export interface CompletionRoleClient {
  readonly role: LlmCompletionRole;
  complete<T>(request: StructuredCompletionRequest<T>): Promise<StructuredCompletionResult<T>>;
}

export interface EmbeddingRoleClient {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export interface LlmRoles {
  completion(role: LlmCompletionRole): CompletionRoleClient;
  /** Undefined when no embedding provider is configured (features that need it stay off). */
  embedding(): EmbeddingRoleClient | undefined;
}
