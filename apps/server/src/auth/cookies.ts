import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Cookies and the values bound to them (P7-1, ADR 0020 §3 and §5).
 *
 * - Names carry the `__Host-` prefix whenever cookies are Secure: the browser then refuses them
 *   unless they are Secure, host-only (no Domain) and `Path=/`, so a sibling subdomain cannot
 *   plant or overwrite them (cookie tossing). The only exception is local development over http
 *   on a loopback address (`cookieSecure: false`), which the config refuses in production.
 * - Only the expected name is ever read: in production a cookie without the prefix is ignored.
 * - Values are checked against their exact shape before use; anything else is "no cookie".
 * - HMAC-SHA256 under the server's session secret, with a label per use (domain separation),
 *   compared in constant time. No custom crypto: `node:crypto` primitives only.
 */

export const SESSION_COOKIE = "rocky_session";
export const LOGIN_COOKIE = "rocky_login";
export const CSRF_HEADER = "x-rocky-csrf";

/** 256-bit random values, base64url (43 characters). */
const RANDOM_43 = /^[A-Za-z0-9_-]{43}$/;
export const isRandomToken = (value: unknown): value is string =>
  typeof value === "string" && RANDOM_43.test(value);
export const randomToken = (): string => randomBytes(32).toString("base64url");

export const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

export const cookieName = (base: string, secure: boolean): string =>
  secure ? `__Host-${base}` : base;

/** The value of exactly `name` in a Cookie header; a repeated name is ambiguous, so `undefined`. */
export const readCookie = (header: unknown, name: string): string | undefined => {
  if (typeof header !== "string" || header.length > 8192) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(eq + 1).trim();
  }
  return found;
};

export interface CookieOptions {
  readonly secure: boolean;
  /** Seconds; 0 deletes the cookie. */
  readonly maxAgeSeconds: number;
}

/** `Path=/`, HttpOnly, SameSite=Lax, Secure (except the dev exception), no Domain. */
export const serializeCookie = (base: string, value: string, options: CookieOptions): string =>
  [
    `${cookieName(base, options.secure)}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");

export const clearCookie = (base: string, secure: boolean): string =>
  serializeCookie(base, "", { secure, maxAgeSeconds: 0 });

const mac = (secret: Buffer, label: string, message: string): Buffer =>
  createHmac("sha256", secret).update(`${label}\n${message}`, "utf8").digest();

const equal = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/**
 * The synchronizer token for a session: HMAC(secret, session token). Bound to that one session
 * (a new session gets a new one), readable only by Rocky's own pages through `GET /api/session`,
 * and never stored.
 */
export const csrfTokenFor = (secret: Buffer, sessionToken: string): string =>
  mac(secret, "rocky-csrf-v1", sessionToken).toString("base64url");

export const csrfTokenMatches = (
  secret: Buffer,
  sessionToken: string,
  presented: unknown,
): boolean =>
  typeof presented === "string" &&
  RANDOM_43.test(presented) &&
  equal(Buffer.from(presented, "base64url"), mac(secret, "rocky-csrf-v1", sessionToken));

/** What the login cookie binds to this browser: the state and the PKCE verifier. */
export interface LoginBinding {
  readonly state: string;
  readonly verifier: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** `v1.<state>.<verifier>.<expiresAt>.<mac>`; every part base64url or digits, so no escaping. */
export const encodeLoginCookie = (secret: Buffer, binding: LoginBinding): string => {
  const body = `v1.${binding.state}.${binding.verifier}.${binding.expiresAt}`;
  return `${body}.${mac(secret, "rocky-login-v1", body).toString("base64url")}`;
};

const LOGIN_VALUE =
  /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/;

/** The binding, only when the MAC verifies and it has not expired at `nowMs`. */
export const decodeLoginCookie = (
  secret: Buffer,
  value: string | undefined,
  nowMs: number,
): LoginBinding | undefined => {
  const match = value === undefined ? null : LOGIN_VALUE.exec(value);
  if (match === null) return undefined;
  const [, state, verifier, expires, presented] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const body = `v1.${state}.${verifier}.${expires}`;
  if (!equal(Buffer.from(presented, "base64url"), mac(secret, "rocky-login-v1", body))) {
    return undefined;
  }
  const expiresAt = Number(expires);
  if (nowMs >= expiresAt * 1000) return undefined;
  return { state, verifier, expiresAt };
};

/** Constant-time equality of two strings of any length (hashed first). */
export const sameSecret = (a: string, b: string): boolean => equal(sha256(a), sha256(b));
