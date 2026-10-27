import { ForgeReadError } from "@rocky-reviews/core";
import { createDb, WORKER_ROLE } from "@rocky-reviews/db";
import { createGitHubForge } from "@rocky-reviews/forge-github";
import { createLogger } from "@rocky-reviews/log";
import pg from "pg";
import {
  ConfigError,
  databaseLoginHint,
  loadWorkerConfig,
  type GitHubAppConfig,
} from "./config.js";
import { parseRebuildArgs, rebuildRepositoryMirror, RebuildError } from "./mirror-rebuild.js";

/**
 * `pnpm mirror:rebuild <owner/name> [--limit N]` (P3-4, ADR 0010 §4): recreates one repository's
 * pull request mirror from GitHub. Runs with the worker's configuration (`WORKER_DATABASE_URL`,
 * `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`). Prints the report as one log line: ids and counts
 * only (no repository name, titles or tokens). Exit 0 on success, 1 when refused or failed.
 */

const log = createLogger("mirror-rebuild");

const codeOf = (error: unknown): string => {
  if (error instanceof RebuildError || error instanceof ForgeReadError) return error.code;
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "internal_error";
};

let args: ReturnType<typeof parseRebuildArgs>;
let config: ReturnType<typeof loadWorkerConfig>;
let githubApp: GitHubAppConfig;
try {
  args = parseRebuildArgs(process.argv.slice(2));
  config = loadWorkerConfig(process.env);
  if (config.githubApp === undefined) {
    throw new ConfigError("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required to read GitHub");
  }
  githubApp = config.githubApp;
} catch (error) {
  log.fatal({ err: error instanceof Error ? error.message : "invalid arguments" }, "refused");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
// An idle client losing its connection must not crash the command; the next query reconnects.
pool.on("error", (error) => log.error({ errorCode: codeOf(error) }, "postgres idle client error"));
let exitCode = 1;
try {
  const { rows } = await pool.query<{ worker: boolean }>(
    "select pg_has_role(current_user, $1, 'USAGE') as worker",
    [WORKER_ROLE],
  );
  if (rows[0]?.worker !== true) {
    log.fatal(`WORKER_DATABASE_URL must log in as a member of ${WORKER_ROLE} (run pnpm seed)`);
  } else {
    const clock = { now: () => new Date() };
    const report = await rebuildRepositoryMirror(
      {
        db: createDb({ pool }),
        forge: createGitHubForge({
          auth: githubApp.auth,
          api: githubApp.api,
          clock,
        }),
      },
      args.fullName,
      { limit: args.limit },
    );
    log.info(report, "mirror rebuilt");
    exitCode = 0;
  }
} catch (error) {
  const code = codeOf(error);
  log.error({ errorCode: code }, databaseLoginHint(code) ?? "mirror rebuild failed");
} finally {
  await pool.end().catch(() => undefined);
}
process.exit(exitCode);
