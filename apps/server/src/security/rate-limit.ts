import { createHmac, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ConfigError } from "../config.js";
import { addressKey, resolveClientAddress, type TrustProxy } from "./client-ip.js";

/**
 * Rate limits (P7-3, ADR 0025): fixed windows per scope and key. Every limited route goes
 * through `RateLimits.consume`: the auth routes and the webhook receiver today, Ask (P9) next.
 *
 * Keys are HMAC'd with a per-process secret before they reach the store or a log line, so
 * neither holds client addresses (or member ids) in clear. The store is in memory, per
 * instance, bounded; a shared store (Postgres) is the multi-instance follow-up and only has to
 * implement `RateLimitStore`.
 */

export const RATE_LIMIT_SCOPES = [
  "auth.login",
  "auth.callback",
  "auth.logout",
  "auth.session",
  "webhook.ip",
  "webhook.installation",
  "ask",
] as const;
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export interface RateLimitRule {
  readonly max: number;
  readonly windowMs: number;
}

const MINUTE = 60_000;

/**
 * Defaults. Login, callback and logout are per client address over the login cookie's lifetime
 * (10 minutes): a person needs a handful, a brute forcer thousands. The session API is polled by
 * the web app. Webhooks: GitHub delivers from a shared pool of addresses, so the per-address
 * limit is generous and only stops floods; per installation it bounds what one installation
 * (or a leaked webhook secret) can push into the inbox. Ask is per member (P9).
 */
export const DEFAULT_RATE_LIMITS: Readonly<Record<RateLimitScope, RateLimitRule>> = {
  "auth.login": { max: 30, windowMs: 10 * MINUTE },
  "auth.callback": { max: 30, windowMs: 10 * MINUTE },
  "auth.logout": { max: 30, windowMs: 10 * MINUTE },
  "auth.session": { max: 300, windowMs: MINUTE },
  "webhook.ip": { max: 600, windowMs: MINUTE },
  "webhook.installation": { max: 600, windowMs: MINUTE },
  ask: { max: 20, windowMs: MINUTE },
};

type Env = Readonly<Record<string, string | undefined>>;

const ENV_PREFIX = "ROCKY_RATE_LIMIT_";
const envName = (scope: RateLimitScope): string =>
  ENV_PREFIX + scope.toUpperCase().replaceAll(".", "_");
const MAX_WINDOW_SECONDS = 86_400;

/**
 * `ROCKY_RATE_LIMIT_<SCOPE>=<max>/<window seconds>` (e.g. `ROCKY_RATE_LIMIT_AUTH_LOGIN=30/600`).
 * Malformed values and unknown scopes are refused: there is no way to turn a limit off.
 */
export const rateLimitRulesFromEnv = (env: Env): Record<RateLimitScope, RateLimitRule> => {
  const rules: Record<RateLimitScope, RateLimitRule> = { ...DEFAULT_RATE_LIMITS };
  const known = new Map(RATE_LIMIT_SCOPES.map((s) => [envName(s), s] as const));
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || value === undefined) continue;
    const scope = known.get(name);
    if (scope === undefined) {
      throw new ConfigError(`${name} is not a rate limit; known: ${[...known.keys()].join(", ")}`);
    }
    const match = /^([1-9]\d{0,6})\/([1-9]\d{0,5})$/.exec(value);
    const max = Number(match?.[1]);
    const seconds = Number(match?.[2]);
    if (match === null || seconds > MAX_WINDOW_SECONDS) {
      throw new ConfigError(
        `${name} must be <max>/<window seconds>, both positive integers, window at most ${MAX_WINDOW_SECONDS}`,
      );
    }
    rules[scope] = { max, windowMs: seconds * 1000 };
  }
  return rules;
};

export interface RateLimitHit {
  /** Hits in the current window (after `hit`: this one included). */
  readonly count: number;
  /** When the current window ends (ms since the epoch). */
  readonly resetAt: number;
}

