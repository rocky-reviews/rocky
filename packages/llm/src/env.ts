import { LLM_COMPLETION_ROLES, type LlmCompletionRole, type LlmEffort } from "@rocky-reviews/core";
import { checkLlmConfig, LlmConfigError, type LlmConfig, type LlmConfigIssue } from "./config.js";
import { effortsFor, isProviderKind, PROVIDER_CAPABILITIES, PROVIDER_KINDS } from "./providers.js";

/**
 * Role config from the environment (P4-1, ADR 0012; 12-factor, like the rest of Rocky's config).
 * Every key is documented in `.env.example`. With nothing set, every completion role runs on the
 * Anthropic API with the defaults below and embeddings are off.
 *
 * - `ROCKY_LLM_PROVIDER` moves every role to another provider; `ROCKY_LLM_<ROLE>_PROVIDER`,
 *   `_MODEL` and `_EFFORT` override one role (`<ROLE>` = TRIAGE, REVIEW, GRAPH, ASK).
 * - `ROCKY_LLM_EMBED_PROVIDER`, `_MODEL` and `_DIMENSIONS` turn embeddings on; there is no
 *   default embedding model.
 * - Provider settings: `ROCKY_LLM_<PROVIDER>_*` below. Keys are named, never given:
 *   `*_API_KEY_ENV` holds the *name* of the variable that holds the key.
 *
 * Empty variables count as unset. An unknown `ROCKY_LLM_*` variable is an error, so a typo
 * cannot silently leave a role on its default.
 */

type Env = Readonly<Record<string, string | undefined>>;

const PREFIX = "ROCKY_LLM_";

/** The plan's defaults (P4-1). Efforts are starting points for the evals (P4-7) to tune. */
export const DEFAULT_ROLE_TARGETS: Readonly<
  Record<LlmCompletionRole, { readonly model: string; readonly effort: LlmEffort }>
> = {
  triage: { model: "claude-haiku-5-5", effort: "low" },
  review: { model: "claude-opus-5-5", effort: "high" },
  graph: { model: "claude-sonnet-5-5", effort: "medium" },
  ask: { model: "claude-sonnet-5-5", effort: "medium" },
};

export const DEFAULT_PROVIDER = "anthropic";

