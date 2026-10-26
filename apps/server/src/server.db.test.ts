import { TEST_WEBHOOK_SECRET } from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import { CONTAINER_TIMEOUT_MS, startPostgres, type TestPostgres } from "@rocky-reviews/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.js";

/**
 * Review round 1, items 1 and 2, against a real Postgres: the server's single pool carries the
 * statement timeout, and killing its idle connections (a Postgres restart, pg_terminate_backend)
 * does not crash the process; the next request gets a fresh connection.
 */

let pgs: TestPostgres;
let superuser: pg.Pool;
let server: RunningServer;
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 });
  const log = createLogger("server-test", {
    destination: {
      write: (c: string) => void lines.push(JSON.parse(c) as Record<string, unknown>),
    },
  });
  server = await startServer(
    {
      DATABASE_URL: pgs.appUrl,
      HOST: "127.0.0.1",
      PORT: "0",
      GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    },
    log,
  );
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await server?.close();
  await superuser?.end();
  await pgs?.stop();
});

describe("the server pool", () => {
  it("runs statements under a 3 s statement_timeout", async () => {
    const { rows } = await server.pool.query<{ statement_timeout: string }>(
      "show statement_timeout",
    );
    expect(rows[0]?.statement_timeout).toBe("3s");
  });

  it("survives its idle connections being terminated", async () => {
    expect((await server.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect(server.pool.idleCount).toBeGreaterThan(0);
    const killed = await superuser.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = 'rocky_app_test'",
    );
    expect(killed.rowCount).toBeGreaterThan(0);
    await expect
      .poll(() => lines.some((l) => l["msg"] === "postgres idle client error"), { timeout: 5_000 })
      .toBe(true);
    const logged = lines.find((l) => l["msg"] === "postgres idle client error");
    expect(logged).toMatchObject({ errorCode: "57P01" });
    expect((await server.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});
