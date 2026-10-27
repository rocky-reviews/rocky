import { createDb, WORKER_ROLE } from "@rocky-reviews/db";
import { createGitHubWebhookIngress } from "@rocky-reviews/forge-github";
import type { Logger } from "@rocky-reviews/log";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import pg from "pg";
import { buildApp } from "./app.js";
import { ConfigError, githubAppSetupFromEnv, webhookSecretFromEnv } from "./config.js";
import { SETUP_PATH, type GitHubAppSetupDeps } from "./github-app-setup.js";
import type { WebhookDeps } from "./webhooks.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The pool bounds only how long a request waits for a connection (2 s). Statement bounds are
 * set per query where they belong (the inbox insert has 3 s, `packages/db`), so future
 * `withOrg` routes do not inherit a hidden cap. The route's 6 s guard (INBOX_RECORD_TIMEOUT_MS)
 * is the backstop; all stay under GitHub's 10 s delivery timeout.
 */
export const POOL_TIMEOUTS = { connectionTimeoutMillis: 2_000 } as const;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

/**
 * DATABASE_URL logs in as a member of `rocky_worker` (the worker's login, or a superuser, which
 * is a member of every role). The internet-facing server must never hold the worker's
 * privileges: creating orgs, claiming inbox rows, erasing orgs (ADR 0009, L28). The message
 * names roles and variables only, never the connection string.
 */
export class WorkerLoginError extends ConfigError {
  constructor() {
    super(
      `DATABASE_URL logs in as a member of ${WORKER_ROLE}: the server needs its own rocky_app login, never the worker's (WORKER_DATABASE_URL) or a superuser`,
    );
  }
}

/** Fails closed: an unexpected answer is treated as membership. */
const refuseWorkerLogin = async (client: pg.ClientBase): Promise<void> => {
  const { rows } = await client.query<{ worker: boolean }>(
    "select pg_has_role(current_user, $1, 'USAGE') as worker",
    [WORKER_ROLE],
  );
  if (rows[0]?.worker !== false) throw new WorkerLoginError();
};

/**
 * The server's single Postgres pool. Every new connection is checked before first use
 * (`onConnect`): one whose login is a member of `rocky_worker` is closed and the query fails,
 * so a role granted after boot, or a database unreachable at boot, cannot hand the server the
 * worker's privileges. An idle client losing its connection (Postgres restart,
 * pg_terminate_backend) emits `error` on the pool; without a listener that crashes the process.
 * Only the error code is logged: driver messages can carry connection details or values.
 */
export const createServerPool = (connectionString: string | undefined, log: Logger): pg.Pool => {
  const options: pg.PoolConfig & { onConnect: (client: pg.ClientBase) => Promise<void> } = {
    ...(connectionString === undefined ? {} : { connectionString }),
    max: 10,
    ...POOL_TIMEOUTS,
    // pg-pool awaits the hook and discards the connection when it rejects (@types/pg types it
    // as returning void).
    onConnect: async (client) => {
      try {
        await refuseWorkerLogin(client);
      } catch (error) {
        if (error instanceof WorkerLoginError) {
          log.error({ role: WORKER_ROLE }, "database login refused");
        }
        throw error;
      }
    },
  };
  const pool = new pg.Pool(options);
  pool.on("error", (error) =>
    log.error({ errorCode: errorCode(error) }, "postgres idle client error"),
  );
  return pool;
};

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly webhooks: boolean;
  /** Whether the GitHub App manifest setup routes are registered (P3-1). */
  readonly githubAppSetup: boolean;
  close(): Promise<void>;
}

export interface StartOptions {
  /**
   * Shows the one-time setup URL to the operator. Defaults to writing to the terminal (stderr),
   * deliberately not through the logger: log pipelines ship and retain lines, and the token is a
   * credential (ADR 0008).
   */
  announce?: (text: string) => void;
}

const announceToTerminal = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

/**
 * Validates configuration (throws `ConfigError` before opening anything), builds the app on one
 * pool and listens. `main.ts` turns a ConfigError into exit code 1.
 */
export const startServer = async (
  env: Env,
  log: Logger,
  options: StartOptions = {},
): Promise<RunningServer> => {
  const webhookSecret = webhookSecretFromEnv(env);
  const setup = githubAppSetupFromEnv(env, homedir());
  let githubAppSetup: GitHubAppSetupDeps | undefined;
  if (setup.enabled) {
    githubAppSetup = { ...setup.config, token: randomBytes(32).toString("base64url") };
  } else if (setup.reason === "configured" && env["GITHUB_APP_SETUP"] === "true") {
    log.warn("GITHUB_APP_SETUP ignored: a GitHub App is already configured");
  }
  const pool = createServerPool(env["DATABASE_URL"], log);
  // Review round 4: refuse to start on the worker's login. Booting does not need the database
  // (health reports it); when it is unreachable now, the pool's hook checks each connection later.
  try {
    await pool.query("select 1");
  } catch (error) {
    if (error instanceof WorkerLoginError) {
      await pool.end();
      throw error;
    }
    log.warn({ errorCode: errorCode(error) ?? "unknown" }, "database unreachable at boot");
  }

  let webhooks: WebhookDeps | undefined;
  if (webhookSecret === undefined) {
    log.warn("GITHUB_WEBHOOK_SECRET is not set: webhook receiver disabled (development only)");
  } else {
    const db = createDb({ pool });
    webhooks = {
      ingress: createGitHubWebhookIngress({ secret: webhookSecret }),
      inbox: { record: (delivery) => db.recordWebhookDelivery(delivery) },
    };
  }

  const app = buildApp({
    checkDatabase: async () => (await pool.query("select 1 as ok")).rowCount === 1,
    log,
    ...(webhooks === undefined ? {} : { webhooks }),
    ...(githubAppSetup === undefined ? {} : { githubAppSetup }),
  });

  // 0.0.0.0 in containers (Fly.io); .env.example binds 127.0.0.1 for local development.
  const host = env["HOST"] ?? "0.0.0.0";
  const port = Number(env["PORT"] ?? 4310);
  try {
    await app.listen({ port, host });
  } catch (error) {
    await pool.end();
    throw error;
  }
  log.info(
    { host, port, webhooks: webhooks !== undefined, githubAppSetup: githubAppSetup !== undefined },
    "server listening",
  );
  if (githubAppSetup !== undefined) {
    const url = new URL(SETUP_PATH, githubAppSetup.publicUrl);
    url.searchParams.set("token", githubAppSetup.token);
    (options.announce ?? announceToTerminal)(
      `\nGitHub App setup is open. Open this one-time URL in your browser (do not share it):\n  ${url.href}\n`,
    );
  }

  // Idempotent: a second signal (or caller) awaits the same shutdown instead of ending the pool
  // twice, which pg refuses.
  let closing: Promise<void> | undefined;
  return {
    app,
    pool,
    webhooks: webhooks !== undefined,
    githubAppSetup: githubAppSetup !== undefined,
    close: () => {
      closing ??= (async () => {
        try {
          await app.close();
        } finally {
          await pool.end();
        }
      })();
      return closing;
    },
  };
};