/** Provider settings by variable suffix; `default` applies when the provider is in use. */
const PROVIDER_VARS = {
  anthropic: {
    prefix: "ANTHROPIC",
    fields: { API_KEY_ENV: "apiKeyEnv", BASE_URL: "baseUrl" },
    defaults: { apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
  bedrock: { prefix: "BEDROCK", fields: { REGION: "region" }, defaults: {} },
  vertex: {
    prefix: "VERTEX",
    fields: { PROJECT_ID: "projectId", REGION: "region" },
    defaults: {},
  },
  foundry: {
    prefix: "FOUNDRY",
    fields: { RESOURCE: "resource", API_KEY_ENV: "apiKeyEnv" },
    defaults: { apiKeyEnv: "ANTHROPIC_FOUNDRY_API_KEY" },
  },
  "openai-compatible": {
    prefix: "OPENAI",
    fields: { BASE_URL: "baseUrl", API_KEY_ENV: "apiKeyEnv" },
    defaults: {},
  },
} as const satisfies Record<
  (typeof PROVIDER_KINDS)[number],
  {
    prefix: string;
    fields: Record<string, string>;
    defaults: Record<string, string>;
  }
>;

const roleVar = (role: string, field: string) => `${PREFIX}${role.toUpperCase()}_${field}`;

const KNOWN_VARS = new Set<string>([
  `${PREFIX}PROVIDER`,
  ...LLM_COMPLETION_ROLES.flatMap((role) =>
    ["PROVIDER", "MODEL", "EFFORT"].map((field) => roleVar(role, field)),
  ),
  ...["PROVIDER", "MODEL", "DIMENSIONS"].map((field) => roleVar("embed", field)),
  ...Object.values(PROVIDER_VARS).flatMap(({ prefix, fields }) =>
    Object.keys(fields).map((suffix) => `${PREFIX}${prefix}_${suffix}`),
  ),
]);

const valueOf = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
};

/** Variable a config path came from, for messages that tell the operator what to fix. */
const labelFor =
  (env: Env) =>
  (path: string): string => {
    const [section, name, field] = path.split(".");
    if (section === "roles" && name !== undefined && field !== undefined) {
      const own = roleVar(name, field.toUpperCase());
      if (field === "provider" && valueOf(env, own) === undefined) {
        return valueOf(env, `${PREFIX}PROVIDER`) === undefined ? own : `${PREFIX}PROVIDER`;
      }
      return own;
    }
    if (section === "providers" && isProviderKind(name) && field !== undefined) {
      const vars = PROVIDER_VARS[name];
      const suffix = Object.entries(vars.fields).find(([, key]) => key === field)?.[0];
      if (suffix !== undefined) return `${PREFIX}${vars.prefix}_${suffix}`;
    }
    return path;
  };

const completionRole = (env: Env, role: LlmCompletionRole, provider: string) => {
  const model = valueOf(env, roleVar(role, "MODEL"));
  const effort = valueOf(env, roleVar(role, "EFFORT"));
  // Defaults name Claude models, so they apply only where a Claude catalogue does (or where the
  // provider is unknown and already an error, so one mistake is reported once).
  const claude = !isProviderKind(provider) || PROVIDER_CAPABILITIES[provider].models !== undefined;
  const target = DEFAULT_ROLE_TARGETS[role];
  const resolvedModel = model ?? (claude ? target.model : undefined);
  const defaultEffort =
    claude &&
    resolvedModel !== undefined &&
    (!isProviderKind(provider) || effortsFor(provider, resolvedModel).includes(target.effort))
      ? target.effort
      : undefined;
  const resolvedEffort = effort ?? defaultEffort;
  return {
    provider,
    model: resolvedModel,
    ...(resolvedEffort === undefined ? {} : { effort: resolvedEffort }),
  };
};

const embedRole = (env: Env, fallbackProvider: string) => {
  const provider = valueOf(env, roleVar("embed", "PROVIDER"));
  const model = valueOf(env, roleVar("embed", "MODEL"));
  const dimensions = valueOf(env, roleVar("embed", "DIMENSIONS"));
  if (provider === undefined && model === undefined && dimensions === undefined) return null;
  return {
    provider: provider ?? fallbackProvider,
    model,
    dimensions:
      dimensions === undefined
        ? undefined
        : /^\d{1,6}$/.test(dimensions)
          ? Number(dimensions)
          : dimensions,
  };
};

const providerBlock = (env: Env, kind: (typeof PROVIDER_KINDS)[number]) => {
  const vars = PROVIDER_VARS[kind];
  const block: Record<string, unknown> = { kind, ...vars.defaults };
  for (const [suffix, field] of Object.entries(vars.fields)) {
    const value = valueOf(env, `${PREFIX}${vars.prefix}_${suffix}`);
    if (value !== undefined) block[field] = value;
  }
  return block;
};

/** Reads `ROCKY_LLM_*` and validates. Throws `LlmConfigError` naming each offending variable. */
export const llmConfigFromEnv = (env: Env): LlmConfig => {
  const issues: LlmConfigIssue[] = [];
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith(PREFIX) && !KNOWN_VARS.has(name) && valueOf(env, name) !== undefined) {
      issues.push({ path: name, message: "unknown variable (see .env.example)" });
    }
  }

  const fallback = valueOf(env, `${PREFIX}PROVIDER`) ?? DEFAULT_PROVIDER;
  const roles: Record<string, unknown> = {};
  for (const role of LLM_COMPLETION_ROLES) {
    roles[role] = completionRole(env, role, valueOf(env, roleVar(role, "PROVIDER")) ?? fallback);
  }
  const embed = embedRole(env, fallback);
  roles["embed"] = embed;

  const used = new Set(
    Object.values(roles).map((role) => (role as { provider?: unknown } | null)?.provider),
  );
  const providers: Record<string, unknown> = {};
  for (const kind of PROVIDER_KINDS) {
    const { prefix, fields } = PROVIDER_VARS[kind];
    const anySet = Object.keys(fields).some(
      (suffix) => valueOf(env, `${PREFIX}${prefix}_${suffix}`) !== undefined,
    );
    if (used.has(kind) || anySet) providers[kind] = providerBlock(env, kind);
  }

  const result = checkLlmConfig({ providers, roles }, labelFor(env));
  if (!result.ok) issues.push(...result.issues);
  if (issues.length > 0 || !result.ok) {
    const seen = new Set<string>();
    throw new LlmConfigError(
      issues.filter((issue) => {
        const key = `${issue.path}\u0000${issue.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }
  return result.config;
};
