import { WEBHOOK_INBOX_QUERY_TIMEOUT_MS } from "@rocky-reviews/db";
import { createLogger } from "@rocky-reviews/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config.js";
import { createServerPool, POOL_TIMEOUTS, startServer, type RunningServer } from "./server.js";
import { INBOX_RECORD_TIMEOUT_MS } from "./webhooks.js";

const GOOD = "0123456789abcdef0123456789abcdef0123456789abcdef";
// Unroutable on purpose: booting must not need the database.
const BASE_ENV = {
  DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
  HOST: "127.0.0.1",
  PORT: "0",
};

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger("server-test", {
    destination: {
      write: (c: string) => void lines.push(JSON.parse(c) as Record<string, unknown>),
    },
  });
  return { log, lines };
};

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("createServerPool (review round 1, items 1 and 2)", () => {
  it("bounds connect time only; no pool-wide statement cap (review round 2, N1)", async () => {
    const { log } = capture();
    const pool = createServerPool(BASE_ENV.DATABASE_URL, log);
    try {
      expect(pool.options).toMatchObject({ connectionTimeoutMillis: 2_000 });
      expect(pool.options).not.toHaveProperty("statement_timeout");
      expect(pool.options).not.toHaveProperty("query_timeout");
      // connect + insert bound + margin stay under the route guard, and that under GitHub's 10 s.
      expect(POOL_TIMEOUTS.connectionTimeoutMillis + WEBHOOK_INBOX_QUERY_TIMEOUT_MS).toBeLessThan(
        INBOX_RECORD_TIMEOUT_MS,
      );
      expect(INBOX_RECORD_TIMEOUT_MS).toBeLessThan(10_000);
    } finally {
      await pool.end();
    }
  });

  it("survives an idle-client error and logs only its code", async () => {
    const { log, lines } = capture();
    const pool = createServerPool(BASE_ENV.DATABASE_URL, log);
    try {
      expect(pool.listenerCount("error")).toBe(1);
      const error = Object.assign(
        new Error("terminating connection due to administrator command (user=rocky_app_dev)"),
        { code: "57P01" },
      );
      // Without a listener, EventEmitter throws an unhandled 'error' (process crash).
      expect(() => pool.emit("error", error, undefined)).not.toThrow();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ msg: "postgres idle client error", errorCode: "57P01" });
      expect(JSON.stringify(lines)).not.toMatch(/administrator|rocky_app_dev/);
    } finally {
      await pool.end();
    }
  });
});

describe("startServer (review round 1, item 5)", () => {
  it("logs webhooks: false when no secret is configured outside production", async () => {
    const { log, lines } = capture();
    running = await startServer(BASE_ENV, log);
    expect(running.webhooks).toBe(false);
    expect(lines.find((l) => l["msg"] === "server listening")).toMatchObject({ webhooks: false });
    const res = await running.app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: "{}",
    });
    expect(res.statusCode).toBe(404);
  });

  it("logs webhooks: true and serves the route when a secret is configured", async () => {
    const { log, lines } = capture();
    running = await startServer({ ...BASE_ENV, GITHUB_WEBHOOK_SECRET: GOOD }, log);
    expect(running.webhooks).toBe(true);
    expect(lines.find((l) => l["msg"] === "server listening")).toMatchObject({ webhooks: true });
    const res = await running.app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(lines)).not.toContain(GOOD);
  });

  it("refuses to start on Fly.io without a secret even when NODE_ENV is unset", async () => {
    const { log, lines } = capture();
    await expect(startServer({ ...BASE_ENV, FLY_APP_NAME: "rocky-cloud" }, log)).rejects.toThrow(
      ConfigError,
    );
    expect(lines.find((l) => l["msg"] === "server listening")).toBeUndefined();
  });
});

describe("shutdown (review round 2, S2)", () => {
  it("close() ends the pool and is idempotent: a second close does not end it twice", async () => {
    const { log } = capture();
    const server = await startServer(BASE_ENV, log);
    const end = vi.spyOn(server.pool, "end");
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await server.close();
    expect(end).toHaveBeenCalledTimes(1);
    expect(server.pool.ended).toBe(true);
    expect(server.pool.totalCount).toBe(0);
    expect(server.app.server.listening).toBe(false);
  });
});
