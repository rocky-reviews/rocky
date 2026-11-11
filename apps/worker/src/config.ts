import {
  GitHubAppConfigError,
  githubEndpoints,
  parseGitHubAppAuth,
  type GitHubAppAuth,
} from "@rocky-reviews/forge-github";
import { DEFAULT_ANALYSIS_TOKEN_LIMIT } from "@rocky-reviews/core";
import { LlmConfigError, llmConfigFromEnv, type LlmConfig } from "@rocky-reviews/llm";

/**
 * Worker configuration (P3-3, ADR 0009). Validated before anything is opened; messages name the
 * variable, never its value.
 */

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

/** Same rule as the server: `NODE_ENV=production`, or running on Fly.io. */
export const isProduction = (env: Env): boolean =>
  env["NODE_ENV"] === "production" || (env["FLY_APP_NAME"] ?? "") !== "";

const nonEmpty = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
};

export interface GitHubAppConfig {
  readonly auth: GitHubAppAuth;
  readonly api: URL;
}

export interface WorkerConfig {
  /** The worker's own login (a member of rocky_app and rocky_worker), never the server's. */
  readonly databaseUrl: string;
  /**
   * App credentials for re-verifying installation events with GitHub. Undefined only outside
   * production when neither variable is set: the worker then leaves installation events in the
   * inbox (they wait, they are not lost) instead of acting on them unverified.
   */
  readonly githubApp: GitHubAppConfig | undefined;
  /**
   * LLM roles (P4-1, ADR 0012), validated at boot (P4-3): a bad `ROCKY_LLM_*` stops the worker
   * before it claims work. Holds variable names, never keys.
   */
  readonly llm: LlmConfig;
  /** The analysis queue lane (P4-6, ADR 0017). */
  readonly analysis: AnalysisConfig;
  /** The repository index (P9-1, ADR 0040). */
  readonly index: IndexConfig;
  /**
   * Token mode (P10-4, ADR 0045): the API base the token orgs' repositories are read from.
   * Undefined in App mode. The KEK (`ROCKY_KEK_KEYS`) is then required (`main.ts`).
   */
  readonly token: { readonly api: URL } | undefined;
}

export interface IndexConfig {
  /**
   * `ROCKY_INDEX_AUTO=on`: pushes to a default branch queue an index run and the lane claims
   * them. Off by default; on needs the embed role (`ROCKY_LLM_EMBED_*`), or the worker refuses
   * to start.
   */
  readonly auto: boolean;
  /** Tokens one run may embed before it waits for "Index anyway" (`ROCKY_INDEX_TOKEN_LIMIT`). */
  readonly tokenLimit: number;
}

/**
 * A 100k-line repository is about 1M tokens to embed in full (4 characters a token), so the
 * default lets a first index of a repository up to a few times that through and stops anything
 * much larger for a person to approve; a push re-index is far below it.
 */
export const DEFAULT_INDEX_TOKEN_LIMIT = 5_000_000;

export interface AnalysisConfig {
  /**
   * `ROCKY_ANALYSIS_AUTO=on`: new head revisions are queued and the lane claims them. Off by
   * default: nothing is analysed (and nothing spends) until an operator turns it on.
   */
  readonly auto: boolean;
  /** Per-PR token estimate above which an analysis waits for "Analyze anyway". */
  readonly tokenLimit: number;
  /** Analyses this worker runs at once. */
  readonly concurrency: number;
  /** Analyses one org runs at once, across every worker. */
  readonly orgConcurrency: number;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  auto: false,
  tokenLimit: DEFAULT_ANALYSIS_TOKEN_LIMIT,
  concurrency: 4,
  orgConcurrency: 2,
};

const ANALYSIS_BOUNDS = {
  ROCKY_ANALYSIS_TOKEN_LIMIT: [1_000, 10_000_000],
  ROCKY_ANALYSIS_CONCURRENCY: [1, 32],
  ROCKY_ANALYSIS_ORG_CONCURRENCY: [1, 32],
  ROCKY_INDEX_TOKEN_LIMIT: [10_000, 500_000_000],
} as const;

const boundedInteger = (env: Env, name: keyof typeof ANALYSIS_BOUNDS, fallback: number): number => {
  const raw = nonEmpty(env, name);
  if (raw === undefined) return fallback;
  const [min, max] = ANALYSIS_BOUNDS[name];
  const value = /^[0-9]{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
};

/** `ROCKY_ANALYSIS_*` (P4-6); messages name the variable and its bounds, never the value. */
const onOff = (env: Env, name: string, fallback: boolean): boolean => {
  const raw = nonEmpty(env, name);
  if (raw === undefined) return fallback;
  if (raw !== "on" && raw !== "off") throw new ConfigError(`${name} must be on or off`);
  return raw === "on";
};

export const analysisConfigFromEnv = (env: Env): AnalysisConfig => ({
  auto: onOff(env, "ROCKY_ANALYSIS_AUTO", DEFAULT_ANALYSIS_CONFIG.auto),
  tokenLimit: boundedInteger(env, "ROCKY_ANALYSIS_TOKEN_LIMIT", DEFAULT_ANALYSIS_CONFIG.tokenLimit),
  concurrency: boundedInteger(
    env,
    "ROCKY_ANALYSIS_CONCURRENCY",
    DEFAULT_ANALYSIS_CONFIG.concurrency,
  ),
  orgConcurrency: boundedInteger(
    env,
    "ROCKY_ANALYSIS_ORG_CONCURRENCY",
    DEFAULT_ANALYSIS_CONFIG.orgConcurrency,
  ),
});

/** `ROCKY_INDEX_*` (P9-1). Indexing on without an embedding model is refused, not ignored. */
export const indexConfigFromEnv = (env: Env, llm: LlmConfig): IndexConfig => {
  const auto = onOff(env, "ROCKY_INDEX_AUTO", false);
  if (auto && llm.roles.embed === null) {
    throw new ConfigError(
      "ROCKY_INDEX_AUTO=on needs an embedding model: set ROCKY_LLM_EMBED_PROVIDER (and its key)",
    );
  }
  return {
    auto,
    tokenLimit: boundedInteger(env, "ROCKY_INDEX_TOKEN_LIMIT", DEFAULT_INDEX_TOKEN_LIMIT),
  };
};

/** The GitHub App's variables: none may be set in token mode (the server's rule too). */
const GITHUB_APP_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
] as const;

