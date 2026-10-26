import type { Logger } from "@rocky-reviews/log";
import { addRequestIdHeader, fastifyLoggerOptions } from "@rocky-reviews/log/fastify";
import Fastify, { type FastifyInstance } from "fastify";

export type HealthCheck = () => Promise<boolean>;

export interface AppDeps {
  checkDatabase: HealthCheck;
  /** Request logging through the project logger (P2-4). Omit for silent tests. */
  log?: Logger;
}

/** Builds the HTTP app. Dependencies are passed in so tests can run it without a database. */
export const buildApp = (deps: AppDeps): FastifyInstance => {
  const app: FastifyInstance =
    deps.log === undefined ? Fastify({ logger: false }) : Fastify(fastifyLoggerOptions(deps.log));
  if (deps.log !== undefined) addRequestIdHeader(app);

  // Health probes arrive every few seconds; log them only when something is wrong.
  app.get("/healthz", { logLevel: "warn" }, async (_req, reply) => {
    const database = await deps.checkDatabase().catch(() => false);
    return reply.code(database ? 200 : 503).send({ ok: database, database });
  });

  return app;
};
