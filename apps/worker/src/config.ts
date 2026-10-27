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
}

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
  return {
    databaseUrl,
    githubApp: githubAppFromEnv(env),
    llm,
    analysis: analysisConfigFromEnv(env),
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
