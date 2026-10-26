import { createDb } from "@rocky-reviews/db";
import { createGitHubWebhookIngress } from "@rocky-reviews/forge-github";
import type { Logger } from "@rocky-reviews/log";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "./app.js";
import { webhookSecretFromEnv } from "./config.js";
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
 * The server's single Postgres pool. An idle client losing its connection (Postgres restart,
 * pg_terminate_backend) emits `error` on the pool; without a listener that crashes the process.
 * Only the error code is logged: driver messages can carry connection details or values.
 */
export const createServerPool = (connectionString: string | undefined, log: Logger): pg.Pool => {
  const pool = new pg.Pool({
    ...(connectionString === undefined ? {} : { connectionString }),
    max: 10,
    ...POOL_TIMEOUTS,
  });
  pool.on("error", (error) =>
    log.error({ errorCode: errorCode(error) }, "postgres idle client error"),
  );
  return pool;
};

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly webhooks: boolean;
  close(): Promise<void>;
}

/**
 * Validates configuration (throws `ConfigError` before opening anything), builds the app on one
 * pool and listens. `main.ts` turns a ConfigError into exit code 1.
 */
export const startServer = async (env: Env, log: Logger): Promise<RunningServer> => {
  const webhookSecret = webhookSecretFromEnv(env);
  const pool = createServerPool(env["DATABASE_URL"], log);

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
  log.info({ host, port, webhooks: webhooks !== undefined }, "server listening");

  // Idempotent: a second signal (or caller) awaits the same shutdown instead of ending the pool
  // twice, which pg refuses.
  let closing: Promise<void> | undefined;
  return {
    app,
    pool,
    webhooks: webhooks !== undefined,
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
