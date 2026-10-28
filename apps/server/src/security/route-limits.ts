import { OAUTH_CALLBACK_PATH } from "@rocky-reviews/forge-github";
import type { FastifyInstance } from "fastify";
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

/**
 * For `AuthDeps.rateLimit` (the P7-1 seam): per client address, before the handler runs, so a
 * limited login start writes no `login_attempts` row. Runs after the global CSRF guard, which
 * refuses forged state changes without touching the database.
 */
export const authRateLimit =
  (limits: RateLimits) =>
  async (scope: FastifyInstance): Promise<void> => {
    scope.addHook("onRequest", async (request, reply) => {
      const name = AUTH_SCOPES[request.routeOptions.url ?? ""] ?? "auth.session";
      if (await limits.consume(request, reply, name, limits.clientKey(request))) return undefined;
      return reply;
    });
  };

/** For `WebhookDeps.rateLimit`. */
export const webhookRateLimit = (limits: RateLimits): WebhookRateLimit => ({
  bySource: (request, reply) =>
    limits.consume(request, reply, "webhook.ip", limits.clientKey(request)),
  byInstallation: (request, reply, installation) =>
    limits.consume(request, reply, "webhook.installation", installation),
});
