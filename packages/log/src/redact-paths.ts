/** Replacement for a redacted field. Value-level scrubbing uses `[redacted:<kind>]` instead. */
export const REDACTED = "[redacted]";

export const normaliseKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

/**
 * Field names whose values never reach a log line, wherever they appear. Matching works on the
 * normalised key (lower-case, `_` and `-` removed) and on its variants (trailing digits or
 * `v2`-style version removed, one trailing `s` or `es` removed), by exact name, suffix, prefix
 * or substring: `githubToken`, `accessTokens`, `apiKeyV2`, `x-access-token`, `dbPassword`,
 * `diff_hunk`, `filePatches`, `requestBody`, `modelOutput` and `awsCredentials` are all caught.
 * Three families: credentials, personal data, and PR/LLM content (code, diffs, prompts), which
 * is untrusted input and often contains secrets of its own. Over-matching is the intended
 * failure mode: a redacted `dispatch` or `context` field costs a lookup; a leaked token costs a
 * rotation. This is a safety net: see docs/logging.md for what must never be logged at all.
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
    "auth",
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
    // PR content, prompt bodies and model output
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
    "output",
    "suggestion",
  ].map(normaliseKey),
);

/**
 * Normalised-key patterns, applied to every variant of the key. `hardPrefixes` are checked
 * before the allowlist (so `authorizationHeader` can never be allowlisted by `author*`); the
 * other patterns after it. Exported so docs and tests can list them.
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
    "email",
    "diff",
    "hunk",
    "patch",
    "content",
    "body",
    "text",
    "message",
    "prompt",
    "snippet",
    "code",
    "output",
    "source",
  ],
  prefixes: ["diff", "patch", "code", "prompt"],
  hardPrefixes: ["authorization", "authheader", "authtoken"],
  substrings: ["credential", "privatekey"],
} as const;

/**
 * Keys the rules above would catch but that must survive because operators need them. Small and
 * explicit; a value under an allowlisted key is still scrubbed as text. Opaque credentials end
 * up in `idempotencyKey`/`cacheKey`-style fields, so those are deliberately absent. `code` is
 * not here either: `scrub.ts` keeps it only on Errors and only for error-code identifiers.
 */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set(
  [
    "statusCode",
    "errorCode",
    "exitCode",
    "requestId",
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "maxTokens",
    "tokenCount",
    "promptId",
    "promptVersion",
    "promptHash",
    "resource",
  ].map(normaliseKey),
);

/** `author`, `authorLogin`, `authors`, … are kept unless the rest of the name is itself sensitive (`authorEmail`). */
export const ALLOWED_KEY_PREFIXES: readonly string[] = ["author"];

/**
 * Keys whose value is kept but scrubbed as text instead of being redacted: pino's `msg` and the
 * `message` of errors and API error bodies (`{ message, code }`) must stay readable. Plural and
 * compound forms (`messages`, `errorMessages`, `llmMessages`) are still redacted.
 */
export const SCRUB_ONLY_KEYS: ReadonlySet<string> = new Set(["message", "msg"]);

/** `token2` → `token`, `apikeyv2` → `apikey`. A loop, not a regex: keys are untrusted input. */
const stripVersionSuffix = (k: string): string => {
  let end = k.length;
  while (end > 0 && k.charCodeAt(end - 1) >= 48 && k.charCodeAt(end - 1) <= 57) end--;
  if (end < k.length && end > 0 && k[end - 1] === "v") end--;
  return k.slice(0, end);
};

/** The key, plus the same with trailing digits/version and one trailing `s`/`es` removed. */
const variants = (k: string): string[] => {
  const out = new Set<string>([k]);
  const base = stripVersionSuffix(k);
  if (base.length > 0) out.add(base);
  for (const b of [...out]) {
    if (b.length > 2 && b.endsWith("es")) out.add(b.slice(0, -2));
    if (b.length > 1 && b.endsWith("s")) out.add(b.slice(0, -1));
  }
  return [...out];
};

const matchesRules = (k: string): boolean =>
  SENSITIVE_KEYS.has(k) ||
  SENSITIVE_KEY_RULES.suffixes.some((s) => k.endsWith(s)) ||
  SENSITIVE_KEY_RULES.prefixes.some((p) => k.startsWith(p)) ||
  SENSITIVE_KEY_RULES.hardPrefixes.some((p) => k.startsWith(p)) ||
  SENSITIVE_KEY_RULES.substrings.some((s) => k.includes(s));

const isHardSensitive = (k: string): boolean =>
  SENSITIVE_KEYS.has(k) || SENSITIVE_KEY_RULES.hardPrefixes.some((p) => k.startsWith(p));

const isAllowed = (k: string): boolean =>
  ALLOWED_KEYS.has(k) ||
  ALLOWED_KEY_PREFIXES.some((p) => k.startsWith(p) && !matchesRules(k.slice(p.length)));

export const isSensitiveKey = (key: string): boolean => {
  const k = normaliseKey(key);
  if (SCRUB_ONLY_KEYS.has(k)) return false;
  const forms = variants(k);
  if (forms.some(isHardSensitive)) return true;
  if (forms.some(isAllowed)) return false;
  return forms.some(matchesRules);
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
