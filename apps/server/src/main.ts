import { createLogger } from "@rocky-reviews/log";
import pg from "pg";
import { buildApp } from "./app.js";

const log = createLogger("server");
const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });

const app = buildApp({
  checkDatabase: async () => (await pool.query("select 1 as ok")).rowCount === 1,
});

const port = Number(process.env["PORT"] ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
log.info({ port }, "server listening");
