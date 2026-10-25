import Fastify, { type FastifyInstance } from "fastify";

export type HealthCheck = () => Promise<boolean>;

/** Builds the HTTP app. Dependencies are passed in so tests can run it without a database. */
export const buildApp = (deps: { checkDatabase: HealthCheck }): FastifyInstance => {
  const app = Fastify({ logger: false });

  app.get("/healthz", async (_req, reply) => {
    const database = await deps.checkDatabase().catch(() => false);
    return reply.code(database ? 200 : 503).send({ ok: database, database });
  });

  return app;
};
