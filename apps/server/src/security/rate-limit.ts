import { createHmac, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ConfigError } from "../config.js";
import { addressKey, clientAddress, type TrustProxy } from "./client-ip.js";

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
  /** Hits in the current window, this one included. */
  readonly count: number;
  /** When the current window ends (ms since the epoch). */
  readonly resetAt: number;
}

/** Where counters live. `key` is already HMAC'd and scoped. */
export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}

/** Keys per instance before the oldest are dropped (memory bound, about 1 MB). */
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * In-memory fixed windows. A `Map` keeps insertion order and a key is re-inserted when its
 * window restarts, so the first entry is the oldest window. When full, expired windows are
 * swept, then the oldest are dropped: memory stays bounded under a flood of distinct keys, at
 * the price that such a flood can reset other keys' counters (an attacker with that many
 * addresses is not slowed by per-address limits anyway).
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  get size(): number {
    return this.#windows.size;
  }

  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const current = this.#windows.get(key);
    if (current !== undefined && now < current.resetAt) {
      current.count += 1;
      return Promise.resolve({ count: current.count, resetAt: current.resetAt });
    }
    this.#windows.delete(key);
    if (this.#windows.size >= this.#maxKeys) this.#makeRoom(now);
    const fresh = { count: 1, resetAt: now + windowMs };
    this.#windows.set(key, fresh);
    return Promise.resolve({ ...fresh });
  }

  #makeRoom(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
    for (const key of this.#windows.keys()) {
      if (this.#windows.size < this.#maxKeys) break;
      this.#windows.delete(key);
    }
  }
}

export interface RateLimits {
  readonly rules: Readonly<Record<RateLimitScope, RateLimitRule>>;
  /** The request's client address key (trusted-proxy rule, IPv6 per /64). */
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
}

export const RATE_LIMITED_BODY = { error: "rate_limited" } as const;

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

  return {
    rules: options.rules,
    clientKey: (request) => addressKey(clientAddress(request, options.trustProxy)),
    consume: async (request, reply, scope, key) => {
      const rule = options.rules[scope];
      const id = hashed(scope, key);
      const at = now();
      let hit: RateLimitHit;
      try {
        hit = await store.hit(`${scope}:${id}`, rule.windowMs, at);
      } catch {
        request.log.error(
          { rateLimit: { scope, outcome: "store_failed" } },
          "rate limit unavailable",
        );
        void reply.code(503).header("cache-control", "no-store").send({ error: "unavailable" });
        return false;
      }
      if (hit.count <= rule.max) return true;
      // Once per key and window: a flood does not become a log flood.
      if (hit.count === rule.max + 1) {
        request.log.warn(
          {
            rateLimit: {
              scope,
              keyHash: id.slice(0, 16),
              count: hit.count,
              limit: rule.max,
              windowSeconds: Math.round(rule.windowMs / 1000),
            },
          },
          "rate limited",
        );
      }
      const retryAfter = Math.max(1, Math.ceil((hit.resetAt - at) / 1000));
      void reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .header("cache-control", "no-store")
        .send(RATE_LIMITED_BODY);
      return false;
    },
  };
};
