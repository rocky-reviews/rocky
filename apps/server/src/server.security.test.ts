import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLocalKek } from "@rocky-reviews/crypto";
import {
  pullRequestPayload,
  signedDelivery,
  TEST_APP_ID,
  TEST_WEBHOOK_SECRET as WEBHOOK_SECRET,
  testAppKeys,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "./config.js";
import { HSTS } from "./security/headers.js";
import { startServer, type RunningServer } from "./server.js";

/** P7-3 (ADR 0025): startServer wires headers, rate limits, the trusted proxy and the web app. */

const BASE_ENV = {
  DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
  HOST: "127.0.0.1",
  PORT: "0",
};
const LOGIN = {
  GITHUB_APP_CLIENT_ID: "Iv23liTestClient01",
  GITHUB_APP_CLIENT_SECRET: "test-only-client-secret-0123456789abcdef",
  ROCKY_KEK_KEYS: `v1=${generateLocalKek()}`,
};
const PRODUCTION = {
  ...BASE_ENV,
  ...LOGIN,
  NODE_ENV: "production",
  GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  GITHUB_APP_ID: "123456",
  // H4-1 (ADR 0033): production also needs the app's key for the repository access check.
  GITHUB_APP_PRIVATE_KEY: testAppKeys().privateKeyPem,
  ROCKY_PUBLIC_URL: "https://rocky.example.com",
  ROCKY_SESSION_SECRET: "s".repeat(40),
};

const capture = () => {
  const lines: string[] = [];
  const log = createLogger("server-security-test", {
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  return { log, lines };
};

let running: RunningServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("startServer security wiring (P7-3)", () => {
  it("rate-limits login starts by default (limits from ROCKY_RATE_LIMIT_*)", async () => {
    const { log } = capture();
    running = await startServer(
      { ...BASE_ENV, ...LOGIN, ROCKY_RATE_LIMIT_AUTH_LOGIN: "1/60" },
      log,
    );
    // The database is unreachable, so the first start fails with 500; it still counts.
    await running.app.inject({ url: "/auth/github/login" });
    const limited = await running.app.inject({ url: "/auth/github/login" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
  });

  it("rate-limits the webhook receiver by default", async () => {
    const { log } = capture();
    running = await startServer(
      { ...BASE_ENV, GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, ROCKY_RATE_LIMIT_WEBHOOK_IP: "1/60" },
      log,
    );
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    await running.app.inject({ method: "POST", url: "/webhooks/github", payload: "x" });
    const limited = await running.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: d.headers,
      payload: d.body,
    });
    expect(limited.statusCode).toBe(429);
  });

  it("webhooks: GITHUB_APP_ID keeps another app's forged deliveries out of our bucket", async () => {
    const { log } = capture();
    running = await startServer(
      {
        ...BASE_ENV,
        GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
        GITHUB_APP_ID: String(TEST_APP_ID),
        ROCKY_RATE_LIMIT_WEBHOOK_IP: "1/60",
      },
      log,
    );
    for (let i = 0; i < 3; i += 1) {
      const forged = signedDelivery("pull_request", pullRequestPayload("opened"), {
        secret: "attacker-secret-that-is-long-enough-000000",
        hookTarget: { type: "integration", id: "999" },
      });
      await running.app.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: forged.headers,
        payload: forged.body,
      });
    }
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    const genuine = await running.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: d.headers,
      payload: d.body,
    });
    // Not rate limited (the database is unreachable here, so the inbox answers 503).
    expect(genuine.statusCode).not.toBe(429);
  });

  it("logs the trusted-proxy mode at boot, never an address", async () => {
    const { log, lines } = capture();
    running = await startServer({ ...BASE_ENV, ROCKY_TRUST_PROXY: "xff:2" }, log);
    const boot = lines.find((l) => l.includes('"trustProxy"'));
    expect(boot).toBeDefined();
    expect(JSON.parse(boot ?? "{}")).toMatchObject({ trustProxy: "xff:2" });
  });

  it("refuses ROCKY_TRUST_PROXY=none on Fly.io", async () => {
    const { log } = capture();
    await expect(
      startServer({ ...PRODUCTION, FLY_APP_NAME: "rocky", ROCKY_TRUST_PROXY: "none" }, log),
    ).rejects.toThrow(/refused on Fly.io/);
  });

  it("refuses a malformed limit or proxy setting at boot", async () => {
    const { log } = capture();
    await expect(
      startServer({ ...BASE_ENV, ROCKY_RATE_LIMIT_AUTH_LOGIN: "lots" }, log),
    ).rejects.toThrow(ConfigError);
    await expect(startServer({ ...BASE_ENV, ROCKY_TRUST_PROXY: "fly" }, log)).rejects.toThrow(
      /FLY_APP_NAME/,
    );
  });

  it("production: ROCKY_TRUST_PROXY must be chosen; then HSTS is on every response", async () => {
    const { log } = capture();
    await expect(startServer(PRODUCTION, log)).rejects.toThrow(/ROCKY_TRUST_PROXY/);
    running = await startServer({ ...PRODUCTION, ROCKY_TRUST_PROXY: "none" }, log);
    for (const url of ["/healthz", "/api/session", "/nope"]) {
      const res = await running.app.inject({ url });
      expect(res.headers["strict-transport-security"], url).toBe(HSTS);
    }
  });

  it("development: no HSTS (http on loopback)", async () => {
    const { log } = capture();
    running = await startServer(BASE_ENV, log);
    const res = await running.app.inject({ url: "/healthz" });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves the built web app from ROCKY_WEB_DIR, and refuses a bad one", async () => {
    const { log } = capture();
    const root = mkdtempSync(join(tmpdir(), "rocky-web-"));
    dirs.push(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><html><head><script type="module" src="/assets/a.js"></script></head><body></body></html>',
    );
    writeFileSync(join(root, "assets", "a.js"), "1");
    await expect(
      startServer({ ...BASE_ENV, ROCKY_WEB_DIR: join(root, "missing") }, log),
    ).rejects.toThrow(ConfigError);
    running = await startServer({ ...BASE_ENV, ROCKY_WEB_DIR: root }, log);
    const res = await running.app.inject({ url: "/inbox" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
  });
});
