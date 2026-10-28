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

describe("MemoryRateLimitStore (fixed window per scope and key)", () => {
  it("counts per key and starts a new window when the old one ends", async () => {
    const store = new MemoryRateLimitStore({ maxKeysPerScope: 10 });
    expect(await store.hit("ask", "a", 1_000, 0)).toEqual({ count: 1, resetAt: 1_000 });
    expect(await store.hit("ask", "a", 1_000, 500)).toEqual({ count: 2, resetAt: 1_000 });
    expect(await store.hit("ask", "b", 1_000, 500)).toEqual({ count: 1, resetAt: 1_500 });
    expect(await store.hit("ask", "a", 1_000, 1_000)).toEqual({ count: 1, resetAt: 2_000 });
    // The same key in another scope is another counter.
    expect(await store.hit("auth.login", "a", 1_000, 1_000)).toEqual({ count: 1, resetAt: 2_000 });
  });

  it("peek reads the current window without counting", async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.peek("webhook.ip", "a", 0)).toBeUndefined();
    await store.hit("webhook.ip", "a", 1_000, 0);
    expect(await store.peek("webhook.ip", "a", 10)).toEqual({ count: 1, resetAt: 1_000 });
    expect(await store.peek("webhook.ip", "a", 20)).toEqual({ count: 1, resetAt: 1_000 });
    expect(await store.peek("webhook.ip", "a", 1_000)).toBeUndefined();
  });

  it("memory is bounded per scope: expired windows go first, then the oldest key", async () => {
    const store = new MemoryRateLimitStore({ maxKeysPerScope: 3 });
    await store.hit("ask", "old", 100, 0);
    await store.hit("ask", "k1", 100, 50);
    await store.hit("ask", "k2", 100, 60);
    await store.hit("ask", "k3", 100, 120); // "old" has expired: swept
    expect(store.size("ask")).toBe(3);
    await store.hit("ask", "k4", 100, 130); // full, nothing expired: the oldest (k1) goes
    expect(store.size("ask")).toBe(3);
    expect(await store.hit("ask", "k2", 100, 140)).toEqual({ count: 2, resetAt: 160 });
    expect(await store.hit("ask", "k1", 100, 140)).toEqual({ count: 1, resetAt: 240 });
    for (let i = 0; i < 1_000; i += 1) await store.hit("ask", `flood-${i}`, 100, 150);
    expect(store.size("ask")).toBe(3);
  });

  it("a flood of keys in one scope never evicts another scope's counters (Ask budget kept)", async () => {
    const store = new MemoryRateLimitStore({ maxKeysPerScope: 100 });
    for (let i = 0; i < 5; i += 1) await store.hit("ask", "member-1", 60_000, 0);
    await store.hit("webhook.installation", "github:7", 60_000, 0);
    // Many IPv6 /64s, each a fresh login key.
    for (let i = 0; i < 10_000; i += 1)
      await store.hit("auth.login", `2001:db8:${i}::/64`, 600_000, 1);
    expect(store.size("auth.login")).toBe(100);
    expect(await store.peek("ask", "member-1", 2)).toEqual({ count: 5, resetAt: 60_000 });
    expect(await store.peek("webhook.installation", "github:7", 2)).toEqual({
      count: 1,
      resetAt: 60_000,
    });
    expect(store.size()).toBe(102);
  });

  it("making room while full does not sweep the whole scope for every new key", async () => {
    const store = new MemoryRateLimitStore({ maxKeysPerScope: 2_000 });
    for (let i = 0; i < 2_000; i += 1) await store.hit("auth.login", `fill-${i}`, 600_000, 0);
    const started = performance.now();
    for (let i = 0; i < 20_000; i += 1) await store.hit("auth.login", `new-${i}`, 600_000, 1);
    // An O(n) walk per insert would be 40 million steps; this stays well under a second.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(store.size("auth.login")).toBe(2_000);
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
    const store: RateLimitStore = {
      hit: () => Promise.reject(new Error("down")),
      peek: () => Promise.reject(new Error("down")),
    };
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
      hit: (scope, key) => {
        keys.push(`${scope}:${key}`);
        return Promise.resolve({ count: 1, resetAt: 60_000 });
      },
      peek: () => Promise.resolve(undefined),
    };
    const { app } = build(store);
    await app.inject({ method: "POST", url: "/ask", headers: { "x-member": "203.0.113.5" } });
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("203.0.113.5");
    expect(keys[0]).toMatch(/^ask:[A-Za-z0-9_-]{43}$/);
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

describe("allows + spend (budgets only some outcomes use up)", () => {
  const build = (store?: RateLimitStore) => {
    const { log, lines } = capture();
    const limits = createRateLimits({
      rules: { ...DEFAULT_RATE_LIMITS, "webhook.ip": { max: 2, windowMs: 60_000 } },
      trustProxy: { kind: "none" },
      now: () => 0,
      ...(store === undefined ? {} : { store }),
    });
    const app = Fastify({ loggerInstance: log });
    // Stands in for the webhook receiver: only "bad" requests spend the budget.
    app.post("/hook", async (request, reply) => {
      if (!(await limits.allows(request, reply, "webhook.ip", "k"))) return reply;
      if (request.headers["x-bad"] === "1") {
        await limits.spend(request, "webhook.ip", "k");
        return reply.code(401).send({ error: "unauthenticated" });
      }
      return { ok: true };
    });
    return { app, lines };
  };

  it("good requests never spend it; bad ones do, and then everything is refused", async () => {
    const { app, lines } = build();
    const post = (bad: boolean) =>
      app.inject({ method: "POST", url: "/hook", headers: bad ? { "x-bad": "1" } : {} });
    for (let i = 0; i < 10; i += 1) expect((await post(false)).statusCode).toBe(200);
    expect((await post(true)).statusCode).toBe(401);
    expect((await post(true)).statusCode).toBe(401);
    const limited = await post(false);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(lines.filter((l) => l.includes('"rate limited"'))).toHaveLength(1);
  });

  it("fails closed when the store fails: allows answers 503, spend never throws", async () => {
    const store: RateLimitStore = {
      hit: () => Promise.reject(new Error("down")),
      peek: () => Promise.reject(new Error("down")),
    };
    const { app, lines } = build(store);
    const res = await app.inject({ method: "POST", url: "/hook" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable" });
    // spend alone (peek working, hit failing): the request keeps its own answer.
    const half: RateLimitStore = {
      hit: () => Promise.reject(new Error("down")),
      peek: () => Promise.resolve(undefined),
    };
    const other = build(half);
    const bad = await other.app.inject({ method: "POST", url: "/hook", headers: { "x-bad": "1" } });
    expect(bad.statusCode).toBe(401);
    expect(other.lines.join("\n")).toContain('"outcome":"store_failed"');
    expect(lines.join("\n")).not.toContain("down");
  });
});

describe("trusted proxy fallback warning", () => {
  it("fly/xff without their header: counts the peer, warns at most once a minute, no address", async () => {
    const { log, lines } = capture();
    let now = 0;
    const limits = createRateLimits({
      rules: DEFAULT_RATE_LIMITS,
      trustProxy: { kind: "xff", hops: 1 },
      now: () => now,
    });
    const app = Fastify({ loggerInstance: log });
    app.get("/k", async (request) => ({ key: limits.clientKey(request) }));
    const get = (headers: Record<string, string> = {}) =>
      app.inject({ url: "/k", headers, remoteAddress: "172.16.0.9" });
    expect((await get()).json()).toEqual({ key: "172.16.0.9" });
    expect((await get({ "x-forwarded-for": "garbage" })).json()).toEqual({ key: "172.16.0.9" });
    expect((await get({ "x-forwarded-for": "198.51.100.8" })).json()).toEqual({
      key: "198.51.100.8",
    });
    const warnings = () =>
      lines
        .filter((l) => l.includes('"proxy_header_fallback"'))
        .map((l) => (JSON.parse(l) as { rateLimit: Record<string, unknown> }).rateLimit);
    expect(warnings()).toEqual([
      { outcome: "proxy_header_fallback", trustProxy: "xff", reason: "missing", fallbacks: 1 },
    ]);
    now += 60_000;
    await get();
    expect(warnings()).toHaveLength(2);
    // The second warning counts the malformed one suppressed in between.
    expect(warnings()[1]).toMatchObject({ fallbacks: 2 });
    const text = lines.join("\n");
    expect(text).not.toContain("172.16.0.9");
    expect(text).not.toContain("198.51.100.8");
  });

  it("none never warns (the peer is the client by configuration)", async () => {
    const { log, lines } = capture();
    const limits = createRateLimits({ rules: DEFAULT_RATE_LIMITS, trustProxy: { kind: "none" } });
    const app = Fastify({ loggerInstance: log });
    app.get("/k", async (request) => ({ key: limits.clientKey(request) }));
    await app.inject({ url: "/k" });
    expect(lines.join("\n")).not.toContain("proxy_header_fallback");
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
