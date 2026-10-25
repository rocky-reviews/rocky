import { createLogger } from "@rocky-reviews/log";
import pg from "pg";

// Job consumers (pg-boss) arrive in Phase 3/4. For now the worker proves it can reach Postgres.
const log = createLogger("worker");
const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });

const { rows } = await pool.query<{ version: string }>("select version()");
log.info({ postgres: rows[0]?.version }, "worker ready");

const shutdown = async (): Promise<void> => {
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
setInterval(() => log.debug("worker idle"), 60_000);
