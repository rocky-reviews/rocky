import { OAUTH_CALLBACK_PATH } from "@rocky-reviews/forge-github";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  cookieName,
  CSRF_HEADER,
  csrfTokenMatches,
  isRandomToken,
  readCookie,
  SESSION_COOKIE,
  sha256,
} from "../auth/cookies.js";
import { LOGIN_PATH, LOGOUT_PATH } from "../auth/routes.js";
import type { WebhookRateLimit } from "../webhooks.js";
import type { RateLimits, RateLimitScope } from "./rate-limit.js";

/**
 * Where each limit applies (P7-3, ADR 0025). Kept here, not in the route modules, so the
 * limits are reviewed in one place.
 */

/** Auth routes by path; any other route in the auth scope counts as the session API. */
const AUTH_SCOPES: Readonly<Record<string, RateLimitScope>> = {
  [LOGIN_PATH]: "auth.login",
  [OAUTH_CALLBACK_PATH]: "auth.callback",
  [LOGOUT_PATH]: "auth.logout",
};

export interface AuthRateLimitOptions {
  /** The CSRF secret (`AuthDeps.secret`): proves a session cookie was issued with its token. */
  readonly secret: Buffer;
  readonly cookieSecure: boolean;
}

/**
 * For `AuthDeps.rateLimit` (the P7-1 seam): before the handler runs, so a limited login start
 * writes no `login_attempts` row. Runs after the global CSRF guard, which refuses forged state
 * changes without touching the database.
 *
 * Login and callback count per client address. A state-changing request (logout, switching
 * org) whose session cookie comes with its valid CSRF token counts per session instead
 * (review round 1): otherwise one client behind a shared NAT could stop everyone else there
 * from signing out. A client cannot mint such pairs (the token is an HMAC under the server
 * secret), so this is not a way to get fresh buckets; anything else counts per address.
 */
export const authRateLimit =
  (limits: RateLimits, options: AuthRateLimitOptions) =>
  async (scope: FastifyInstance): Promise<void> => {
    const sessionCookie = cookieName(SESSION_COOKIE, options.cookieSecure);
    const sessionKey = (request: FastifyRequest): string | undefined => {
      if (request.method === "GET" || request.method === "HEAD") return undefined;
      const token = readCookie(request.headers.cookie, sessionCookie);
      const csrf = request.headers[CSRF_HEADER];
      if (!isRandomToken(token) || typeof csrf !== "string") return undefined;
      if (!csrfTokenMatches(options.secret, token, csrf)) return undefined;
      return `session:${sha256(token).toString("base64url")}`;
    };
    scope.addHook("onRequest", async (request, reply) => {
      const name = AUTH_SCOPES[request.routeOptions.url ?? ""] ?? "auth.session";
      const key =
        (name === "auth.logout" || name === "auth.session" ? sessionKey(request) : undefined) ??
        `address:${limits.clientKey(request)}`;
      if (await limits.consume(request, reply, name, key)) return undefined;
      return reply;
    });
  };

/**
 * For `WebhookDeps.rateLimit`. The per-source budget counts rejections only (failed precheck,
 * bad signature, oversized body), never genuine deliveries (review round 1). It is keyed by
 * address and by whether the unauthenticated headers claim to come from this deployment's own
 * GitHub App: GitHub sends every app's deliveries from one shared pool of addresses, so another
 * app pointed at Rocky with a wrong secret fills only the "other" bucket of that address, and
 * Rocky's own deliveries from the same address keep flowing. A client that connects directly
 * gets at most these two buckets per address.
 */
export const webhookRateLimit = (limits: RateLimits): WebhookRateLimit => {
  const sourceKey = (request: FastifyRequest, ownSender: boolean) =>
    `${limits.clientKey(request)}|${ownSender ? "own" : "other"}`;
  return {
    sourceAllowed: (request, reply, ownSender) =>
      limits.allows(request, reply, "webhook.ip", sourceKey(request, ownSender)),
    sourceRejected: (request, ownSender) =>
      limits.spend(request, "webhook.ip", sourceKey(request, ownSender)),
    installationAllowed: (request, reply, installation) =>
      limits.allows(request, reply, "webhook.installation", installation),
    installationQueued: (request, installation) =>
      limits.spend(request, "webhook.installation", installation),
  };
};
