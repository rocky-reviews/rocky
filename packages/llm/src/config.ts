import {
  LLM_COMPLETION_ROLES,
  LLM_EFFORTS,
  isLlmEffort,
  type LlmCompletionRole,
  type LlmEffort,
} from "@rocky-reviews/core";
import { scrubSecrets } from "@rocky-reviews/log";
import { z } from "zod";
import {
  effortsFor,
  isProviderKind,
  PROVIDER_CAPABILITIES,
  PROVIDER_KINDS,
  type ProviderKind,
} from "./providers.js";

/**
 * Role config (P4-1, ADR 0012): which provider, model and effort serve each role, and the
 * non-secret settings of each provider. Credentials are referenced by environment variable
 * *name* (`apiKeyEnv`) and resolved by the adapter at call time, so this object is safe to log.
 *
 * Messages never contain a configured value: only paths, Rocky's own vocabulary (kinds, efforts,
 * catalogue model ids) and fixed text. A key pasted into the wrong field is refused, not echoed.
 */

export interface AnthropicSettings {
  readonly kind: "anthropic";
  readonly apiKeyEnv: string;
  readonly baseUrl?: string;
}
export interface BedrockSettings {
  readonly kind: "bedrock";
  /** Credentials come from the AWS default chain (env, profile, instance role). */
  readonly region: string;
}
export interface VertexSettings {
  readonly kind: "vertex";
  /** Credentials come from Google application default credentials. */
  readonly projectId: string;
  readonly region: string;
}
export interface FoundrySettings {
  readonly kind: "foundry";
  readonly resource: string;
  readonly apiKeyEnv: string;
}
export interface OpenAiCompatibleSettings {
  readonly kind: "openai-compatible";
  readonly baseUrl: string;
  /** Optional: local servers often need no key. */
  readonly apiKeyEnv?: string;
}
export type ProviderSettings =
  AnthropicSettings | BedrockSettings | VertexSettings | FoundrySettings | OpenAiCompatibleSettings;
export type ProviderSettingsOf<K extends ProviderKind> = Extract<ProviderSettings, { kind: K }>;
export type ProviderSettingsByKind = { readonly [K in ProviderKind]?: ProviderSettingsOf<K> };

export interface CompletionRoleConfig {
  readonly provider: ProviderKind;
  readonly model: string;
  /** Omitted: the provider's own default for the model. */
  readonly effort?: LlmEffort;
}
export interface EmbeddingRoleConfig {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly dimensions: number;
}
export type LlmRoleConfigs = { readonly [R in LlmCompletionRole]: CompletionRoleConfig } & {
  /** Null: embeddings are off, and the features that need them stay unavailable. */
  readonly embed: EmbeddingRoleConfig | null;
};
export interface LlmConfig {
  readonly providers: ProviderSettingsByKind;
  readonly roles: LlmRoleConfigs;
}

export interface LlmConfigIssue {
  /** Where the problem is: a config path, or the environment variable it came from. */
  readonly path: string;
  readonly message: string;
}

