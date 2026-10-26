/** Replacement for a redacted field. Value-level scrubbing uses `[redacted:<kind>]` instead. */
export const REDACTED = "[redacted]";

export const normaliseKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

/**
 * Field names whose values never reach a log line, wherever they appear. Matching works on the
 * normalised key (lower-case, `_` and `-` removed), so `access_token`, `accessToken` and
 * `Access-Token` are the same key, and it matches by exact name, suffix, prefix or substring
 * (`githubToken`, `x-access-token`, `dbPassword`, `diff_hunk`, `awsCredentials` are all caught).
 * Three families: credentials, personal data, and PR/LLM content (code, diffs, prompts), which
 * is untrusted input and often contains secrets of its own. Over-matching is the intended
 * failure mode: a redacted `dispatch` field costs a lookup; a leaked token costs a rotation.
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    // credentials
    "token",
    "secret",
    "apikey",
    "apisecret",
    "privatekey",
    "signingkey",
    "password",
    "passwd",
    "passphrase",
    "pass",
    "pwd",
    "dsn",
    "credential",
    "credentials",
    "authorization",
    "proxyauthorization",
    "cookie",
    "cookies",
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
  ].map(normaliseKey),
);

/**
 * Normalised-key patterns, applied to the key and to its singular form (one trailing `s`
 * removed, so `tokens`, `apiKeys` and `contents` match). Exported so docs and tests can list them.
 */
export const SENSITIVE_KEY_RULES = {
  suffixes: [
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "apikey",
    "key",
    "pem",
    "cookie",
    "auth",
    "jwt",
    "signature",
    "dsn",
    "diff",
    "hunk",
    "patch",
    "content",
    "prompt",
    "snippet",
    "code",
  ],
  prefixes: ["diff", "auth", "prompt"],
  substrings: ["credential", "privatekey"],
} as const;

/**
 * Keys the rules above would catch but that must survive because operators need them. Small
 * and explicit; a value under an allowlisted key is still scrubbed as text. `code` is not here:
 * `scrub.ts` keeps it only on Errors and only for error-code identifiers.
 */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set(
  [
    "statusCode",
    "errorCode",
    "exitCode",
    "requestId",
    "author",
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "maxTokens",
    "tokenCount",
    "idempotencyKey",
    "cacheKey",
  ].map(normaliseKey),
);

const singular = (k: string): string => (k.length > 1 && k.endsWith("s") ? k.slice(0, -1) : k);

const matchesRules = (k: string): boolean =>
  SENSITIVE_KEYS.has(k) ||
  SENSITIVE_KEY_RULES.suffixes.some((s) => k.endsWith(s)) ||
  SENSITIVE_KEY_RULES.prefixes.some((p) => k.startsWith(p)) ||
  SENSITIVE_KEY_RULES.substrings.some((s) => k.includes(s));

export const isSensitiveKey = (key: string): boolean => {
  const k = normaliseKey(key);
  if (ALLOWED_KEYS.has(k)) return false;
  return matchesRules(k) || matchesRules(singular(k));
};

/**
 * Error-code identifiers may stay under a `code` key **of an Error**: Node (`ECONNRESET`,
 * `ERR_STREAM_PREMATURE_CLOSE`), Postgres SQLSTATE (`23505`, `42P01`) and Prisma-style
 * (`P2002`). Operators need them and none of these shapes can carry a secret or source code.
 * Everything else under `code` is redacted.
 */
export const isErrorCodeIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  (/^E[A-Z]+$/.test(value) ||
    /^ERR_[A-Z_]+$/.test(value) ||
    /^[0-9A-Z]{5}$/.test(value) ||
    /^P[0-9]{4}$/.test(value));

/**
 * Pino's native path redaction: the fast first layer, applied before serialisation (and to
 * child bindings). Wildcards match one level, so the deep scrub in `scrub.ts` covers deeper
 * nesting; specific header paths are listed because serializers emit them under `req`/`res`.
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
