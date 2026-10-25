import {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { Logger } from "pino";
import { newRequestId } from "./request.js";

/** Path only: query strings carry OAuth codes, state tokens and API keys. */
const pathOnly = (url: string | undefined): string => {
  if (url === undefined || url === "") return "/";
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
};

/**
 * Allowlist serializers for Fastify's request logging: method and path only. Headers, query
 * string, host and client IP (personal data) are never logged; `requestId` binds the lines.
 */
const serializers = {
  req: (req: { method?: string; url?: string }) => ({ method: req.method, url: pathOnly(req.url) }),
  res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
};

/** Fastify's default 404 line interpolates the raw URL (with query string); this one does not. */
class RedactingLogController extends LogController {
  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info({ method: request.method, url: pathOnly(request.url) }, "route not found");
  }
}

export type FastifyLoggerOptions = Pick<
  FastifyServerOptions,
  "loggerInstance" | "genReqId" | "requestIdHeader" | "logController"
>;

/**
 * Server options that route Fastify's logging through the project logger: a server-generated
 * UUID request id on every line (`requestId`), client `x-request-id` headers ignored, safe
 * serializers. Usage: `Fastify(fastifyLoggerOptions(log))`, then `addRequestIdHeader(app)`.
 */
export const fastifyLoggerOptions = (log: Logger): FastifyLoggerOptions => ({
  loggerInstance: log.child({}, { serializers }),
  genReqId: () => newRequestId(),
  requestIdHeader: false,
  logController: new RedactingLogController({ requestIdLogLabel: "requestId" }),
});

/** Returns the request id to the client so a support ticket can be matched to log lines. */
export const addRequestIdHeader = (app: FastifyInstance): void => {
  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });
};
