/**
 * The Vite dev server's proxy to the Rocky server (H4-2), for `pnpm dev` only: `vite.config.ts`
 * imports it; the app never does, and production has no Vite (the server serves the build).
 *
 * The browser talks to one origin, Vite's (`http://127.0.0.1:5173`), and `/api/*` and `/auth/*`
 * go on to the server, so the session cookie (non-Secure, no `__Host-` prefix on loopback http,
 * ADR 0020) and the CSRF Origin check (ADR 0020 §5) work as in production. For that the server's
 * `ROCKY_PUBLIC_URL` must be the browser's origin, `http://127.0.0.1:5173`
 * (docs/runbooks/review-a-real-pr.md). The Host and Origin headers pass through unchanged
 * (`changeOrigin: false`) and no `X-Forwarded-*` header is added, so the server sees what the
 * browser sent; redirects and `Set-Cookie` come back as the server wrote them.
 *
 * `ROCKY_DEV_SERVER_URL` moves the target (default `http://127.0.0.1:4310`); `off` turns the
 * proxy off (the Playwright suites answer the API themselves and must never reach a server
 * running on the machine). The target is http on a loopback address, or https.
 */

export const DEV_SERVER_ENV = "ROCKY_DEV_SERVER_URL";
export const DEFAULT_DEV_SERVER = "http://127.0.0.1:4310";
/**
 * What the browser reaches through Vite: `/api` and `/auth` and below, as whole path segments
 * (Vite's plain keys are string prefixes, so `/apis` would match `/api`); everything else, the
 * app's own pages included, Vite serves itself.
 */
export const PROXIED_PATHS = ["^/api(?:[/?]|$)", "^/auth(?:[/?]|$)"] as const;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class DevProxyConfigError extends Error {
  override readonly name = "DevProxyConfigError";
}

/** The server's origin to proxy to, or `null` when the proxy is off. */
export const devProxyTarget = (
  env: Readonly<Record<string, string | undefined>>,
): string | null => {
  const raw = env[DEV_SERVER_ENV];
  if (raw === "off") return null;
  let url: URL;
  try {
    url = new URL(raw === undefined || raw === "" ? DEFAULT_DEV_SERVER : raw);
  } catch {
    throw new DevProxyConfigError(`${DEV_SERVER_ENV} is not a URL`);
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp)
    throw new DevProxyConfigError(`${DEV_SERVER_ENV} must be https, or http on a loopback address`);
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "")
    throw new DevProxyConfigError(`${DEV_SERVER_ENV} must be an origin (no path or credentials)`);
  return url.origin;
};

type ProxyOptions = {
  readonly target: string;
  readonly changeOrigin: false;
  readonly xfwd: false;
  readonly ws: false;
};

/** Vite's `server.proxy` for that target (undefined: no proxy). */
export const devProxy = (target: string | null): Record<string, ProxyOptions> | undefined =>
  target === null
    ? undefined
    : Object.fromEntries(
        PROXIED_PATHS.map((path) => [
          path,
          { target, changeOrigin: false, xfwd: false, ws: false },
        ]),
      );