/** Where counters live. `key` is already HMAC'd; each scope is its own namespace. */
export interface RateLimitStore {
  /** Counts one hit of `key` in `scope`. */
  hit(scope: RateLimitScope, key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  /** The current window of `key` without counting; `undefined` when there is none. */
  peek(scope: RateLimitScope, key: string, now: number): Promise<RateLimitHit | undefined>;
}

/** Keys per scope and instance before the oldest are dropped (about 1 MB per scope). */
export const DEFAULT_MAX_KEYS_PER_SCOPE = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed windows, one bounded `Map` per scope. A flood of distinct keys in one scope
 * (e.g. login attempts from many IPv6 /64s) only ever evicts keys of that scope, so it cannot
 * reset a member's Ask budget or an installation's webhook budget (review round 1).
 *
 * A `Map` keeps insertion order and a key is re-inserted when its window restarts. Every key of a
 * scope has the same window length (one rule per scope) and time only moves forward, so within a
 * scope the first entry is the one whose window ends first. Making room is therefore a walk from
 * the front that stops at the first live entry while there is space: O(1) amortised per new key,
 * not a sweep of the whole map. When the scope is full of live windows its oldest is dropped (an
 * attacker with that many keys is not slowed by a per-key limit anyway).
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #scopes = new Map<RateLimitScope, Map<string, Window>>();
  readonly #maxKeys: number;

  constructor(options: { maxKeysPerScope?: number } = {}) {
    this.#maxKeys = options.maxKeysPerScope ?? DEFAULT_MAX_KEYS_PER_SCOPE;
  }

  /** Keys held in `scope`, or in all scopes. */
  size(scope?: RateLimitScope): number {
    if (scope !== undefined) return this.#scopes.get(scope)?.size ?? 0;
    let total = 0;
    for (const windows of this.#scopes.values()) total += windows.size;
    return total;
  }

  hit(scope: RateLimitScope, key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    let windows = this.#scopes.get(scope);
    if (windows === undefined) {
      windows = new Map();
      this.#scopes.set(scope, windows);
    }
    const current = windows.get(key);
    if (current !== undefined && now < current.resetAt) {
      current.count += 1;
      return Promise.resolve({ count: current.count, resetAt: current.resetAt });
    }
    windows.delete(key);
    this.#makeRoom(windows, now);
    const fresh = { count: 1, resetAt: now + windowMs };
    windows.set(key, fresh);
    return Promise.resolve({ ...fresh });
  }

  peek(scope: RateLimitScope, key: string, now: number): Promise<RateLimitHit | undefined> {
    const current = this.#scopes.get(scope)?.get(key);
    return Promise.resolve(
      current !== undefined && now < current.resetAt
        ? { count: current.count, resetAt: current.resetAt }
        : undefined,
    );
  }

  /** Drops expired windows from the front, then the oldest while the scope is full. */
  #makeRoom(windows: Map<string, Window>, now: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt > now && windows.size < this.#maxKeys) break;
      windows.delete(key);
    }
  }
}

export interface RateLimits {
  readonly rules: Readonly<Record<RateLimitScope, RateLimitRule>>;
  /**
   * The request's client address key (trusted-proxy rule, IPv6 per /64). When a trusted proxy's
   * header is missing or malformed it is the socket's peer, and a warning is logged at most once
   * a minute (mode and reason only, never an address).
   */
  clientKey(request: FastifyRequest): string;
  /**
   * Counts one hit of `key` in `scope`. Within the limit: `true`. Over it: answers 429 with
   * `Retry-After` and a fixed body and returns `false`; the caller must stop. If the store
   * fails: 503, `false` (fail closed).
   */
  consume(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: RateLimitScope,
    key: string,
  ): Promise<boolean>;
  /**
   * Checks `key` without counting: `true` while the budget is not spent, else the same 429 (or
   * 503) as `consume` and `false`. With `spend`, for budgets that only some outcomes use up
   * (webhook rejections, queued deliveries). Concurrent requests can overshoot by the number in
   * flight; the budgets that use it are generous.
   */
  allows(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: RateLimitScope,
    key: string,
  ): Promise<boolean>;
  /** Counts one hit without answering (the caller has its own answer). Never throws. */
  spend(request: FastifyRequest, scope: RateLimitScope, key: string): Promise<void>;
}

export const RATE_LIMITED_BODY = { error: "rate_limited" } as const;

/** At most one "trusted proxy header missing" warning per this interval, per process. */
export const FALLBACK_WARN_INTERVAL_MS = 60_000;

