import { createLogger } from "@rocky-reviews/log";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../config.js";
import {
  createRateLimits,
  DEFAULT_RATE_LIMITS,
  MemoryRateLimitStore,
  RATE_LIMIT_SCOPES,
  rateLimitRulesFromEnv,
  type RateLimitStore,
} from "./rate-limit.js";

/** P7-3 (ADR 0025): the limiter every limited route uses (auth, webhooks, and Ask in P9). */

const capture = () => {
  const lines: string[] = [];
  const log = createLogger("rate-limit-test", {
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  return { log, lines };
};

describe("MemoryRateLimitStore (fixed window per key)", () => {
  it("counts per key and starts a new window when the old one ends", async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 10 });
    expect(await store.hit("a", 1_000, 0)).toEqual({ count: 1, resetAt: 1_000 });
    expect(await store.hit("a", 1_000, 500)).toEqual({ count: 2, resetAt: 1_000 });
    expect(await store.hit("b", 1_000, 500)).toEqual({ count: 1, resetAt: 1_500 });
    expect(await store.hit("a", 1_000, 1_000)).toEqual({ count: 1, resetAt: 2_000 });
  });

  it("memory is bounded: expired windows go first, then the oldest key", async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 3 });
    await store.hit("old", 100, 0);
    await store.hit("k1", 10_000, 50);
    await store.hit("k2", 10_000, 60);
    await store.hit("k3", 10_000, 200); // "old" has expired: swept
    expect(store.size).toBe(3);
    await store.hit("k4", 10_000, 300); // full, nothing expired: the oldest (k1) goes
    expect(store.size).toBe(3);
    expect(await store.hit("k2", 10_000, 400)).toEqual({ count: 2, resetAt: 10_060 });
    expect(await store.hit("k1", 10_000, 400)).toEqual({ count: 1, resetAt: 10_400 });
    for (let i = 0; i < 1_000; i += 1) await store.hit(`flood-${i}`, 10_000, 500);
    expect(store.size).toBe(3);
  });
});

describe("createRateLimits on a route", () => {
  const build = (store?: RateLimitStore) => {
    const { log, lines } = capture();
    let now = 0;
    const limits = createRateLimits({
      rules: { ...DEFAULT_RATE_LIMITS, ask: { max: 2, windowMs: 60_000 } },
      trustProxy: { kind: "none" },
      now: () => now,
      ...(store === undefined ? {} : { store }),
    });
    const handled = vi.fn();
    // A test-only route standing in for Ask (P9): keyed by member, not by address.
    const app = Fastify({ loggerInstance: log });
    app.post("/ask", async (request, reply) => {
      const member = String(request.headers["x-member"]);
      if (!(await limits.consume(request, reply, "ask", member))) return reply;
      handled();
      return { ok: true };
    });
    return { app, lines, handled, advance: (ms: number) => (now += ms) };
  };

  it("429 with Retry-After and a fixed body once over the limit; the handler never runs", async () => {
    const { app, handled } = build();
    const ask = () => app.inject({ method: "POST", url: "/ask", headers: { "x-member": "m1" } });
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    const limited = await ask();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(handled).toHaveBeenCalledTimes(2);
  });

  it("keys are independent (another member is not limited) and the window ends", async () => {
    const { app, advance } = build();
    const ask = (m: string) =>
      app.inject({ method: "POST", url: "/ask", headers: { "x-member": m } });
    for (let i = 0; i < 3; i += 1) await ask("m1");
    expect((await ask("m1")).statusCode).toBe(429);
    expect((await ask("m2")).statusCode).toBe(200);
    advance(30_000);
    const later = await ask("m1");
    expect(later.statusCode).toBe(429);
    expect(later.headers["retry-after"]).toBe("30");
    advance(30_000);
    expect((await ask("m1")).statusCode).toBe(200);
  });

  it("logs scope, a hashed key and counts, once per key and window; never the key itself", async () => {
    const { app, lines } = build();
    const secretKey = "198.51.100.77-member-secret";
    for (let i = 0; i < 6; i += 1) {
      await app.inject({ method: "POST", url: "/ask", headers: { "x-member": secretKey } });
    }
    const limited = lines.filter((l) => l.includes('"rate limited"'));
    expect(limited).toHaveLength(1);
    const entry = JSON.parse(limited[0] ?? "{}") as { rateLimit?: Record<string, unknown> };
    expect(entry.rateLimit).toEqual({
      scope: "ask",
      keyHash: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
      count: 3,
      limit: 2,
      windowSeconds: 60,
    });
    expect(lines.join("\n")).not.toContain(secretKey);
    expect(lines.join("\n")).not.toContain("198.51.100.77");
  });

  it("fails closed: a store that fails answers 503 and the handler never runs", async () => {
    const store: RateLimitStore = { hit: () => Promise.reject(new Error("down")) };
    const { app, handled, lines } = build(store);
    const res = await app.inject({ method: "POST", url: "/ask", headers: { "x-member": "m1" } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable" });
    expect(handled).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("down");
  });

  it("the store never sees the raw key (a shared store would otherwise hold addresses)", async () => {
    const keys: string[] = [];
    const store: RateLimitStore = {
      hit: (key) => {
        keys.push(key);
        return Promise.resolve({ count: 1, resetAt: 60_000 });
      },
    };
    const { app } = build(store);
    await app.inject({ method: "POST", url: "/ask", headers: { "x-member": "203.0.113.5" } });
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("203.0.113.5");
    expect(keys[0]).toMatch(/^ask:/);
  });

  it("clientKey uses the trusted-proxy rule and IPv6 /64 buckets", async () => {
    const limits = createRateLimits({
      rules: DEFAULT_RATE_LIMITS,
      trustProxy: { kind: "none" },
    });
    const app = Fastify({ logger: false });
    app.get("/k", async (request) => ({ key: limits.clientKey(request) }));
    const res = await app.inject({
      url: "/k",
      headers: { "x-forwarded-for": "198.51.100.1" },
      remoteAddress: "2001:db8:1:2::77",
    });
    expect(res.json()).toEqual({ key: "2001:db8:1:2::/64" });
  });
});

describe("rateLimitRulesFromEnv", () => {
  it("defaults cover every scope with a positive limit and window", () => {
    const rules = rateLimitRulesFromEnv({});
    expect(Object.keys(rules).sort()).toEqual([...RATE_LIMIT_SCOPES].sort());
    for (const rule of Object.values(rules)) {
      expect(rule.max).toBeGreaterThan(0);
      expect(rule.windowMs).toBeGreaterThan(0);
    }
  });

  it("ROCKY_RATE_LIMIT_<SCOPE>=<max>/<seconds> overrides one scope", () => {
    const rules = rateLimitRulesFromEnv({ ROCKY_RATE_LIMIT_AUTH_LOGIN: "5/60" });
    expect(rules["auth.login"]).toEqual({ max: 5, windowMs: 60_000 });
    expect(rules["auth.callback"]).toEqual(DEFAULT_RATE_LIMITS["auth.callback"]);
  });

  it("refuses malformed values and unknown scopes (no silent fallback to unlimited)", () => {
    for (const value of ["", "0/60", "5/0", "5", "5/60/1", "-1/60", "5/86401", "1e3/60", "x/60"]) {
      expect(() => rateLimitRulesFromEnv({ ROCKY_RATE_LIMIT_WEBHOOK_IP: value }), value).toThrow(
        ConfigError,
      );
    }
    expect(() => rateLimitRulesFromEnv({ ROCKY_RATE_LIMIT_AUTH_LOGINN: "5/60" })).toThrow(
      ConfigError,
    );
  });
});
