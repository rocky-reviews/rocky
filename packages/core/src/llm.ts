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

/**
 * Token usage as the provider reports it. Cache writes are split by lifetime because they are
 * priced differently; Anthropic reports them as `usage.cache_creation.ephemeral_5m_input_tokens`
 * and `ephemeral_1h_input_tokens`. Providers without a cache report zeros.
 */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWrite5mInputTokens: number;
  readonly cacheWrite1hInputTokens: number;
}

/**
 * `issues` are built from schema paths and issue codes only (e.g. `findings.0.line: too_small`),
 * never from values: they reach logs and the repair round (ADR 0004).
 */
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

declare const rockyAuthored: unique symbol;

/**
 * Instructions Rocky wrote (P4-2 review round 1, N4; ADR 0012 §1). Only `rockyInstructions` and
 * `joinInstructions` issue one, so a PR title or diff cannot become a system prompt by accident:
 * PR content goes in `untrusted`, where adapters delimit it. P4-4 builds the full defence.
 */
export interface RockyInstructions {
  readonly text: string;
  readonly [rockyAuthored]: true;
}

const issued = new WeakSet<object>();

const issue = (text: string): RockyInstructions => {
  const instructions = Object.freeze({ text }) as RockyInstructions;
  issued.add(instructions);
  return instructions;
};

/** A literal-only tagged template: `rockyInstructions\`You review pull requests.\``. */
export const rockyInstructions = (strings: TemplateStringsArray): RockyInstructions => {
  // A template literal passes a frozen array with a frozen `raw`; anything else is a direct call.
  const raw: unknown = Array.isArray(strings) ? (strings as { raw?: unknown }).raw : undefined;
  const literal =
    Array.isArray(strings) &&
    Array.isArray(raw) &&
    Object.isFrozen(strings) &&
    Object.isFrozen(raw) &&
    strings.length === 1 &&
    raw.length === 1 &&
    typeof strings[0] === "string" &&
    typeof raw[0] === "string" &&
    // Without escapes, the cooked text is the raw text.
    (raw[0].includes("\\") || raw[0] === strings[0]);
  if (!literal)
    throw new TypeError("rockyInstructions takes one literal template, no substitutions");
  return issue(strings[0] as string);
};

export const isRockyInstructions = (value: unknown): value is RockyInstructions =>
  typeof value === "object" && value !== null && issued.has(value);

/** Rocky pieces joined by a blank line; any other part is refused. */
export const joinInstructions = (parts: readonly RockyInstructions[]): RockyInstructions => {
  if (!parts.every(isRockyInstructions)) throw new TypeError("not Rocky-authored instructions");
  return issue(parts.map((part) => part.text).join("\n\n"));
};

