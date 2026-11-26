import { randomUUID } from "node:crypto";
import {
  nothingStoredYet,
  type Entitlements,
  type LlmRoles,
  type OrgErasers,
  type OrgId,
} from "@rocky-reviews/core";
import { createDb, WORKER_ROLE } from "@rocky-reviews/db";
import { CryptoError, localKeyWrapperFromEnv, type KeyWrapper } from "@rocky-reviews/crypto";
import { createGitHubForge, createGitHubTokenClient } from "@rocky-reviews/forge-github";
import { createTreeSitterChunker } from "@rocky-reviews/indexer";
import { createLlmRoles, envSecrets, providerAdapters, usageTargetsFor } from "@rocky-reviews/llm";
import type { Logger } from "@rocky-reviews/log";
import pg from "pg";
import { unitKeySaltFor } from "./analysis.js";
import { ConfigError, databaseLoginHint, loadWorkerConfig, type WorkerConfig } from "./config.js";
import { heartbeatFileFromEnv, startHeartbeat, type Heartbeat } from "./heartbeat.js";
import { startJobs, type RunningJobs } from "./jobs.js";
import { createTokenRepositories } from "./token-repositories.js";

/**
 * The worker's composition root (C-8, ADR 0046 §4), the counterpart of the server's
 * `startServer`: validates the configuration, builds the roles, the pool and the forge, checks
 * the database login, starts the jobs and the heartbeat, and returns a handle that stops them.
 * `main.ts` turns a `ConfigError` into exit code 1 and wires the signals. Rocky Cloud composes
 * its own worker entry on this function, passing its plan-backed `Entitlements`; self-hosted
 * instances keep the default (`startJobs`'s `selfHostEntitlements`).
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface WorkerOptions {
  /**
   * Which features an org may use, asked by the analysis and index lanes before any model call.
   * Default: the self-host implementation (every `review.*` feature on).
   */
  readonly entitlements?: Entitlements;
}

export interface RunningWorker {
  readonly config: WorkerConfig;
  readonly jobs: RunningJobs;
  readonly pool: pg.Pool;
  /** Stops the heartbeat and the jobs, waits for runs in progress, ends the pool. Idempotent. */
  close(): Promise<void>;
}

const errorCode = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : "unknown";
};

/** The worker cannot start: the message names variables, roles and checks only, never values. */
export class WorkerStartError extends ConfigError {
  constructor(
    message: string,
    /** Extra fields for the fatal log line (fixed codes only). */
    readonly fields: Record<string, string | boolean> = {},
  ) {
    super(message);
  }
}

