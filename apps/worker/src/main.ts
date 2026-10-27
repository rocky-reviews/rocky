import { randomUUID } from "node:crypto";
import { nothingStoredYet, type OrgErasers, type OrgId } from "@rocky-reviews/core";
import { createDb, WORKER_ROLE } from "@rocky-reviews/db";
import { createGitHubForge } from "@rocky-reviews/forge-github";
import { createLlmRoles, envSecrets, providerAdapters } from "@rocky-reviews/llm";
import { createLogger } from "@rocky-reviews/log";
import pg from "pg";
import { ConfigError, databaseLoginHint, loadWorkerConfig, type WorkerConfig } from "./config.js";
import { startJobs } from "./jobs.js";

const log = createLogger("worker");

const errorCode = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : "unknown";
};

let config: WorkerConfig;
try {
  // Also removes GITHUB_APP_PRIVATE_KEY from process.env once parsed (L6).
  config = loadWorkerConfig(process.env);
} catch (error) {
  // Fail closed: no worker without its own login, or (in production) without app credentials.
  log.fatal(
    { err: error instanceof ConfigError ? error.message : "invalid configuration" },
    "invalid configuration",
  );
  process.exit(1);
}

// P4-3: every role resolves to an installed adapter with the capability it needs, or the worker
// stops here, before it claims work. Keys are read per call through `envSecrets`, never now. The
// analysis lane that hands these roles to `runAnalysis` (analysis.ts), with
// `usageTargetsFor(config.llm)` for metering (P4-5, ADR 0015), comes with the queue and its org
// concurrency cap (docs/progress.md, P4-3 follow-ups).
try {
  createLlmRoles(config.llm, providerAdapters(), envSecrets(process.env));
} catch (error) {
  log.fatal(
    { err: error instanceof Error ? error.name : "unknown" },
    "invalid LLM configuration (ROCKY_LLM_*)",
  );
  process.exit(1);
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
    log.fatal(`WORKER_DATABASE_URL must log in as a member of ${WORKER_ROLE} (run pnpm seed)`);
    process.exit(1);
  }
} catch (error) {
  const code = errorCode(error);
  log.fatal({ errorCode: code }, databaseLoginHint(code) ?? "worker cannot reach Postgres");
  process.exit(1);
}

const clock = { now: () => new Date() };
const db = createDb({ pool });
// R2 objects (P5) and external embeddings (P8) do not exist yet; each must replace its slot.
const erasers: OrgErasers = {
  object_storage: nothingStoredYet("object_storage"),
  embeddings: nothingStoredYet("embeddings"),
};
const jobs = startJobs({
  db,
  log,
  clock,
  erasers,
  newOrgId: () => randomUUID() as OrgId,
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
  },
  "worker ready",
);

let shuttingDown: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  shuttingDown ??= (async () => {
    let code = 0;
    try {
      await jobs.stop();
      await pool.end();
    } catch {
      code = 1;
    }
    process.exit(code);
  })();
  return shuttingDown;
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
