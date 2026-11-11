import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  cookieName,
  CSRF_HEADER,
  csrfTokenFor,
  csrfTokenMatches,
  isRandomToken,
  randomToken,
  readCookie,
  serializeCookie,
  sha256,
} from "../auth/cookies.js";

/**
 * The setup session (P3-1, extended by P10-2; ADR 0008 and 0044). The server prints a one-time
 * token to its terminal at boot (never through the logger); presenting it once trades it for a
 * session cookie, and every setup route (the manifest flow and the wizard) needs that session.
 *
 * - The token is 256-bit and compared as sha256 in constant time; it works once. After
 *   `MAX_TOKEN_FAILURES` wrong ones from one client address, redemption locks for that address
 *   until the server restarts. A missing or malformed token (a crawler on a new public host)
 *   counts for nothing, and one client's failures never lock out another (fix round, item 2).
 * - The cookie is HttpOnly, SameSite=Lax, `Path=/`, Secure with the `__Host-` prefix on https
 *   (ADR 0020 §3: no sibling subdomain can plant it). Lax, not Strict: GitHub's redirect back to
 *   the manifest callback is a cross-site top-level navigation, which a Strict cookie would not
 *   ride. Only sha256 of the cookie is kept, in memory: a restart ends every session.
 * - State-changing wizard requests carry a synchronizer token (HMAC of the cookie under a key
 *   generated per process) and must come from Rocky's own origin (`checkCsrf`), as the login's
 *   CSRF guard requires (ADR 0020 §5), which these routes are exempt from (they have no login
 *   session yet).
 */

export const SETUP_COOKIE = "rocky_setup";
/** A setup session lasts one hour (GitHub's manifest code also lives one hour). */
export const SETUP_SESSION_TTL_MS = 60 * 60 * 1000;
/** Wrong setup tokens tolerated per client address before it is locked until a restart. */
export const MAX_TOKEN_FAILURES = 20;
/** Client addresses whose failures are remembered; the oldest is forgotten first. */
export const MAX_TRACKED_CLIENTS = 1000;

export type RedeemResult =
  | { readonly ok: true; readonly cookie: string }
  | { readonly ok: false; readonly reason: "bad_token" | "token_locked" };

export type CsrfRefusal = "cross_site" | "origin" | "no_origin" | "token";

export interface SetupSessions {
  /**
   * Trades the one-time token for a new session (`Set-Cookie` value), at most once. `token` is
   * null when the request carried none of the right shape; `client` is the client address key
   * the rate limits use.
   */
  redeem(token: string | null, client?: string): RedeemResult;
  /** sha256 hex of the request's live session cookie, or `undefined`. */
  sessionOf(request: FastifyRequest): string | undefined;
  /** The synchronizer token for the request's session (the wizard reads it from its status). */
  csrfTokenOf(request: FastifyRequest): string | undefined;
  /** Why a state-changing request is refused, or `undefined` when it passes. */
  checkCsrf(request: FastifyRequest): CsrfRefusal | undefined;
  /** Ends every session and refuses new ones until the server restarts (setup finished). */
  close(): void;
  readonly closed: boolean;
}

export interface SetupSessionOptions {
  readonly token: string;
  /** Rocky's public origin: the only `Origin` state-changing requests may carry. */
  readonly publicUrl: URL;
  readonly now?: () => number;
}

const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

export const createSetupSessions = (options: SetupSessionOptions): SetupSessions => {
  const now = options.now ?? Date.now;
  const secure = options.publicUrl.protocol === "https:";
  const name = cookieName(SETUP_COOKIE, secure);
  const origin = options.publicUrl.origin;
  const tokenHash = sha256(options.token);
  const csrfKey = randomBytes(32);
  let tokenUsed = false;
  /** Client address key → wrong tokens; insertion order is age (oldest first). */
  const failures = new Map<string, number>();
  const fail = (client: string): void => {
    const count = (failures.get(client) ?? 0) + 1;
    failures.delete(client);
    if (failures.size >= MAX_TRACKED_CLIENTS) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
    failures.set(client, count);
  };
  let closed = false;
  /** sha256(cookie) hex → expiry; the cookie value itself is never stored. */
  const sessions = new Map<string, number>();

  const cookieOf = (request: FastifyRequest): string | undefined => {
    const value = readCookie(request.headers.cookie, name);
    return isRandomToken(value) ? value : undefined;
  };

  const sessionOf = (request: FastifyRequest): string | undefined => {
    const t = now();
    for (const [key, expiresAt] of sessions) if (expiresAt <= t) sessions.delete(key);
    const value = cookieOf(request);
    if (value === undefined) return undefined;
    const key = sha256(value).toString("hex");
    return sessions.has(key) ? key : undefined;
  };

  return {
    redeem: (token, client = "") => {
      // Hash both sides to a fixed length, then compare in constant time. The token is 256-bit,
      // so guessing is hopeless; the per-client lockout and the rate limit still bound attempts.
      const locked = (failures.get(client) ?? 0) >= MAX_TOKEN_FAILURES;
      if (locked) return { ok: false, reason: "token_locked" };
      if (token === null) return { ok: false, reason: "bad_token" };
      if (tokenUsed || !timingSafeEqual(sha256(token), tokenHash)) {
        fail(client);
        return { ok: false, reason: "bad_token" };
      }
      tokenUsed = true;
      const session = randomToken();
      sessions.set(sha256(session).toString("hex"), now() + SETUP_SESSION_TTL_MS);
      return {
        ok: true,
        cookie: serializeCookie(SETUP_COOKIE, session, {
          secure,
          maxAgeSeconds: SETUP_SESSION_TTL_MS / 1000,
        }),
      };
    },
    sessionOf,
    csrfTokenOf: (request) => {
      if (sessionOf(request) === undefined) return undefined;
      const value = cookieOf(request);
      return value === undefined ? undefined : csrfTokenFor(csrfKey, value);
    },
    checkCsrf: (request) => {
      const headers = request.headers;
      const fetchSite = headers["sec-fetch-site"];
      if (fetchSite !== undefined && fetchSite !== "same-origin") return "cross_site";
      const presentedOrigin = headers.origin;
      if (presentedOrigin !== undefined) {
        if (presentedOrigin !== origin) return "origin";
      } else {
        const referer = single(headers.referer);
        if (referer === undefined) return "no_origin";
        if (originOf(referer) !== origin) return "origin";
      }
      const value = cookieOf(request);
      if (value === undefined || sessionOf(request) === undefined) return "token";
      if (!csrfTokenMatches(csrfKey, value, single(headers[CSRF_HEADER]))) return "token";
      return undefined;
    },
    close: () => {
      sessions.clear();
      tokenUsed = true;
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
};
