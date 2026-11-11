import {
  LLM_COMPLETION_ROLES,
  LlmCallError,
  rockyInstructions,
  type LlmCompletionRole,
  type LlmErrorKind,
  type LlmOutputSchema,
  type LlmRole,
} from "@rocky-reviews/core";
import type { LlmConfig } from "./config.js";
import { createLlmRoles, type ProviderAdapters, type SecretSource } from "./registry.js";

/**
 * The setup wizard's provider test call (P10-2, ADR 0044): one minimal request per distinct
 * provider and model the roles use, through the same registry and adapters the worker uses, so a
 * wrong key, a withdrawn model or an unreachable endpoint shows up before the first pull request
 * does (ADR 0012, Consequences). The prompt is fixed Rocky text, no pull request content; the
 * output is capped at `PROBE_MAX_OUTPUT_TOKENS`, the embedding input is one short word. Results
 * carry the provider, the model, an outcome and a duration: never a prompt, an answer or a key.
 */

/** Small, but enough for a model that thinks before a one-field answer. */
export const PROBE_MAX_OUTPUT_TOKENS = 512;
/** Per call; the wizard waits for all of them. */
export const PROBE_TIMEOUT_MS = 60_000;

const PROBE_INSTRUCTIONS = rockyInstructions`This is a connectivity check from Rocky Reviews' setup. Answer with the JSON object {"ok": true} and nothing else.`;

const PROBE_OUTPUT: LlmOutputSchema<{ ok: boolean }> = {
  name: "setup_probe",
  jsonSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
  parse: (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
      ? { success: true, data: { ok: (value as { ok: boolean }).ok } }
      : { success: false, issues: ["ok: invalid_type"] },
};

/**
 * `ok`: a valid answer. `answered`: the provider accepted the key and the model and replied, but
 * not with the probe's document (cut off at the small cap, refused, or malformed): good enough to
 * know the configuration works. Otherwise the `LlmCallError` kind (`auth`, `model_not_found`,
 * `network`, …), or `failed` for anything else. `wrong_dimensions`: the embedding model answered
 * with vectors of another width than `dimensions` says.
 */
export type ProbeOutcome = "ok" | "answered" | "wrong_dimensions" | LlmErrorKind | "failed";

export interface ProbeResult {
  /** The roles this target serves (one call covers them all). */
  readonly roles: readonly LlmRole[];
  readonly provider: string;
  readonly model: string;
  readonly outcome: ProbeOutcome;
  readonly durationMs: number;
}

export interface ProbeOptions {
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface ProbeTarget {
  readonly roles: readonly LlmRole[];
  readonly provider: string;
  readonly model: string;
}

const outcomeOf = (error: unknown): ProbeOutcome =>
  error instanceof LlmCallError ? error.kind : "failed";

/** The completion roles grouped by what serves them: one test call per group. */
const completionGroups = (
  config: LlmConfig,
): { role: LlmCompletionRole; roles: LlmCompletionRole[] }[] => {
  const groups = new Map<string, { role: LlmCompletionRole; roles: LlmCompletionRole[] }>();
  for (const role of LLM_COMPLETION_ROLES) {
    const target = config.roles[role];
    const key = JSON.stringify([target.provider, target.model, target.platformModel ?? null]);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { role, roles: [role] });
    else existing.roles.push(role);
  }
  return [...groups.values()];
};

/** What `probeLlmConfig` would call, without calling anything (the wizard lists it first). */
export const probeTargets = (config: LlmConfig): ProbeTarget[] => [
  ...completionGroups(config).map(({ role, roles }) => ({
    roles,
    provider: config.roles[role].provider,
    model: config.roles[role].model,
  })),
  ...(config.roles.embed === null
    ? []
    : [
        {
          roles: ["embed"] as const,
          provider: config.roles.embed.provider,
          model: config.roles.embed.model,
        },
      ]),
];

/**
 * Runs the test calls one after the other (a local model serves one at a time). Throws only when
 * the configuration cannot build roles at all (`LlmConfigError`); every call failure is a result.
 */
export const probeLlmConfig = async (
  config: LlmConfig,
  adapters: ProviderAdapters,
  secrets: SecretSource,
  options: ProbeOptions = {},
): Promise<ProbeResult[]> => {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const roles = createLlmRoles(config, adapters, secrets);

  const results: ProbeResult[] = [];
  for (const { role, roles: served } of completionGroups(config)) {
    const target = config.roles[role];
    const started = now();
    let outcome: ProbeOutcome;
    try {
      const result = await roles.completion(role).complete({
        instructions: PROBE_INSTRUCTIONS,
        untrusted: [],
        output: PROBE_OUTPUT,
        maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      outcome = result.status === "ok" ? "ok" : "answered";
    } catch (error) {
      outcome = outcomeOf(error);
    }
    results.push({
      roles: served,
      provider: target.provider,
      model: target.model,
      outcome,
      durationMs: Math.max(0, now() - started),
    });
  }

  const embed = config.roles.embed;
  const embedding = roles.embedding();
  if (embed !== null && embedding !== undefined) {
    const started = now();
    let outcome: ProbeOutcome;
    try {
      const result = await embedding.embed({
        inputs: ["rocky"],
        purpose: "query",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const vector = result.vectors[0];
      outcome =
        vector !== undefined && vector.length === embed.dimensions ? "ok" : "wrong_dimensions";
    } catch (error) {
      outcome = outcomeOf(error);
    }
    results.push({
      roles: ["embed"],
      provider: embed.provider,
      model: embed.model,
      outcome,
      durationMs: Math.max(0, now() - started),
    });
  }
  return results;
};
