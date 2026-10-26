import {
  GitHubAppConfigError,
  githubEndpoints,
  parseGitHubAppAuth,
  type GitHubAppAuth,
} from "@rocky-reviews/forge-github";

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
}

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
  return { databaseUrl, githubApp: githubAppFromEnv(env) };
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