export const createRateLimits = (options: {
  readonly rules: Readonly<Record<RateLimitScope, RateLimitRule>>;
  readonly trustProxy: TrustProxy;
  readonly store?: RateLimitStore;
  readonly now?: () => number;
}): RateLimits => {
  const store = options.store ?? new MemoryRateLimitStore();
  const now = options.now ?? Date.now;
  // Per process: keys are not linkable across restarts or to an address without this secret.
  const keySecret = randomBytes(32);
  const hashed = (scope: RateLimitScope, key: string) =>
    createHmac("sha256", keySecret).update(`${scope}\0${key}`).digest("base64url");

  let fallbacks = 0;
  let lastFallbackWarn = -Infinity;
  const noteFallback = (request: FastifyRequest, reason: string) => {
    fallbacks += 1;
    const at = now();
    if (at - lastFallbackWarn < FALLBACK_WARN_INTERVAL_MS) return;
    lastFallbackWarn = at;
    request.log.warn(
      {
        rateLimit: {
          outcome: "proxy_header_fallback",
          trustProxy: options.trustProxy.kind,
          reason,
          // Since the previous warning (this one included).
          fallbacks,
        },
      },
      "trusted proxy header missing or malformed: counting the proxy's address",
    );
    fallbacks = 0;
  };

  const limited = (
    request: FastifyRequest,
    scope: RateLimitScope,
    id: string,
    count: number,
  ): void => {
    const rule = options.rules[scope];
    request.log.warn(
      {
        rateLimit: {
          scope,
          keyHash: id.slice(0, 16),
          count,
          limit: rule.max,
          windowSeconds: Math.round(rule.windowMs / 1000),
        },
      },
      "rate limited",
    );
  };

  const refuse = (reply: FastifyReply, resetAt: number, at: number): false => {
    const retryAfter = Math.max(1, Math.ceil((resetAt - at) / 1000));
    void reply
      .code(429)
      .header("retry-after", String(retryAfter))
      .header("cache-control", "no-store")
      .send(RATE_LIMITED_BODY);
    return false;
  };

  const unavailable = (request: FastifyRequest, reply: FastifyReply, scope: RateLimitScope) => {
    request.log.error({ rateLimit: { scope, outcome: "store_failed" } }, "rate limit unavailable");
    void reply.code(503).header("cache-control", "no-store").send({ error: "unavailable" });
    return false as const;
  };

  return {
    rules: options.rules,
    clientKey: (request) => {
      const resolved = resolveClientAddress(request, options.trustProxy);
      if (resolved.fallback !== undefined) noteFallback(request, resolved.fallback);
      return addressKey(resolved.address);
    },
    consume: async (request, reply, scope, key) => {
      const rule = options.rules[scope];
      const id = hashed(scope, key);
      const at = now();
      let hit: RateLimitHit;
      try {
        hit = await store.hit(scope, id, rule.windowMs, at);
      } catch {
        return unavailable(request, reply, scope);
      }
      if (hit.count <= rule.max) return true;
      // Once per key and window: a flood does not become a log flood.
      if (hit.count === rule.max + 1) limited(request, scope, id, hit.count);
      return refuse(reply, hit.resetAt, at);
    },
    allows: async (request, reply, scope, key) => {
      const rule = options.rules[scope];
      const at = now();
      let current: RateLimitHit | undefined;
      try {
        current = await store.peek(scope, hashed(scope, key), at);
      } catch {
        return unavailable(request, reply, scope);
      }
      if (current === undefined || current.count < rule.max) return true;
      return refuse(reply, current.resetAt, at);
    },
    spend: async (request, scope, key) => {
      const rule = options.rules[scope];
      const id = hashed(scope, key);
      try {
        const hit = await store.hit(scope, id, rule.windowMs, now());
        // Logged once, when this hit spends the budget.
        if (hit.count === rule.max) limited(request, scope, id, hit.count);
      } catch {
        // The caller has already decided its answer; `allows` fails closed on the next request.
        request.log.error(
          { rateLimit: { scope, outcome: "store_failed" } },
          "rate limit unavailable",
        );
      }
    },
  };
};
