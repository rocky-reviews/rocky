import { randomBytes } from "node:crypto";
import type { KeyWrapper } from "@rocky-reviews/crypto";
import { createGitHubLogin, githubEndpoints } from "@rocky-reviews/forge-github";
import { createLogger } from "@rocky-reviews/log";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createRateLimits, DEFAULT_RATE_LIMITS } from "../security/rate-limit.js";
import { authRateLimit } from "../security/route-limits.js";
import { CSRF_HEADER, csrfTokenFor, randomToken } from "./cookies.js";
import type { AuthDeps } from "./routes.js";

/**
 * P7-3 (ADR 0025): login brute force and state flooding. The auth scope is limited per client
 * address through the P7-1 seam `AuthDeps.rateLimit`; a limited login start never writes a
 * `login_attempts` row. No database: these paths are refused before one would be needed.
 */

const PUBLIC = new URL("https://rocky.example.com/");

const setup = (max = 2) => {
  const lines: string[] = [];
  const log = createLogger("auth-limit-test", {
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const createLoginAttempt = vi.fn(async () => undefined);
  const findSession = vi.fn(async () => null);
  const db = {
    withOrg: () => Promise.reject(new Error("not used")),
    sessions: { createLoginAttempt, findSession },
  } as unknown as AuthDeps["db"];
  const rule = { max, windowMs: 600_000 };
  const secret = randomBytes(32);
  const limits = createRateLimits({
    rules: {
      ...DEFAULT_RATE_LIMITS,
      "auth.login": rule,
      "auth.callback": rule,
      "auth.logout": rule,
      "auth.session": rule,
    },
    trustProxy: { kind: "none" },
  });
  const app = buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    auth: {
      publicUrl: PUBLIC,
      cookieSecure: true,
      secret,
      login: createGitHubLogin({
        endpoints: githubEndpoints({}),
        clientId: "Iv23liTestClient01",
        clientSecret: "test-only-client-secret-0123456789abcdef",
        appId: 1,
      }),
      db,
      keys: {} as KeyWrapper,
      rateLimit: authRateLimit(limits, { secret, cookieSecure: true }),
    },
  });
  return { app, lines, createLoginAttempt, findSession, secret };
};

const from = (remoteAddress: string) => ({ remoteAddress });

describe("auth rate limits (P7-3)", () => {
  it("login: after the limit, 429 and no login_attempts row (state flooding)", async () => {
    const { app, createLoginAttempt } = setup(2);
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({ url: "/auth/github/login", ...from("198.51.100.1") });
      expect(res.statusCode).toBe(302);
    }
    const limited = await app.inject({ url: "/auth/github/login", ...from("198.51.100.1") });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("600");
    expect(limited.headers["set-cookie"]).toBeUndefined();
    expect(limited.headers["location"]).toBeUndefined();
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(createLoginAttempt).toHaveBeenCalledTimes(2);
    // Another client still signs in.
    expect(
      (await app.inject({ url: "/auth/github/login", ...from("198.51.100.2") })).statusCode,
    ).toBe(302);
  });

  it("callback: brute-forcing states or codes is limited per address", async () => {
    const { app } = setup(2);
    const callback = () =>
      app.inject({
        url: `/auth/github/callback?code=abc&state=${"A".repeat(43)}`,
        ...from("198.51.100.3"),
      });
    expect((await callback()).statusCode).toBe(400);
    expect((await callback()).statusCode).toBe(400);
    expect((await callback()).statusCode).toBe(429);
  });

  it("logout and the session API are limited too, each in its own bucket", async () => {
    const { app, findSession, secret } = setup(2);
    // A well-formed cookie for a session that does not exist: CSRF passes, the lookup finds none.
    const token = randomToken();
    const logout = () =>
      app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: {
          origin: PUBLIC.origin,
          "sec-fetch-site": "same-origin",
          cookie: `__Host-rocky_session=${token}`,
          [CSRF_HEADER]: csrfTokenFor(secret, token),
        },
        ...from("198.51.100.4"),
      });
    const session = () => app.inject({ url: "/api/session", ...from("198.51.100.4") });
    for (let i = 0; i < 2; i += 1) expect((await session()).statusCode).toBe(401);
    expect((await session()).statusCode).toBe(429);
    expect((await logout()).statusCode).toBe(204);
    expect((await logout()).statusCode).toBe(204);
    expect((await logout()).statusCode).toBe(429);
    // The limited logout never reached the session lookup.
    expect(findSession).toHaveBeenCalledTimes(2);
  });

  it("logout counts per session, so one client on a shared address cannot stop others signing out", async () => {
    const { app, secret } = setup(2);
    const logout = (token: string, csrf = csrfTokenFor(secret, token)) =>
      app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: {
          origin: PUBLIC.origin,
          "sec-fetch-site": "same-origin",
          cookie: `__Host-rocky_session=${token}`,
          [CSRF_HEADER]: csrf,
        },
        ...from("198.51.100.9"),
      });
    const noisy = randomToken();
    for (let i = 0; i < 2; i += 1) expect((await logout(noisy)).statusCode).toBe(204);
    expect((await logout(noisy)).statusCode).toBe(429);
    // Another person behind the same NAT still signs out.
    expect((await logout(randomToken())).statusCode).toBe(204);
  });

  it("a cookie without its CSRF token gets no bucket of its own (refused before the limiter)", async () => {
    const { app } = setup(1);
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        origin: PUBLIC.origin,
        "sec-fetch-site": "same-origin",
        cookie: `__Host-rocky_session=${randomToken()}`,
        [CSRF_HEADER]: randomToken(),
      },
      ...from("198.51.100.10"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("a spoofed X-Forwarded-For does not get a fresh bucket when no proxy is trusted", async () => {
    const { app } = setup(1);
    expect(
      (await app.inject({ url: "/auth/github/login", ...from("198.51.100.5") })).statusCode,
    ).toBe(302);
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        url: "/auth/github/login",
        headers: { "x-forwarded-for": `10.0.0.${i}`, "fly-client-ip": `10.0.1.${i}` },
        ...from("198.51.100.5"),
      });
      expect(res.statusCode).toBe(429);
    }
  });

  it("the 429 carries the security headers and no-store, and the log has no address", async () => {
    const { app, lines } = setup(1);
    await app.inject({ url: "/auth/github/login", ...from("203.0.113.66") });
    const limited = await app.inject({ url: "/auth/github/login", ...from("203.0.113.66") });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.headers["x-frame-options"]).toBe("DENY");
    expect(limited.headers["x-content-type-options"]).toBe("nosniff");
    const text = lines.join("\n");
    expect(text).toContain('"scope":"auth.login"');
    expect(text).not.toContain("203.0.113.66");
  });
});
