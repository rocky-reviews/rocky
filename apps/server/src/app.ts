import type { PullRequestApprover, RepositoryAccessCheck } from "@rocky-reviews/core";
import type { Logger } from "@rocky-reviews/log";
import { addRequestIdHeader, fastifyLoggerOptions } from "@rocky-reviews/log/fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCsrfGuard } from "./auth/csrf.js";
import { publicRoute, registerAccessPolicy, type PolicyEntry } from "./auth/policy.js";
import { registerAuth, type AuthDeps, type SessionAuth } from "./auth/routes.js";
import { registerGitHubAppSetup, type GitHubAppSetupDeps } from "./github-app-setup.js";
import { registerInboxRoutes } from "./inbox/routes.js";
import { registerReviewRoutes } from "./reviews/routes.js";
import { registerRoleRoutes } from "./roles/routes.js";
import { frameworkErrors, registerErrorHandler } from "./security/errors.js";
import { registerSecurityHeaders } from "./security/headers.js";
import type { RateLimits } from "./security/rate-limit.js";
import { registerWebApp, type WebApp } from "./web-app.js";
import { registerWebhooks, type WebhookDeps } from "./webhooks.js";

export type HealthCheck = () => Promise<boolean>;

export interface AppDeps {
  checkDatabase: HealthCheck;
  /** Request logging through the project logger (P2-4). Omit for silent tests. */
  log?: Logger;
  /** Forge webhook receiver (P3-2). Omitted when no webhook secret is configured (development). */
  webhooks?: WebhookDeps;
  /** GitHub App manifest setup (P3-1). Only when requested, outside production, unconfigured. */
  githubAppSetup?: GitHubAppSetupDeps;
  /**
   * GitHub login and sessions (P7-1, ADR 0020). Without it no session can exist, so every
   * state-changing route except the signed webhook receiver is refused by the CSRF guard.
   */
  auth?: AuthDeps;
  /** Security headers (P7-3, ADR 0025) are always on; HSTS only in production (https). */
  hsts?: boolean;
  /** The built web app, served with the same headers (P7-3); absent in development (Vite). */
  web?: WebApp;
  /** Rate limits for routes (P7-3); the auth and webhook deps carry their own hooks. */
  rateLimits?: RateLimits;
  /**
   * The repository access check (P3-6) for routes that touch a repository's data; such routes
   * refuse (503) without it (P7-2).
   */
  repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
  /**
   * Submits one approving review as the member (P3-5 fills this port). The inbox's bulk approval
   * (P6-7) refuses (503) without it.
   */
  pullRequestApprover?: PullRequestApprover;
  /** Overrides REQUEST_TIMEOUT_MS / TIMEOUT_CHECK_INTERVAL_MS (tests). */
  requestTimeoutMs?: number;
  timeoutCheckIntervalMs?: number;
}

/**
 * Longest a client may take to send a whole request (headers and body). Bounds how long a slow
 * upload can hold a body buffer (ADR 0007, "Memory"). Node checks it every
 * TIMEOUT_CHECK_INTERVAL_MS (its default, 30 s, would double the bound).
 *
 * Server-wide: it applies to every route, not just webhooks, and bounds only the time the
 * client takes to *send* the request (not the handler). A future large-upload route would
 * inherit it and needs its own server or an explicit decision to raise it.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const TIMEOUT_CHECK_INTERVAL_MS = 1_000;

/** Builds the HTTP app. Dependencies are passed in so tests can run it without a database. */
export const buildApp = (deps: AppDeps): FastifyInstance => {
  // Passed to http.createServer as well: Node only enforces requestTimeout when headersTimeout
  // is not larger, and Fastify's own `requestTimeout` sets the property after construction while
  // headersTimeout keeps its 60 s default, which leaves slow uploads unbounded (found in review
  // round 2; "cuts off a slow upload at the request timeout" proves the effective setting).
  const requestTimeout = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const headers = { hsts: deps.hsts ?? false };
  const options = {
    // Malformed URLs (`GET /%`) are refused before routing and without hooks (review round 1).
    frameworkErrors: frameworkErrors(headers),
    requestTimeout,
    http: {
      requestTimeout,
      headersTimeout: requestTimeout,
      connectionsCheckingInterval: deps.timeoutCheckIntervalMs ?? TIMEOUT_CHECK_INTERVAL_MS,
    },
  };
  const app: FastifyInstance =
    deps.log === undefined
      ? Fastify({ logger: false, ...options })
      : Fastify({ ...fastifyLoggerOptions(deps.log), ...options });
  if (deps.log !== undefined) addRequestIdHeader(app);
  registerSecurityHeaders(app, headers);
  // Fixed error bodies for every route, including root-level ones added later (review round 1).
  registerErrorHandler(app);
  if (deps.rateLimits !== undefined) app.decorate("rateLimits", deps.rateLimits);
  // Before any route: every route must declare its access policy, or it fails to register (P7-2).
  const policies = registerAccessPolicy(app, () => app.sessionAuth);
  app.decorate("routePolicies", policies.routes);
  // Before any route: every state-changing route is CSRF-checked unless it opts out (ADR 0020 §5).
  registerCsrfGuard(
    app,
    deps.auth === undefined
      ? undefined
      : {
          origin: deps.auth.publicUrl.origin,
          secret: deps.auth.secret,
          cookieSecure: deps.auth.cookieSecure,
        },
  );

  // Health probes arrive every few seconds; log them only when something is wrong.
  app.get(
    "/healthz",
    { logLevel: "warn", config: { policy: publicRoute("health probe") } },
    async (_req, reply) => {
      const database = await deps.checkDatabase().catch(() => false);
      return reply.code(database ? 200 : 503).send({ ok: database, database });
    },
  );

  if (deps.webhooks !== undefined) registerWebhooks(app, deps.webhooks);
  if (deps.githubAppSetup !== undefined) registerGitHubAppSetup(app, deps.githubAppSetup);
  if (deps.auth !== undefined) {
    app.decorate("sessionAuth", registerAuth(app, deps.auth));
    registerRoleRoutes(app, {
      db: deps.auth.db,
      ...(deps.auth.onMemberTokenChanged === undefined
        ? {}
        : { onMemberChanged: deps.auth.onMemberTokenChanged }),
      ...(deps.repositoryAccess === undefined ? {} : { repositoryAccess: deps.repositoryAccess }),
    });
    registerInboxRoutes(app, {
      db: deps.auth.db,
      ...(deps.repositoryAccess === undefined ? {} : { repositoryAccess: deps.repositoryAccess }),
      ...(deps.pullRequestApprover === undefined ? {} : { approver: deps.pullRequestApprover }),
    });
    registerReviewRoutes(app, {
      db: deps.auth.db,
      ...(deps.repositoryAccess === undefined ? {} : { repositoryAccess: deps.repositoryAccess }),
    });
  }
  registerWebApp(app, deps.web);

  return app;
};

declare module "fastify" {
  interface FastifyInstance {
    /** Session lookups for routes (P7-1); present when login is configured. */
    sessionAuth?: SessionAuth;
    /** Every registered route and its declared access policy (P7-2; the matrix test reads it). */
    routePolicies: () => readonly PolicyEntry[];
    /** Rate limits for routes (P7-3); Ask (P9) calls `consume(request, reply, "ask", memberId)`. */
    rateLimits?: RateLimits;
  }
}
