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

/** Normalised-key patterns, applied after the exact set. Exported so docs and tests can list them. */
export const SENSITIVE_KEY_RULES = {
  suffixes: [
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "apikey",
    "cookie",
    "hunk",
    "patch",
    "dsn",
  ],
  prefixes: ["diff"],
  substrings: ["credential"],
} as const;

export const isSensitiveKey = (key: string): boolean => {
  const k = normaliseKey(key);
  return (
    SENSITIVE_KEYS.has(k) ||
    SENSITIVE_KEY_RULES.suffixes.some((s) => k.endsWith(s)) ||
    SENSITIVE_KEY_RULES.prefixes.some((p) => k.startsWith(p)) ||
    SENSITIVE_KEY_RULES.substrings.some((s) => k.includes(s))
  );
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
