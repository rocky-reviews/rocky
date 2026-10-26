import {
  pullRequestPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
} from "@rocky-reviews/forge-github/testing";
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
  it("puts no hidden statement cap on the shared pool (review round 2, N1)", async () => {
    const { rows } = await server.pool.query<{ statement_timeout: string }>(
      "show statement_timeout",
    );
    expect(rows[0]?.statement_timeout).toBe("0");
  });

  it("bounds the inbox insert itself: a locked inbox gives 503 after the 2 s lock_timeout, before the 6 s guard, and leaves no waiting backend", async () => {
    const locker = await superuser.connect();
    try {
      await locker.query("begin");
      await locker.query("lock table app.webhook_deliveries in access exclusive mode");
      const d = signedDelivery("pull_request", pullRequestPayload("opened", { number: 31 }));
      const started = Date.now();
      const res = await server.app.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: d.headers,
        payload: d.body,
      });
      const elapsed = Date.now() - started;
      expect(res.statusCode).toBe(503);
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(4_000);
      const entry = lines.findLast((l) => l["msg"] === "webhook inbox unavailable");
      // 55P03 lock_not_available: the server-side bound fired, with its real SQLSTATE.
      expect(entry?.["webhook"]).toMatchObject({ outcome: "inbox_error", sqlstate: "55P03" });
      // Review round 3, S-A: the bound is server-side too. While the lock is still held, no
      // backend of the app role may be left waiting on it (an orphan per blocked webhook would
      // exhaust max_connections).
      // Its own connection: `locker` holds the superuser pool's only one.
      const observer = new pg.Client({ connectionString: pgs.superUrl });
      await observer.connect();
      try {
        const waiting = async () =>
          Number(
            (
              await observer.query<{ n: string }>(
                `select count(*)::text as n from pg_stat_activity
                  where usename = 'rocky_app_test' and wait_event_type = 'Lock'`,
              )
            ).rows[0]?.n,
          );
        await expect.poll(waiting, { timeout: 1_000, interval: 100 }).toBe(0);
      } finally {
        await observer.end();
      }
    } finally {
      await locker.query("rollback");
      locker.release();
    }
  }, 15_000);

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
