import {
  pullRequestPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
} from "@rocky-reviews/forge-github/testing";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP_ROLE, LIFECYCLE_ROLE, WORKER_ROLE } from "@rocky-reviews/db";
import { createLogger } from "@rocky-reviews/log";
import {
  CONTAINER_TIMEOUT_MS,
  startPostgres,
  TEST_ROLES,
  type TestPostgres,
  ignoreIdleError,
} from "@rocky-reviews/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError } from "./config.js";
import { ServerLoginError, startServer, type RunningServer } from "./server.js";

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
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
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
      const observer = new pg.Client({ connectionString: pgs.superUrl }).on(
        "error",
        ignoreIdleError,
      );
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
 * Review rounds 4 and 5: the internet-facing server must never hold more than `rocky_app`'s
 * privileges. Round 4 refused members of `rocky_worker`; round 5 replaces that probe with an
 * allow-list (L28): the session and current user must be plain logins whose only membership is
 * `rocky_app`, own nothing, and be no member, by any grant option, of the worker, lifecycle,
 * retention or owner roles. Each case below booted under the round-4 probe.
 */
describe("the server's database login (review rounds 4 and 5)", () => {
  const env = (url: string) => ({ DATABASE_URL: url, HOST: "127.0.0.1", PORT: "0" });
  const passwordOf = (url: string) => decodeURIComponent(new URL(url).password);
  const loginUrl = (name: string) => {
    const url = new URL(pgs.appUrl);
    url.username = name;
    url.password = `${name}-only`;
    return url.toString();
  };
  /** A login role made by the superuser: `grants` run with the role name substituted for %. */
  const makeLogin = async (name: string, attributes: string, grants: string[]) => {
    await superuser.query(`create role ${name} login ${attributes} password '${name}-only'`);
    for (const grant of grants) await superuser.query(grant.replaceAll("%", name));
    return loginUrl(name);
  };

  const logins: Record<string, () => string> = {};
  beforeAll(async () => {
    const bypass = await makeLogin("rocky_bypass_test", "bypassrls", ["grant rocky_app to %"]);
    const setOnly = await makeLogin("rocky_set_only_test", "", [
      "grant rocky_app to %",
      `grant ${WORKER_ROLE} to % with inherit false, set true`,
    ]);
    const lifecycle = await makeLogin("rocky_lifecycle_member_test", "", [
      "grant rocky_app to %",
      `grant ${LIFECYCLE_ROLE} to %`,
    ]);
    const asApp = new URL(pgs.workerUrl);
    asApp.searchParams.set("options", "-c role=rocky_app");
    Object.assign(logins, {
      bypass: () => bypass,
      setOnly: () => setOnly,
      lifecycle: () => lifecycle,
      workerAsApp: () => asApp.toString(),
    });
  });

  it.each([
    ["the worker login", () => pgs.workerUrl, "session_user:forbidden_role"],
    ["a superuser", () => pgs.superUrl, "session_user:privileged"],
    [
      "the migrator (owner, CREATEROLE, ADMIN-only grants)",
      () => pgs.migratorUrl,
      "session_user:owner",
    ],
    ["a BYPASSRLS login", () => logins["bypass"]!(), "session_user:privileged"],
    [
      "a SET-only (inherit false) grant of rocky_worker",
      () => logins["setOnly"]!(),
      "session_user:forbidden_role",
    ],
    [
      "the worker login with options=-c role=rocky_app",
      () => logins["workerAsApp"]!(),
      "session_user:membership",
    ],
    ["a member of rocky_lifecycle", () => logins["lifecycle"]!(), "session_user:forbidden_role"],
  ])("refuses to start on %s, before listening", async (_name, url, refusal) => {
    const { log, out } = capture();
    const error = await startServer(env(url()), log).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerLoginError);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ServerLoginError).refusals).toContain(refusal);
    expect((error as Error).message).toContain(APP_ROLE);
    expect(out.find((l) => l["msg"] === "server listening")).toBeUndefined();
    expect(out.find((l) => l["msg"] === "database login refused")).toBeDefined();
    // Neither the connection string nor its host, login or password reach the message or the log.
    const { host, username } = new URL(url());
    // (The container superuser's password is "test", too short to search for.)
    const password = passwordOf(url());
    const secrets = [
      url(),
      `${username}:`,
      `@${host}`,
      ...(password.length >= 8 ? [password] : []),
    ];
    for (const secret of secrets) {
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(out)).not.toContain(secret);
    }
  });

  it("refuses a login that reaches rocky_worker only through rocky_app itself (indirect membership)", async () => {
    const { log } = capture();
    await superuser.query(`grant ${WORKER_ROLE} to ${APP_ROLE}`);
    try {
      const error = await startServer(env(pgs.appUrl), log).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerLoginError);
      // Its own memberships are still exactly rocky_app; since review round 6 the reached set
      // (any path) must be exactly rocky_app too, and the MEMBER probe names the role.
      expect((error as ServerLoginError).refusals).toEqual([
        "session_user:membership",
        "session_user:forbidden_role",
        "current_user:membership",
        "current_user:forbidden_role",
      ]);
    } finally {
      await superuser.query(`revoke ${WORKER_ROLE} from ${APP_ROLE}`);
    }
  });

  it("the refused logins really hold what the check is about (the fixtures are not vacuous)", async () => {
    const probe = async (url: string, sql: string) => {
      const client = new pg.Client({ connectionString: url }).on("error", ignoreIdleError);
      await client.connect();
      try {
        return (await client.query<{ ok: boolean }>(sql)).rows[0]?.ok;
      } finally {
        await client.end();
      }
    };
    // S1: a SET-only grant reaches the worker's functions after `set role`.
    expect(
      await probe(
        logins["setOnly"]!(),
        `select pg_has_role(current_user, '${WORKER_ROLE}', 'USAGE') = false
            and pg_has_role(current_user, '${WORKER_ROLE}', 'SET') as ok`,
      ),
    ).toBe(true);
    // S2: current_user looks like the application role, session_user is the worker login.
    expect(
      await probe(
        logins["workerAsApp"]!(),
        `select current_user = 'rocky_app' and session_user = '${TEST_ROLES.worker}' as ok`,
      ),
    ).toBe(true);
    // B1: the migrator's grant of rocky_worker is ADMIN-only, invisible to USAGE.
    expect(
      await probe(
        pgs.migratorUrl,
        `select pg_has_role(current_user, '${WORKER_ROLE}', 'USAGE') = false
            and pg_has_role(current_user, '${WORKER_ROLE}', 'MEMBER') as ok`,
      ),
    ).toBe(true);
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
    expect(fatal?.["err"]).toMatch(/DATABASE_URL must log in as a plain member of rocky_app/);
    expect(result.stdout).not.toContain("server listening");
    expect(result.stdout + result.stderr).not.toContain(passwordOf(pgs.workerUrl));
  }, 30_000);

  it("starts on the application login", async () => {
    const { log, out } = capture();
    const running = await startServer(env(pgs.appUrl), log);
    try {
      expect(out.find((l) => l["msg"] === "server listening")).toBeDefined();
      expect(out.find((l) => l["msg"] === "database login refused")).toBeUndefined();
      expect((await running.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await running.close();
    }
  });

  it("checks new connections only: one opened after a grant is refused; open ones keep it until they are recycled (S4)", async () => {
    const { log, out } = capture();
    const running = await startServer(env(pgs.appUrl), log);
    const held: pg.PoolClient[] = [];
    try {
      expect((await running.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect(running.pool.idleCount).toBeGreaterThan(0);
      await superuser.query(`grant ${WORKER_ROLE} to ${TEST_ROLES.app}`);
      // Take every open connection, so the next checkout has to open a new one.
      while (running.pool.idleCount > 0) held.push(await running.pool.connect());
      // The bounded window, stated honestly: a grant takes effect at once on a connection that
      // is already open; the hook does not see it. maxLifetimeSeconds (300) recycles it.
      const already = await held[0]!.query<{ worker: boolean }>(
        `select pg_has_role(current_user, '${WORKER_ROLE}', 'USAGE') as worker`,
      );
      expect(already.rows[0]?.worker).toBe(true);
      const opened = running.pool.totalCount;
      await expect(running.pool.connect()).rejects.toBeInstanceOf(ServerLoginError);
      expect(running.pool.totalCount).toBe(opened);
      expect(out.find((l) => l["msg"] === "database login refused")).toBeDefined();
    } finally {
      for (const client of held) client.release();
      await superuser.query(`revoke ${WORKER_ROLE} from ${TEST_ROLES.app}`);
    }
    try {
      expect((await running.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await running.close();
    }
  });
});