export const startWorker = async (
  env: Env,
  log: Logger,
  options: WorkerOptions = {},
): Promise<RunningWorker> => {
  // Also removes GITHUB_APP_PRIVATE_KEY from process.env once parsed (L6).
  const config = loadWorkerConfig(env);
  /** Token mode (P10-4): unwraps the token orgs' data keys to read their stored token. */
  let keys: KeyWrapper | undefined;
  if (config.token !== undefined) {
    try {
      keys = localKeyWrapperFromEnv(env);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      throw new ConfigError(
        "ROCKY_GITHUB_CONNECTION=token: the worker reads the stored token, set ROCKY_KEK_KEYS (and ROCKY_KEK_CURRENT) as on the server",
      );
    }
  }
  // The container healthcheck's liveness file (P10-1, ADR 0043); unset in development.
  const heartbeatFile = heartbeatFileFromEnv(env);

  // P4-3: every role resolves to an installed adapter with the capability it needs, or the worker
  // stops here, before it claims work. Keys are read per call through `envSecrets`, never now.
  // The analysis lane (P4-6, jobs.ts) hands these roles to `runAnalysis`, with
  // `usageTargetsFor(config.llm)` for metering (P4-5, ADR 0016): every run's roles are metered.
  let llm: LlmRoles;
  try {
    llm = createLlmRoles(config.llm, providerAdapters(), envSecrets(env));
  } catch (error) {
    throw new WorkerStartError("invalid LLM configuration (ROCKY_LLM_*)", {
      err: error instanceof Error ? error.name : "unknown",
    });
  }

  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
  // An idle client losing its connection must not crash the worker; pg reconnects on next use.
  pool.on("error", (error) =>
    log.error({ errorCode: errorCode(error) }, "postgres idle client error"),
  );

  // The worker's privileges come from rocky_worker; refuse to start on the server's login.
  try {
    const { rows } = await pool.query<{ worker: boolean }>(
      "select pg_has_role(current_user, $1, 'USAGE') as worker",
      [WORKER_ROLE],
    );
    if (rows[0]?.worker !== true) {
      await pool.end();
      throw new WorkerStartError(
        `WORKER_DATABASE_URL must log in as a member of ${WORKER_ROLE} (run pnpm seed)`,
      );
    }
  } catch (error) {
    if (error instanceof WorkerStartError) throw error;
    await pool.end();
    const code = errorCode(error);
    throw new WorkerStartError(databaseLoginHint(code) ?? "worker cannot reach Postgres", {
      errorCode: code,
    });
  }

  const clock = { now: () => new Date() };
  const db = createDb({ pool });
  // R2 objects (P5) and external embeddings (P8) do not exist yet; each must replace its slot.
  const erasers: OrgErasers = {
    object_storage: nothingStoredYet("object_storage"),
    embeddings: nothingStoredYet("embeddings"),
  };
  // The repository index (P9-1, ADR 0040): only with ROCKY_INDEX_AUTO=on, which the config
  // refuses without an embed role. The grammars load once, here, before anything is claimed.
  const embed = config.llm.roles.embed;
  const index =
    config.index.auto && embed !== null
      ? {
          llm,
          usageTargets: usageTargetsFor(config.llm),
          space: { provider: embed.provider, model: embed.model, dimensions: embed.dimensions },
          chunker: await createTreeSitterChunker(),
          tokenLimit: config.index.tokenLimit,
        }
      : undefined;

  const jobs = startJobs({
    db,
    log,
    clock,
    erasers,
    newOrgId: () => randomUUID() as OrgId,
    ...(options.entitlements === undefined ? {} : { entitlements: options.entitlements }),
    // Off by default (ROCKY_ANALYSIS_AUTO): no lane, and the mirror queues nothing.
    ...(config.analysis.auto
      ? {
          analysis: {
            llm,
            unitKeySalt: unitKeySaltFor(config.llm),
            usageTargets: usageTargetsFor(config.llm),
            tokenLimit: config.analysis.tokenLimit,
            concurrency: config.analysis.concurrency,
            orgConcurrency: config.analysis.orgConcurrency,
          },
        }
      : {}),
    ...(index === undefined ? {} : { index }),
    ...(config.token === undefined || keys === undefined
      ? {}
      : {
          tokenRepositories: createTokenRepositories({
            db,
            keys,
            client: createGitHubTokenClient({ api: config.token.api }),
          }),
        }),
    forge:
      config.githubApp === undefined
        ? undefined
        : createGitHubForge({
            auth: config.githubApp.auth,
            api: config.githubApp.api,
            clock,
          }),
  });
  log.info(
    {
      installationEvents: config.githubApp !== undefined,
      pullRequestEvents: config.githubApp !== undefined,
      analyses:
        (config.githubApp !== undefined || config.token !== undefined) && config.analysis.auto,
      connection: config.token === undefined ? "app" : "token",
      analysisConcurrency: config.analysis.concurrency,
      analysisOrgConcurrency: config.analysis.orgConcurrency,
      tokenLimit: config.analysis.tokenLimit,
      codeIndex: config.githubApp !== undefined && index !== undefined,
      indexTokenLimit: config.index.tokenLimit,
      entitlements: options.entitlements === undefined ? "self-host" : "provided",
    },
    "worker ready",
  );
  // Only once the lanes run: the healthcheck must not report a worker that claims nothing.
  const heartbeat: Heartbeat | undefined =
    heartbeatFile === undefined ? undefined : startHeartbeat({ file: heartbeatFile, log });

  let closing: Promise<void> | undefined;
  return {
    config,
    jobs,
    pool,
    close: () => {
      closing ??= (async () => {
        heartbeat?.stop();
        try {
          await jobs.stop();
        } finally {
          await pool.end();
        }
      })();
      return closing;
    },
  };
};