/**
 * `ROCKY_GITHUB_CONNECTION` (P10-4, ADR 0045), as the server reads it: `app` (default) or
 * `token`, which is refused on Fly.io (Rocky Cloud runs there) and with any App variable set.
 */
export const tokenModeFromEnv = (env: Env): { readonly api: URL } | undefined => {
  const raw = nonEmpty(env, "ROCKY_GITHUB_CONNECTION");
  if (raw === undefined || raw === "app") return undefined;
  if (raw !== "token") throw new ConfigError("ROCKY_GITHUB_CONNECTION must be app or token");
  if ((env["FLY_APP_NAME"] ?? "") !== "") {
    throw new ConfigError(
      "ROCKY_GITHUB_CONNECTION=token is for self-hosting only and is refused on Fly.io, where Rocky Cloud runs (FLY_APP_NAME is set)",
    );
  }
  for (const name of GITHUB_APP_VARIABLES) {
    if (nonEmpty(env, name) !== undefined) {
      throw new ConfigError(
        `${name} must be unset with ROCKY_GITHUB_CONNECTION=token: a server connects through the GitHub App or through a token, not both`,
      );
    }
  }
  const webUrl = nonEmpty(env, "GITHUB_URL");
  const apiUrl = nonEmpty(env, "GITHUB_API_URL");
  try {
    const { api } = githubEndpoints({
      ...(webUrl === undefined ? {} : { webUrl }),
      ...(apiUrl === undefined ? {} : { apiUrl }),
    });
    return { api };
  } catch (error) {
    throw new ConfigError(`GITHUB_URL/GITHUB_API_URL: ${(error as Error).message}`);
  }
};

export const githubAppFromEnv = (env: Env): GitHubAppConfig | undefined => {
  const appId = nonEmpty(env, "GITHUB_APP_ID");
  const privateKey = nonEmpty(env, "GITHUB_APP_PRIVATE_KEY");
  if (appId === undefined && privateKey === undefined) {
    if (isProduction(env)) {
      throw new ConfigError(
        "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required in production (NODE_ENV=production or FLY_APP_NAME set)",
      );
    }
    return undefined;
  }
  if (appId === undefined || privateKey === undefined) {
    throw new ConfigError("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together");
  }
  let auth: GitHubAppAuth;
  try {
    auth = parseGitHubAppAuth({ appId, privateKey });
  } catch (error) {
    if (error instanceof GitHubAppConfigError) throw new ConfigError(error.message);
    throw new ConfigError("GITHUB_APP_PRIVATE_KEY could not be read");
  }
  const webUrl = nonEmpty(env, "GITHUB_URL");
  const apiUrl = nonEmpty(env, "GITHUB_API_URL");
  let api: URL;
  try {
    ({ api } = githubEndpoints({
      ...(webUrl === undefined ? {} : { webUrl }),
      ...(apiUrl === undefined ? {} : { apiUrl }),
    }));
  } catch (error) {
    throw new ConfigError(`GITHUB_URL/GITHUB_API_URL: ${(error as Error).message}`);
  }
  return { auth, api };
};

export const workerConfigFromEnv = (env: Env): WorkerConfig => {
  const databaseUrl = nonEmpty(env, "WORKER_DATABASE_URL");
  if (databaseUrl === undefined) {
    throw new ConfigError(
      "WORKER_DATABASE_URL is required: the worker's own login, a member of rocky_app and rocky_worker (see .env.example; `pnpm seed` creates the dev role)",
    );
  }
  let llm: LlmConfig;
  try {
    llm = llmConfigFromEnv(env);
  } catch (error) {
    // The messages name variables and problems, never values (ADR 0012 §3).
    if (error instanceof LlmConfigError) throw new ConfigError(error.message);
    throw new ConfigError("ROCKY_LLM_*: invalid LLM configuration");
  }
  const token = tokenModeFromEnv(env);
  return {
    databaseUrl,
    githubApp: token === undefined ? githubAppFromEnv(env) : undefined,
    token,
    llm,
    analysis: analysisConfigFromEnv(env),
    index: indexConfigFromEnv(env, llm),
  };
};

/**
 * `workerConfigFromEnv` for the real process: once the key parsed, `GITHUB_APP_PRIVATE_KEY` is
 * removed from `env` (review round 1, L6) so no child process, diagnostic dump or later
 * `process.env` read sees it; the parsed key lives on only in a KeyObject.
 */
export const loadWorkerConfig = (env: Record<string, string | undefined>): WorkerConfig => {
  const config = workerConfigFromEnv(env);
  delete env["GITHUB_APP_PRIVATE_KEY"];
  return config;
};

/** An actionable hint for a refused database login (review round 1, N4); nothing else. */
export const databaseLoginHint = (code: string): string | undefined =>
  code === "28P01" || code === "28000"
    ? "the database refused the worker's login: run `pnpm seed` (creates rocky_worker_dev) and check WORKER_DATABASE_URL"
    : undefined;
