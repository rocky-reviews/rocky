import { createDb } from "@rocky-reviews/db";
import { createGitHubWebhookIngress } from "@rocky-reviews/forge-github";
import { createLogger } from "@rocky-reviews/log";
import pg from "pg";
import { buildApp } from "./app.js";
import { webhookSecretFromEnv } from "./config.js";
import type { WebhookDeps } from "./webhooks.js";

const log = createLogger("server");

// Configuration first: a production server without a webhook secret must not start (P3-2).
let webhookSecret: string | undefined;
try {
  webhookSecret = webhookSecretFromEnv(process.env);
} catch (error) {
  log.fatal({ err: (error as Error).message }, "invalid configuration");
  process.exit(1);
}

const connectionString = process.env["DATABASE_URL"];
const pool = new pg.Pool({ connectionString });
pool.on("error", (error) => log.error({ err: error.message }, "postgres idle client error"));

let webhooks: WebhookDeps | undefined;
if (webhookSecret === undefined) {
  log.warn("GITHUB_WEBHOOK_SECRET is not set: webhook receiver disabled (development only)");
} else {
  const db = createDb(
    connectionString === undefined ? { pool: new pg.Pool() } : { connectionString, max: 5 },
  );
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
const host = process.env["HOST"] ?? "0.0.0.0";
const port = Number(process.env["PORT"] ?? 4310);
await app.listen({ port, host });
log.info({ host, port, webhooks: webhooks !== undefined }, "server listening");