export class LlmConfigError extends Error {
  override readonly name = "LlmConfigError";
  readonly issues: readonly LlmConfigIssue[];
  constructor(issues: readonly LlmConfigIssue[]) {
    super(
      `invalid LLM config: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
    this.issues = issues;
  }
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const REGION = /^[a-z0-9]{1,30}(?:-[a-z0-9]{1,30}){0,4}$/;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const SAFE_KEY = /^[a-z][A-Za-z0-9]{0,23}(?:-[a-z0-9]{1,16})?$/;
export const MAX_EMBEDDING_DIMENSIONS = 16_000;

const isBlank = (value: string) => value.trim() === "";

const matching = (pattern: RegExp, message: string) =>
  z.string().superRefine((value, ctx) => {
    if (isBlank(value)) ctx.addIssue({ code: "custom", message: "must not be blank" });
    else if (!pattern.test(value)) ctx.addIssue({ code: "custom", message });
  });

const envName = matching(ENV_NAME, "must name an environment variable (A-Z, 0-9, _)");
const region = matching(REGION, "must be a region name such as us-east-1");
const resourceName = matching(RESOURCE_NAME, "must be a resource name (letters, digits, -)");

const baseUrl = z.string().superRefine((raw, ctx) => {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
    ctx.addIssue({ code: "custom", message: "must be an http(s) URL" });
  } else if (
    url.username !== "" ||
    url.password !== "" ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("@")
  ) {
    ctx.addIssue({ code: "custom", message: "must not carry credentials, a query or a fragment" });
  }
});

const providerSettings = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("anthropic"),
    apiKeyEnv: envName,
    baseUrl: baseUrl.optional(),
  }),
  z.strictObject({ kind: z.literal("bedrock"), region }),
  z.strictObject({ kind: z.literal("vertex"), projectId: resourceName, region }),
  z.strictObject({ kind: z.literal("foundry"), resource: resourceName, apiKeyEnv: envName }),
  z.strictObject({
    kind: z.literal("openai-compatible"),
    baseUrl,
    apiKeyEnv: envName.optional(),
  }),
]);

const completionRole = z.strictObject({
  provider: z.enum(PROVIDER_KINDS),
  model: z.string(),
  effort: z.enum(LLM_EFFORTS).optional(),
});

const dimensions = z
  .number({
    error: (issue) =>
      issue.input === undefined
        ? "required"
        : `must be a whole number from 1 to ${MAX_EMBEDDING_DIMENSIONS}`,
  })
  .int({ error: `must be a whole number from 1 to ${MAX_EMBEDDING_DIMENSIONS}` })
  .min(1, { error: `must be a whole number from 1 to ${MAX_EMBEDDING_DIMENSIONS}` })
  .max(MAX_EMBEDDING_DIMENSIONS, {
    error: `must be a whole number from 1 to ${MAX_EMBEDDING_DIMENSIONS}`,
  });

const embedRole = z
  .strictObject({ provider: z.enum(PROVIDER_KINDS), model: z.string(), dimensions })
  .nullable();

const configSchema = z.strictObject({
  providers: z.strictObject(
    Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, providerSettings.optional()])),
  ),
  roles: z.strictObject({
    triage: completionRole,
    review: completionRole,
    graph: completionRole,
    ask: completionRole,
    embed: embedRole,
  }),
});

/** Zod messages in Rocky's words, built without ever reading the offending input. */
const errorMap = (issue: z.core.$ZodRawIssue): string => {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined) return "required";
      return issue.expected === "object" ? "must be an object" : `must be a ${issue.expected}`;
    case "invalid_value":
      return issue.values.length === 1
        ? `must be ${String(issue.values[0])}`
        : `must be one of ${issue.values.map(String).join(", ")}`;
    case "unrecognized_keys": {
      const keys = issue.keys;
      return keys.every((key) => SAFE_KEY.test(key))
        ? `unknown key ${keys.join(", ")}`
        : "unknown key";
    }
    case "invalid_union":
      return `kind must be one of ${PROVIDER_KINDS.join(", ")}`;
    default:
      return "invalid";
  }
};

export type PathLabel = (path: string) => string;

const formatPath = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? "(root)" : path.map(String).join(".");

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Checks that depend on more than one field: model against the provider's catalogue, effort
 * against the model, embeddings against the provider. Run on the raw input, guarded, so a
 * structural problem in one role does not hide a semantic one in another.
 */
const semanticIssues = (input: unknown): LlmConfigIssue[] => {
  const issues: LlmConfigIssue[] = [];
  const root = record(input);
  const providers = record(root?.["providers"]);
  const roles = record(root?.["roles"]);

  for (const [key, value] of Object.entries(providers ?? {})) {
    const kind = record(value)?.["kind"];
    if (isProviderKind(key) && isProviderKind(kind) && kind !== key) {
      issues.push({ path: `providers.${key}.kind`, message: `must be ${key}` });
    }
  }

  // A credential pasted into any field (a resource name, a model id) is refused outright, so it
  // can never reach a config dump, a hostname or a request.
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (scrubSecrets(value) !== value) {
        issues.push({
          path,
          message: "looks like a credential: name the variable that holds it instead",
        });
      }
      return;
    }
    for (const [key, child] of Object.entries(record(value) ?? {})) {
      walk(child, SAFE_KEY.test(key) ? `${path}.${key}` : path);
    }
  };
  walk(providers, "providers");
  walk(roles, "roles");

  const checkModel = (path: string, kind: ProviderKind, model: string): boolean => {
    const catalogue = PROVIDER_CAPABILITIES[kind].models;
    if (isBlank(model)) {
      issues.push({ path: `${path}.model`, message: "must not be blank" });
      return false;
    }
    if (catalogue !== undefined && !catalogue.has(model)) {
      issues.push({
        path: `${path}.model`,
        message: `unknown model for provider ${kind} (known: ${[...catalogue.keys()].join(", ")})`,
      });
      return false;
    }
    if (catalogue === undefined && !MODEL_ID.test(model)) {
      issues.push({
        path: `${path}.model`,
        message: "must be a model id without spaces (at most 200 characters)",
      });
      return false;
    }
    return true;
  };

  const checkRole = (name: string, capability: "completions" | "embeddings") => {
    const role = record(roles?.[name]);
    const kind = role?.["provider"];
    if (role === undefined || !isProviderKind(kind)) return;
    const path = `roles.${name}`;
    if (!PROVIDER_CAPABILITIES[kind][capability]) {
      issues.push({ path: `${path}.provider`, message: `provider ${kind} has no ${capability}` });
      return;
    }
    if (providers !== undefined && providers[kind] === undefined) {
      issues.push({ path: `${path}.provider`, message: `provider ${kind} is not configured` });
    }
    const model = role["model"];
    if (typeof model !== "string" || !checkModel(path, kind, model)) return;
    const effort = role["effort"];
    if (!isLlmEffort(effort)) return;
    const supported = effortsFor(kind, model);
    const byModel = PROVIDER_CAPABILITIES[kind].models !== undefined;
    if (supported.length === 0) {
      issues.push({ path: `${path}.effort`, message: `model ${model} takes no effort setting` });
    } else if (!supported.includes(effort)) {
      issues.push({
        path: `${path}.effort`,
        message: `effort ${effort} is not supported by ${byModel ? `model ${model}` : `provider ${kind}`} (supported: ${supported.join(", ")})`,
      });
    }
  };

  for (const name of LLM_COMPLETION_ROLES) checkRole(name, "completions");
  checkRole("embed", "embeddings");
  return issues;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const validated = new WeakSet<object>();

/** True only for a config returned by `parseLlmConfig` / `llmConfigFromEnv`. */
export const isValidatedLlmConfig = (config: unknown): config is LlmConfig =>
  typeof config === "object" && config !== null && validated.has(config);

export type LlmConfigCheck =
  | { readonly ok: true; readonly config: LlmConfig }
  | { readonly ok: false; readonly issues: LlmConfigIssue[] };

/** `parseLlmConfig` without the throw, for loaders that add issues of their own. */
export const checkLlmConfig = (
  input: unknown,
  label: PathLabel = (path) => path,
): LlmConfigCheck => {
  const parsed = configSchema.safeParse(input, { error: errorMap });
  const issues: LlmConfigIssue[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => {
        const path = formatPath(issue.path);
        const message =
          path === "roles.embed" && issue.message === "required"
            ? "required (null disables embeddings)"
            : issue.message;
        return { path, message };
      });
  issues.push(...semanticIssues(input));
  if (!parsed.success || issues.length > 0) {
    return { ok: false, issues: issues.map((issue) => ({ ...issue, path: label(issue.path) })) };
  }
  const config = deepFreeze(parsed.data as unknown as LlmConfig);
  validated.add(config);
  return { ok: true, config };
};

/** Validates a role config from any source (env, a file, a test). Throws `LlmConfigError`. */
export const parseLlmConfig = (input: unknown, label?: PathLabel): LlmConfig => {
  const result = checkLlmConfig(input, label);
  if (!result.ok) throw new LlmConfigError(result.issues);
  return result.config;
};
