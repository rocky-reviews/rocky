import { WEBHOOK_INBOX_QUERY_TIMEOUT_MS } from "@rocky-reviews/db";
import { createLogger } from "@rocky-reviews/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config.js";
import {
  createServerPool,
  POOL_TIMEOUTS,
  ServerLoginError,
  startServer,
  type RunningServer,
} from "./server.js";
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
      // Review round 5, S4: the login check runs on new connections only; recycling every
      // connection after 5 minutes bounds how long a grant made after connecting can last.
      expect(pool.options).toMatchObject({
        connectionTimeoutMillis: 2_000,
        maxLifetimeSeconds: 300,
      });
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

describe("the pool's login check fails closed (review round 5)", () => {
  type Hook = (client: unknown) => Promise<void>;
  const hookOf = (pool: { options: unknown }): Hook =>
    (pool.options as { onConnect: Hook }).onConnect;
  const plain = (who: string) => ({
    who,
    privileged: false,
    groups: ["rocky_app"],
    owner: false,
    reaches: false,
  });
  const clientAnswering = (answer: () => Promise<{ rows: unknown[] }>) => ({ query: answer });

  it.each([
    ["no rows", () => Promise.resolve({ rows: [] })],
    ["one row", () => Promise.resolve({ rows: [plain("session_user")] })],
    [
      "a null where a boolean belongs",
      () =>
        Promise.resolve({
          rows: [plain("session_user"), { ...plain("current_user"), owner: null }],
        }),
    ],
    [
      "groups that are not an array",
      () =>
        Promise.resolve({
          rows: [plain("session_user"), { ...plain("current_user"), groups: "{}" }],
        }),
    ],
    [
      "a second membership",
      () =>
        Promise.resolve({
          rows: [plain("session_user"), { ...plain("current_user"), groups: ["rocky_app", "x"] }],
        }),
    ],
    [
      "a query error (its message never logged)",
      () =>
        Promise.reject(
          Object.assign(new Error("permission denied for user=rocky_app_dev"), { code: "42501" }),
        ),
    ],
  ])("refuses on %s", async (_case, answer) => {
    const { log, lines } = capture();
    const pool = createServerPool(BASE_ENV.DATABASE_URL, log);
    try {
      await expect(hookOf(pool)(clientAnswering(answer))).rejects.toBeInstanceOf(ServerLoginError);
      expect(lines.find((l) => l["msg"] === "database login refused")).toBeDefined();
      expect(JSON.stringify(lines)).not.toMatch(/permission denied|rocky_app_dev/);
    } finally {
      await pool.end();
    }
  });

  it("accepts two plain rocky_app rows", async () => {
    const { log, lines } = capture();
    const pool = createServerPool(BASE_ENV.DATABASE_URL, log);
    try {
      const answer = () =>
        Promise.resolve({ rows: [plain("session_user"), plain("current_user")] });
      await expect(hookOf(pool)(clientAnswering(answer))).resolves.toBeUndefined();
      expect(lines).toHaveLength(0);
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

  it("boots without the database and says so by code (review round 4)", async () => {
    const { log, lines } = capture();
    running = await startServer(BASE_ENV, log);
    expect(lines.find((l) => l["msg"] === "database unreachable at boot")).toMatchObject({
      errorCode: "ECONNREFUSED",
    });
    expect(lines.find((l) => l["msg"] === "database login refused")).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain("nothing@127.0.0.1");
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

describe("GitHub App setup at boot (P3-1)", () => {
  const SETUP_ENV = {
    ...BASE_ENV,
    GITHUB_APP_SETUP: "true",
    ROCKY_PUBLIC_URL: "http://127.0.0.1:4310",
    GITHUB_APP_CREDENTIALS_FILE: "/nonexistent-rocky-test/github-app.env",
  };

  it("prints the one-time setup URL to the terminal only, never to the logger", async () => {
    const { log, lines } = capture();
    const printed: string[] = [];
    running = await startServer(SETUP_ENV, log, { announce: (text) => printed.push(text) });
    expect(running.githubAppSetup).toBe(true);
    expect(printed).toHaveLength(1);
    const token = /\/setup\/github-app\?token=([A-Za-z0-9_-]{43})/.exec(printed[0]!)?.[1];
    expect(token).toBeDefined();
    expect(printed[0]).toContain("http://127.0.0.1:4310/setup/github-app?token=");
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(lines.find((l) => l["msg"] === "server listening")).toMatchObject({
      githubAppSetup: true,
    });
    const res = await running.app.inject({
      method: "GET",
      url: `/setup/github-app?token=${token}`,
    });
    expect(res.statusCode).toBe(303);
  });

  it("generates a different token on every boot", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { log } = capture();
      const server = await startServer(SETUP_ENV, log, { announce: (t) => tokens.push(t) });
      await server.close();
    }
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("registers no setup route when not requested", async () => {
    const { log } = capture();
    const printed: string[] = [];
    running = await startServer(BASE_ENV, log, { announce: (t) => printed.push(t) });
    expect(running.githubAppSetup).toBe(false);
    expect(printed).toHaveLength(0);
    const res = await running.app.inject({ method: "GET", url: "/setup/github-app" });
    expect(res.statusCode).toBe(404);
  });
});
