import {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { Logger } from "pino";
import { newRequestId } from "./request.js";
import { scrubString } from "./scrub.js";

/**
 * What a request line says about the path: the matched route's pattern (`/api/repos/:owner/…`),
 * never the raw path. Raw paths carry query strings (OAuth codes, state tokens, API keys),
 * tokens (`/invite/<token>`) and names people treat as private: repository owners and names
 * (`/api/repos/<owner>/<repo>/…`, the PR page `/<owner>/<repo>/pull/<n>`, H4-2). Ids a route
 * needs to log, it logs itself. A request no route matched (a 404, or the web app's fallback to
 * `index.html`) gets a fixed marker. The pattern is scrubbed too, as defence in depth.
 */
export const UNMATCHED_PATH = "(unmatched)";

const routePath = (req: { routeOptions?: { url?: unknown }; url?: unknown }): string => {
  // Our own output, serialised again by pino after the logger's scrub (`logger.ts`): a plain
  // object, not a request. Keep it, so the serializer stays idempotent.
  if (Object.getPrototypeOf(req) === Object.prototype && typeof req.url === "string")
    return req.url;
  const pattern = req.routeOptions?.url;
  return typeof pattern === "string" && pattern !== "" ? scrubString(pattern) : UNMATCHED_PATH;
};

/**
 * Allowlist serializers for Fastify's request logging: method and route pattern only. Headers,
 * query string, raw path, host and client IP (personal data) are never logged; `requestId`
 * binds the lines.
 */
const serializers = {
  req: (req: { method?: string; routeOptions?: { url?: unknown }; url?: unknown }) => ({
    method: req.method,
    url: routePath(req),
  }),
  res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
};

/** Fastify's default 404 line interpolates the raw URL (with query string); this one does not. */
class RedactingLogController extends LogController {
  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info({ method: request.method, url: UNMATCHED_PATH }, "route not found");
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
