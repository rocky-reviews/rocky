import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { applySecurityHeaders, type SecurityHeadersOptions } from "./headers.js";

/**
 * Error answers (P7-3, ADR 0025): fixed bodies only. Error messages can echo the URL, a header
 * or a driver's text, so neither the client nor the log ever gets `error.message`.
 *
 * - The root error handler catches whatever a route or hook throws (routes added later included;
 *   scopes with their own handler, like the auth routes, keep theirs).
 * - `frameworkErrors` covers what Fastify refuses before routing (a malformed URL such as
 *   `GET /%`): no hook runs there, so it applies the security headers itself.
 *
 * Node's HTTP parser answers some requests (bad request line, 408, 431) before Fastify sees them;
 * those carry no body and no headers from here (residual, ADR 0025).
 */

/** Fixed body per status; anything else is `bad_request` (4xx) or `internal` (5xx). */
const ERROR_BODIES: Readonly<Record<number, string>> = {
  400: "bad_request",
  404: "not_found",
  405: "method_not_allowed",
  408: "request_timeout",
  413: "payload_too_large",
  414: "uri_too_long",
  415: "unsupported_media_type",
  429: "rate_limited",
};

/** Fastify's own codes are fixed identifiers (`FST_ERR_…`); anything else is not logged. */
const SAFE_CODE = /^(?:FST_ERR_[A-Z0-9_]{1,64}|[0-9A-Z]{5})$/;

const statusOf = (error: unknown): number => {
  const raw = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : 500;
};

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
};

export const errorBody = (status: number): { error: string } => ({
  error: ERROR_BODIES[status] ?? (status >= 500 ? "internal" : "bad_request"),
});

const logError = (request: FastifyRequest, status: number, error: unknown): void => {
  const code = codeOf(error);
  request.log[status >= 500 ? "error" : "warn"](
    { requestError: { status, ...(code === undefined ? {} : { code }) } },
    "request failed",
  );
};

export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler(async (error, request, reply) => {
    const status = statusOf(error);
    logError(request, status, error);
    return reply.code(status).header("cache-control", "no-store").send(errorBody(status));
  });
};

/** For Fastify's `frameworkErrors` option. */
export const frameworkErrors =
  (options: SecurityHeadersOptions) =>
  (error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
    const status = error.code === "FST_ERR_ASYNC_CONSTRAINT" ? 500 : statusOf(error);
    logError(request, status, error);
    void reply.code(status).header("content-type", "application/json; charset=utf-8");
    applySecurityHeaders(reply, options);
    void reply.send(JSON.stringify(errorBody(status)));
  };
