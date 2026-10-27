import {
  pullRequestPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
} from "@rocky-reviews/forge-github/testing";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORKER_ROLE } from "@rocky-reviews/db";
import { createLogger } from "@rocky-reviews/log";
import {
  CONTAINER_TIMEOUT_MS,
  startPostgres,
  TEST_ROLES,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError } from "./config.js";
import { startServer, WorkerLoginError, type RunningServer } from "./server.js";

/**
 * Review round 1, items 1 and 2, against a real Postgres: the server's single pool carries the
 * statement timeout, and killing its idle connections (a Postgres restart, pg_terminate_backend)
 * does not crash the process; the next request gets a fresh connection.
 */

let pgs: TestPostgres;
let superuser: pg.Pool;
let server: RunningServer;
const lines: Record<string, unknown>[] = [];

const capture = () => {
  const out: Record<string, unknown>[] = [];
  const log = createLogger("server-test", {
    destination: { write: (c: string) => void out.push(JSON.parse(c) as Record<string, unknown>) },
  });
  return { log, out };
};

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

/**
 * Review round 4: the internet-facing server must never hold the worker's privileges (creating
 * orgs, claiming inbox rows, erasing orgs). An operator reusing WORKER_DATABASE_URL (or a
 * superuser URL, which is a member of every role) as DATABASE_URL must get a refusal, not a server.
 */
describe("the server's database login (review round 4)", () => {
  const env = (url: string) => ({ DATABASE_URL: url, HOST: "127.0.0.1", PORT: "0" });
  const passwordOf = (url: string) => decodeURIComponent(new URL(url).password);

  it.each([
    ["the worker login", () => pgs.workerUrl],
    ["a superuser", () => pgs.superUrl],
  ])("refuses to start on %s, before listening", async (_name, url) => {
    const { log, out } = capture();
    const error = await startServer(env(url()), log).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerLoginError);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(WORKER_ROLE);
    expect(out.find((l) => l["msg"] === "server listening")).toBeUndefined();
    // Neither the connection string nor its host and login reach the message or the log.
    const { host, username } = new URL(url());
    for (const secret of [url(), `${username}:`, `@${host}`]) {
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(out)).not.toContain(secret);
    }
  });

  it("main.ts exits 1 with a clear message that holds no credential", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./main.ts", import.meta.url))],
      {
        env: { PATH: process.env["PATH"] ?? "", ...env(pgs.workerUrl) },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(1);
    const fatal = result.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l["msg"] === "invalid configuration");
    expect(fatal?.["err"]).toMatch(/DATABASE_URL logs in as a member of rocky_worker/);
    expect(result.stdout).not.toContain("server listening");
    expect(result.stdout + result.stderr).not.toContain(passwordOf(pgs.workerUrl));
  }, 30_000);

  it("starts on the application login", async () => {
    const { log, out } = capture();
    const running = await startServer(env(pgs.appUrl), log);
    try {
      expect(out.find((l) => l["msg"] === "server listening")).toBeDefined();
      expect((await running.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await running.close();
    }
  });

  it("checks every new connection too: a login granted the worker role after boot gets no connection", async () => {
    const { log, out } = capture();
    const running = await startServer(env(pgs.appUrl), log);
    const grant = `grant ${WORKER_ROLE} to ${TEST_ROLES.app}`;
    try {
      expect((await running.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      await superuser.query(grant);
      // Existing connections end (as on a restart); the pool opens new ones on the next query.
      await superuser.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where usename = $1`,
        [TEST_ROLES.app],
      );
      await expect.poll(() => running.pool.totalCount, { timeout: 5_000 }).toBe(0);
      await expect(running.pool.query("select 1")).rejects.toBeInstanceOf(WorkerLoginError);
      expect((await running.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(503);
      expect(out.find((l) => l["msg"] === "database login refused")).toMatchObject({
        role: WORKER_ROLE,
      });
      expect(running.pool.totalCount).toBe(0);
    } finally {
      await superuser.query(`revoke ${WORKER_ROLE} from ${TEST_ROLES.app}`);
    }
    try {
      expect((await running.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await running.close();
    }
  });
});
