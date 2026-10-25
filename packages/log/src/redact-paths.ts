/** Replacement for a redacted field. Value-level scrubbing uses `[redacted:<kind>]` instead. */
export const REDACTED = "[redacted]";

/**
 * Field names whose values never reach a log line, wherever they appear. Matching is
 * case-insensitive and ignores `_` and `-`, so `access_token`, `accessToken` and `Access-Token`
 * are the same key. Three families: credentials, personal data, and PR/LLM content (code, diffs,
 * prompts), which is untrusted input and often contains secrets of its own.
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    // credentials
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "installationtoken",
    "oauthtoken",
    "apikey",
    "apisecret",
    "secret",
    "secretkey",
    "clientsecret",
    "webhooksecret",
    "signingsecret",
    "signingkey",
    "privatekey",
    "password",
    "passwd",
    "passphrase",
    "authorization",
    "proxyauthorization",
    "cookie",
    "setcookie",
    "xapikey",
    "xhubsignature256",
    "session",
    "sessionid",
    // personal data
    "email",
    "emails",
    "useremail",
    // PR content and prompt bodies
    "diff",
    "diffs",
    "patch",
    "patches",
    "hunk",
    "hunks",
    "code",
    "source",
    "snippet",
    "content",
    "body",
    "text",
    "prompt",
    "prompts",
    "system",
    "systemprompt",
    "messages",
    "completion",
    "suggestion",
  ].map((key) => normaliseKey(key)),
);

export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEYS.has(normaliseKey(key));

/**
 * Error-code identifiers (`ECONNRESET`, `ERR_STREAM_PREMATURE_CLOSE`, `23505`, `P2002`) may stay
 * under a `code` key: they are needed to operate the service and cannot be source code. Anything
 * else under `code` is redacted. Long runs without `_` are rejected so an AWS access key or hex
 * string does not slip through.
 */
export const isErrorCodeIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  (/^[A-Z0-9][A-Z0-9]{0,11}$/.test(value) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,8}$/.test(value));

/**
 * Pino's native path redaction: the fast first layer, applied before serialisation. Wildcards
 * match one level, so the deep scrub in `scrub.ts` covers deeper nesting; specific header paths
 * are listed because serializers emit them under `req`/`res`.
 */
const TOP_LEVEL = [
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "password",
  "secret",
  "authorization",
  "cookie",
  "email",
  "diff",
  "patch",
  "code",
  "prompt",
  "messages",
  "body",
  "content",
];

export const REDACT_PATHS: readonly string[] = [
  ...TOP_LEVEL,
  ...TOP_LEVEL.map((key) => `*.${key}`),
  "*.idToken",
  "*.installationToken",
  "*.clientSecret",
  "*.client_secret",
  "*.privateKey",
  "*.private_key",
  "*.hunks",
  "*.snippet",
  "*.source",
  "*.prompts",
  "*.system",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
];
