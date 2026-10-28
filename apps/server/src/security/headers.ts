import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Security headers (P7-3, ADR 0025): the one place that decides them. A root `onSend` hook adds
 * each header the route did not set, so every answer (routes, 404s, errors, 429s) carries them
 * and nothing is sent twice. Routes that need a stricter policy (the fixed HTML pages of the
 * auth and setup routes) build it with `pageCsp` and set it themselves; the hook keeps it.
 */

/**
 * The web app (Vite SPA, ADR 0019): its own scripts, styles, images and API only. No inline
 * script or style (the build test and `loadWebApp` enforce it), so no hash or nonce is needed.
 * React sets `style` through the CSSOM, which CSP allows. Sign-in is a link, not a form, so
 * `form-action 'self'` does not block the redirect to GitHub.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/** Anything that is not an HTML document (JSON, scripts, styles): it may load nothing. */
export const NON_DOCUMENT_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Fixed HTML pages with one inline `<style>`: allowed by hash, nothing else. */
export const pageCsp = (page: { style: string; formAction?: string }): string =>
  `default-src 'none'; style-src 'sha256-${createHash("sha256").update(page.style).digest("base64")}'; frame-ancestors 'none'; base-uri 'none'; form-action ${page.formAction ?? "'none'"}`;

/**
 * One year, this host only. Not `includeSubDomains` or `preload`: a self-hosted Rocky on a
 * company domain must not force HTTPS onto that company's other hosts.
 */
export const HSTS = "max-age=31536000";

/** Sent on every response unless the route set the header itself. */
export const BASELINE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  // Legacy browsers; CSP frame-ancestors is the control.
  "x-frame-options": "DENY",
  // Stricter than strict-origin-when-cross-origin: nothing leaves the origin. Same-origin
  // requests keep Origin and Referer, which the CSRF guard needs (ADR 0020 §5); `no-referrer`
  // would make browsers send `Origin: null` on the SPA's own POSTs.
  "referrer-policy": "same-origin",
  "permissions-policy":
    "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), serial=(), usb=(), xr-spatial-tracking=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

export interface SecurityHeadersOptions {
  /** Production (https): send HSTS. */
  readonly hsts: boolean;
}

const isHtml = (contentType: unknown): boolean =>
  typeof contentType === "string" && /^text\/html\b/i.test(contentType);

/**
 * Adds every header the reply does not already carry. Called from the `onSend` hook and from the
 * `frameworkErrors` handler (`security/errors.ts`): Fastify answers a malformed URL (`GET /%`)
 * before routing, without running hooks, so that answer would otherwise go out bare.
 */
export const applySecurityHeaders = (
  reply: FastifyReply,
  options: SecurityHeadersOptions,
): void => {
  for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
    if (!reply.hasHeader(name)) void reply.header(name, value);
  }
  if (!reply.hasHeader("content-security-policy")) {
    void reply.header(
      "content-security-policy",
      isHtml(reply.getHeader("content-type")) ? APP_CSP : NON_DOCUMENT_CSP,
    );
  }
  // Authenticated and API answers must never be stored; only static assets opt in to caching.
  if (!reply.hasHeader("cache-control")) void reply.header("cache-control", "no-store");
  if (options.hsts) void reply.header("strict-transport-security", HSTS);
  reply.removeHeader("x-powered-by");
  reply.removeHeader("server");
};

export const registerSecurityHeaders = (
  app: FastifyInstance,
  options: SecurityHeadersOptions,
): void => {
  app.addHook("onSend", async (_request, reply, payload) => {
    applySecurityHeaders(reply, options);
    return payload;
  });
};
