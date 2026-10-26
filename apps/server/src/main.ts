import { createLogger } from "@rocky-reviews/log";
import pg from "pg";
import { buildApp } from "./app.js";

const log = createLogger("server");
const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
pool.on("error", (error) => log.error({ err: error.message }, "postgres idle client error"));

const app = buildApp({
  checkDatabase: async () => (await pool.query("select 1 as ok")).rowCount === 1,
  log,
});

// 0.0.0.0 in containers (Fly.io); .env.example binds 127.0.0.1 for local development.
const host = process.env["HOST"] ?? "0.0.0.0";
const port = Number(process.env["PORT"] ?? 4310);
await app.listen({ port, host });
log.info({ host, port }, "server listening");
