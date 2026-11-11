import { timingSafeEqual } from "node:crypto";
import { sha256 } from "./cookies.js";

/**
 * A one-time token printed to the server's terminal at boot (ADR 0008 §3, ADR 0044 §2; shared
 * with the token-mode sign-in link of P10-4, ADR 0045 §3): 256-bit, compared as sha256 in
 * constant time, burnt on first use. Wrong tokens are counted per client address: after
 * `MAX_TOKEN_FAILURES` the address is locked out until the server restarts. A request without a
 * token of the right shape (a crawler on a new public host) counts for nothing, and one client's
 * failures never lock out another; at most `MAX_TRACKED_CLIENTS` addresses are remembered, the
 * oldest forgotten first.
 */

/** Wrong tokens tolerated per client address before it is locked until a restart. */
export const MAX_TOKEN_FAILURES = 20;
/** Client addresses whose failures are remembered; the oldest is forgotten first. */
export const MAX_TRACKED_CLIENTS = 1000;
/** The token's shape in a URL: 32 random bytes, base64url. */
export const ONE_TIME_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type RedeemOutcome = "redeemed" | "bad_token" | "token_locked";

export interface OneTimeLink {
  /**
   * Burns the token when `token` is it (once). `null` means the request carried none of the right
   * shape; `client` is the client address key the rate limits use.
   */
  redeem(token: string | null, client: string): RedeemOutcome;
  /** Refuses every later redemption (setup finished, or a restart would print a new one). */
  burn(): void;
  /**
   * Makes a redeemed token usable again: what it was redeemed for could not complete (token
   * mode before a token is saved, or a failure). No effect after `burn`.
   */
  release(): void;
  readonly used: boolean;
}

export const createOneTimeLink = (token: string): OneTimeLink => {
  const tokenHash = sha256(token);
  let used = false;
  let burnt = false;
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
  return {
    redeem: (presented, client) => {
      // Hash both sides to a fixed length, then compare in constant time. The token is 256-bit,
      // so guessing is hopeless; the per-client lockout and the rate limit still bound attempts.
      if ((failures.get(client) ?? 0) >= MAX_TOKEN_FAILURES) return "token_locked";
      if (presented === null) return "bad_token";
      if (used || !timingSafeEqual(sha256(presented), tokenHash)) {
        fail(client);
        return "bad_token";
      }
      used = true;
      return "redeemed";
    },
    burn: () => {
      used = true;
      burnt = true;
    },
    release: () => {
      if (!burnt) used = false;
    },
    get used() {
      return used;
    },
  };
};
