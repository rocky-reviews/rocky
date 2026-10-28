/**
 * Where to send the browser after login (P7-1, ADR 0020 §6). Only a same-origin relative path is
 * accepted: an allow-list of characters first, then structural checks, then the WHATWG URL
 * parser (what browsers use) must resolve it to Rocky's own origin. Anything else is `null`, and
 * the caller falls back to `/`; it never redirects anywhere it could not prove is Rocky.
 *
 * Refused, among others: `//evil.com`, `/\evil.com`, `\\evil.com`, `https://evil.com`,
 * `javascript:…`, `/%2F%2Fevil.com` (encoded slashes), `%5C`, `%09` and any encoded control
 * character, double encoding (`%25…`), malformed escapes, raw whitespace, control characters,
 * backslashes and non-ASCII (look-alike slashes such as U+2215 or U+FF0F), paths that normalise
 * to `//…` (`/.//evil.com`), and the auth endpoints themselves (no loops).
 */

export const RETURN_TO_MAX_LENGTH = 2048;
export const DEFAULT_RETURN_TO = "/";

/** RFC 3986 path, query and fragment characters (unreserved, sub-delims, `:@/?#%`). */
const ALLOWED = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?#%]+$/;
/** Encoded `/`, `\`, `%` (double encoding), space and every C0 control and DEL. */
const ENCODED_FORBIDDEN = /%(?:2f|5c|25|20|0[0-9a-f]|1[0-9a-f]|7f)/i;
const MALFORMED_ESCAPE = /%(?![0-9a-f]{2})/i;
const BASE = new URL("https://rocky.invalid/");

export const safeReturnTo = (raw: unknown): string | null => {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RETURN_TO_MAX_LENGTH) {
    return null;
  }
  if (!ALLOWED.test(raw)) return null;
  // One leading slash, not two: `//host` is a network-path reference.
  if (raw[0] !== "/" || raw[1] === "/") return null;
  if (ENCODED_FORBIDDEN.test(raw) || MALFORMED_ESCAPE.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE.origin || url.username !== "" || url.password !== "") return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can collapse into `//…` (`/.//evil.com`): check what the parser produced.
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  // No loops back into the auth routes, however the path spells them (`/%61uth/…`, `/AUTH/…`):
  // compare the percent-decoded, lower-cased pathname (review round 1).
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return null;
  }
  if (pathname === "/auth" || pathname.startsWith("/auth/")) return null;
  return path;
};

/**
 * The absolute URL of a validated return path on Rocky's public origin, or the origin's root
 * when the path does not resolve there (it always does for `safeReturnTo` output).
 */
export const returnUrl = (path: string, publicUrl: URL): URL => {
  const safe = safeReturnTo(path) ?? DEFAULT_RETURN_TO;
  const url = new URL(safe, publicUrl.origin);
  return url.origin === publicUrl.origin ? url : new URL(DEFAULT_RETURN_TO, publicUrl.origin);
};