export interface StructuredCompletionRequest<T> {
  /** Rocky-authored instructions; never PR content (that goes in `untrusted`). */
  readonly instructions: RockyInstructions;
  readonly untrusted: readonly LlmUntrustedText[];
  readonly output: LlmOutputSchema<T>;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

/** One attempt the provider reported for a call it ran on more than one model (P4-2, ADR 0013). */
export interface LlmAttemptUsage {
  readonly model: string;
  readonly usage: LlmUsage;
}

interface ProviderResultBase {
  /** The model that produced the answer (a refusal fallback may have switched it). */
  readonly model: string;
  /** Usage of the attempt that produced the answer. */
  readonly usage: LlmUsage;
  /**
   * Every attempt the provider reported, in order, when a server-side refusal fallback re-ran the
   * call on another model; absent otherwise. Reported is not billed at list price: a decline
   * before any output and the fallback's cache repricing follow the provider's refusal billing
   * rules, so metering (P4-5) prices these by those rules rather than summing them.
   */
  readonly attempts?: readonly LlmAttemptUsage[];
}

/**
 * What an adapter returns. No side effects either way: a result is data for a human to accept or
 * dismiss. `truncated`: generation stopped at the output cap or the context window mid-answer.
 * An input that cannot fit at all is thrown as `LlmCallError("context_too_long")` instead.
 */
export type ProviderCompletionResult<T> =
  | (ProviderResultBase & { readonly status: "ok"; readonly value: T })
  | (ProviderResultBase & { readonly status: "refused" | "truncated" })
  | (ProviderResultBase & {
      readonly status: "invalid_output";
      /** Schema paths and issue codes only (see `LlmParseResult`). */
      readonly issues?: readonly string[];
    });

/** What a role returns: the adapter's result, stamped by the registry with the provider kind. */
export type StructuredCompletionResult<T> = ProviderCompletionResult<T> & {
  readonly provider: string;
};

export interface EmbeddingRequest {
  readonly inputs: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ProviderEmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly model: string;
  readonly usage: { readonly inputTokens: number };
}

export interface EmbeddingResult extends ProviderEmbeddingResult {
  readonly provider: string;
}

/** What the registry hands a provider: the request plus the role's configured target. */
export interface ProviderCompletionCall<T> extends StructuredCompletionRequest<T> {
  readonly role: LlmCompletionRole;
  /** Canonical model id: the capability key (catalogue, effort). */
  readonly model: string;
  /**
   * The literal model string to send, when the operator set one (a Bedrock inference profile or
   * ARN, a Vertex dated id, a Foundry deployment). Undefined: the adapter derives it from `model`.
   */
  readonly platformModel: string | undefined;
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
  // Failures are thrown as `LlmCallError`, never as an SDK error carrying a provider body.
  completeStructured?<T>(call: ProviderCompletionCall<T>): Promise<ProviderCompletionResult<T>>;
  embed?(call: ProviderEmbeddingCall): Promise<ProviderEmbeddingResult>;
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

/**
 * Call failures (review round 1, S4). Adapters map their platform's errors to one kind (P4-2):
 * HTTP 429 → rate_limited, 529 → overloaded, 5xx → server_error, 401 → auth, 403 → permission,
 * 402 → billing, 400 → invalid_request (or context_too_long when the input does not fit),
 * 404 → model_not_found, 413 → request_too_large; timeouts, connection failures and aborts map to
 * timeout, network and cancelled. The message is fixed per kind: no provider body, prompt or
 * output, and no `cause`, ever.
 */
export const LLM_RETRYABLE_ERROR_KINDS = [
  "rate_limited",
  "overloaded",
  "server_error",
  "timeout",
  "network",
] as const;
export const LLM_FATAL_ERROR_KINDS = [
  "auth",
  "permission",
  "billing",
  "invalid_request",
  "model_not_found",
  "request_too_large",
  "context_too_long",
  "cancelled",
] as const;
export const LLM_ERROR_KINDS = [...LLM_RETRYABLE_ERROR_KINDS, ...LLM_FATAL_ERROR_KINDS] as const;
export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

const ERROR_MESSAGES: Readonly<Record<LlmErrorKind, string>> = {
  rate_limited: "the provider rate-limited the request",
  overloaded: "the provider is overloaded",
  server_error: "the provider failed to answer",
  timeout: "the request timed out",
  network: "the provider could not be reached",
  auth: "the provider rejected the credentials",
  permission: "the credentials may not use this model or operation",
  billing: "the provider account has a billing problem",
  invalid_request: "the provider rejected the request as invalid",
  model_not_found: "the model is not available to these credentials",
  request_too_large: "the request is larger than the provider accepts",
  context_too_long: "the input does not fit the model's context window",
  cancelled: "the request was cancelled",
};

export const isLlmErrorKind = (value: unknown): value is LlmErrorKind =>
  typeof value === "string" && (LLM_ERROR_KINDS as readonly string[]).includes(value);

export class LlmCallError extends Error {
  override readonly name = "LlmCallError";
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  /** A provider's retry-after hint, when it gave one. */
  readonly retryAfterMs: number | undefined;
  constructor(kind: LlmErrorKind, options: { readonly retryAfterMs?: number } = {}) {
    super(ERROR_MESSAGES[kind]);
    const { retryAfterMs } = options;
    if (retryAfterMs !== undefined && !(Number.isFinite(retryAfterMs) && retryAfterMs >= 0)) {
      throw new RangeError("retryAfterMs must be a finite, non-negative number");
    }
    this.kind = kind;
    this.retryable = (LLM_RETRYABLE_ERROR_KINDS as readonly string[]).includes(kind);
    this.retryAfterMs = retryAfterMs;
  }
}

export const isLlmCallError = (value: unknown): value is LlmCallError =>
  value instanceof LlmCallError;

export const isRetryableLlmError = (value: unknown): boolean =>
  isLlmCallError(value) && value.retryable;
