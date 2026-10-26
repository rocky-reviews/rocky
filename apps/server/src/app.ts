import type { Logger } from "@rocky-reviews/log";
import { addRequestIdHeader, fastifyLoggerOptions } from "@rocky-reviews/log/fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { registerWebhooks, type WebhookDeps } from "./webhooks.js";

export type HealthCheck = () => Promise<boolean>;

export interface AppDeps {
  checkDatabase: HealthCheck;
  /** Request logging through the project logger (P2-4). Omit for silent tests. */
  log?: Logger;
  /** Forge webhook receiver (P3-2). Omitted when no webhook secret is configured (development). */
  webhooks?: WebhookDeps;
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
  const timeouts = {
    requestTimeout,
    http: {
      requestTimeout,
      headersTimeout: requestTimeout,
      connectionsCheckingInterval: deps.timeoutCheckIntervalMs ?? TIMEOUT_CHECK_INTERVAL_MS,
    },
  };
  const app: FastifyInstance =
    deps.log === undefined
      ? Fastify({ logger: false, ...timeouts })
      : Fastify({ ...fastifyLoggerOptions(deps.log), ...timeouts });
  if (deps.log !== undefined) addRequestIdHeader(app);

  // Health probes arrive every few seconds; log them only when something is wrong.
  app.get("/healthz", { logLevel: "warn" }, async (_req, reply) => {
    const database = await deps.checkDatabase().catch(() => false);
    return reply.code(database ? 200 : 503).send({ ok: database, database });
  });

  if (deps.webhooks !== undefined) registerWebhooks(app, deps.webhooks);

  return app;
};
