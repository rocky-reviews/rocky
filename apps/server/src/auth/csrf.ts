import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  cookieName,
  CSRF_HEADER,
  csrfTokenMatches,
  isRandomToken,
  readCookie,
  SESSION_COOKIE,
} from "./cookies.js";

/**
 * CSRF defence for every state-changing request (P7-1, ADR 0020 §5). One global `onRequest`
 * hook, so a route added later is protected without opting in; it runs before the body is read.
 * A request whose method is not GET, HEAD or OPTIONS passes only if all of these hold:
 *
 * 1. `Sec-Fetch-Site`, when the browser sends it, is `same-origin` (not `same-site`: a sibling
 *    subdomain is another site for Rocky);
 * 2. `Origin` is Rocky's public origin exactly; without `Origin`, the `Referer`'s origin is; with
 *    neither, it is refused (fail closed; every browser that matters sends one of them on POST);
 * 3. the `x-rocky-csrf` header carries the synchronizer token of the session cookie it came with
 *    (HMAC of that cookie's token under the server secret; constant-time).
 *
 * SameSite=Lax on the session cookie is a further layer, not the control. Two exemptions exist: a
 * route that declares `config: { csrfExempt: "hmac_signature" }`, which authenticates every
 * request by a signature over its body and reads no cookie (the GitHub webhook receiver), and
 * `csrfExempt: "setup_session"`, the setup wizard's requests (P10-2, ADR 0044), which have no
 * login session yet and run the same three checks against the setup session in their own
 * handler (`setup/session.ts`, `checkCsrf`). Without a session secret (login not configured),
 * every non-exempt state-changing request is refused.
 */

export const CSRF_EXEMPT_HMAC = "hmac_signature";
export const CSRF_EXEMPT_SETUP = "setup_session";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * `hmac_signature`: only for routes authenticated by a body signature and never by a cookie.
     * `setup_session`: only for setup wizard routes that call `SetupSessions.checkCsrf` first.
     */
    csrfExempt?: typeof CSRF_EXEMPT_HMAC | typeof CSRF_EXEMPT_SETUP;
  }
}

export interface CsrfPolicy {
  /** Rocky's public origin (`ROCKY_PUBLIC_URL`), e.g. `https://rocky.example.com`. */
  readonly origin: string;
  readonly secret: Buffer;
  readonly cookieSecure: boolean;
}

export type CsrfRefusal = "not_configured" | "cross_site" | "origin" | "no_origin" | "token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

/** Why this request would be refused, or `undefined` when it passes. */
export const csrfRefusal = (
  request: Pick<FastifyRequest, "method" | "headers">,
  policy: CsrfPolicy | undefined,
): CsrfRefusal | undefined => {
  if (SAFE_METHODS.has(request.method)) return undefined;
  if (policy === undefined) return "not_configured";
  const headers = request.headers;
  const fetchSite = headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") return "cross_site";
  const origin = headers.origin;
  if (origin !== undefined) {
    if (origin !== policy.origin) return "origin";
  } else {
    const referer = single(headers.referer);
    if (referer === undefined) return "no_origin";
    if (originOf(referer) !== policy.origin) return "origin";
  }
  const session = readCookie(headers.cookie, cookieName(SESSION_COOKIE, policy.cookieSecure));
  if (!isRandomToken(session)) return "token";
  if (!csrfTokenMatches(policy.secret, session, single(headers[CSRF_HEADER]))) return "token";
  return undefined;
};

/** The only routes that may declare the setup exemption (ADR 0044). */
export const SETUP_EXEMPT_PREFIX = "/api/setup/";

export const registerCsrfGuard = (app: FastifyInstance, policy: CsrfPolicy | undefined): void => {
  // A route elsewhere cannot borrow the setup exemption: it fails to register (boot fails).
  app.addHook("onRoute", (route) => {
    const exempt = (route.config as { csrfExempt?: unknown } | undefined)?.csrfExempt;
    if (exempt === CSRF_EXEMPT_SETUP && !route.url.startsWith(SETUP_EXEMPT_PREFIX)) {
      throw new Error(`csrfExempt "${CSRF_EXEMPT_SETUP}" is only for ${SETUP_EXEMPT_PREFIX}*`);
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return undefined;
    // No route, no handler: the 404 changes nothing.
    if (request.is404) return undefined;
    const exempt = request.routeOptions.config.csrfExempt;
    if (exempt === CSRF_EXEMPT_HMAC || exempt === CSRF_EXEMPT_SETUP) return undefined;
    const refusal = csrfRefusal(request, policy);
    if (refusal === undefined) return undefined;
    request.log.warn({ csrf: { outcome: "refused", reason: refusal } }, "csrf check refused");
    return reply.code(403).header("cache-control", "no-store").send({ error: "csrf" });
  });
};
