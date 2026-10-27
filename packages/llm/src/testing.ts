import type {
  LlmProvider,
  ProviderCompletionCall,
  ProviderEmbeddingCall,
  StructuredCompletionResult,
} from "@rocky-reviews/core";
import type { ProviderSettings } from "./config.js";
import { PROVIDER_CAPABILITIES, PROVIDER_KINDS, type ProviderKind } from "./providers.js";
import type { ProviderAdapters, SecretSource } from "./registry.js";

/**
 * Test adapters for every provider kind (P4-1). They record what the registry sends them and
 * answer with a fixed, schema-valid document; no network, no SDK. Real adapters: P4-2.
 */

export interface RecordedCompletion extends ProviderCompletionCall<unknown> {
  readonly kind: ProviderKind;
}
export interface RecordedEmbedding extends ProviderEmbeddingCall {
  readonly kind: ProviderKind;
}

export interface RecordingAdapters {
  readonly factories: ProviderAdapters;
  readonly created: { kind: ProviderKind; settings: ProviderSettings }[];
  readonly calls: RecordedCompletion[];
  readonly embedCalls: RecordedEmbedding[];
  /** Names of secrets the adapters looked up (values are never recorded). */
  readonly secretsRead: string[];
}

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
};

export const recordingAdapters = (answer: unknown = { verdict: "comment" }): RecordingAdapters => {
  const created: RecordingAdapters["created"] = [];
  const calls: RecordedCompletion[] = [];
  const embedCalls: RecordedEmbedding[] = [];
  const secretsRead: string[] = [];

  const factory =
    (kind: ProviderKind) =>
    (settings: ProviderSettings, secrets: SecretSource): LlmProvider => {
      created.push({ kind, settings });
      // Like a real adapter, read the key when it is needed, not when the adapter is built.
      const readKey = () => {
        if ("apiKeyEnv" in settings && settings.apiKeyEnv !== undefined) {
          secretsRead.push(settings.apiKeyEnv);
          secrets.get(settings.apiKeyEnv);
        }
      };
      const provider: LlmProvider = {
        completeStructured: <T>(
          call: ProviderCompletionCall<T>,
        ): Promise<StructuredCompletionResult<T>> => {
          readKey();
          calls.push({ ...(call as ProviderCompletionCall<unknown>), kind });
          const parsed = call.output.parse(answer);
          return Promise.resolve(
            parsed.success
              ? { status: "ok", value: parsed.data, model: call.model, usage }
              : { status: "invalid_output", model: call.model, usage },
          );
        },
      };
      if (PROVIDER_CAPABILITIES[kind].embeddings) {
        provider.embed = (call) => {
          embedCalls.push({ ...call, kind });
          return Promise.resolve({
            vectors: call.inputs.map(() => Array.from({ length: call.dimensions }, () => 0)),
            model: call.model,
            usage: { inputTokens: call.inputs.length },
          });
        };
      }
      return provider;
    };

  const factories = Object.fromEntries(
    PROVIDER_KINDS.map((kind) => [kind, factory(kind)]),
  ) as ProviderAdapters;
  return { factories, created, calls, embedCalls, secretsRead };
};
