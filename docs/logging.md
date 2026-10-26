# Logging

Rule (Definition of Done): **logs never contain code, diffs, tokens, emails or prompts.**
`@rocky-reviews/log` (P2-4) enforces it with three independent layers; every service must log
through `createLogger` and never through `console` (ESLint `no-console`, tested in
`scripts/lint-rules.test.ts`; only `scripts/**` may print).

## Layers

1. **Field paths** (`REDACT_PATHS`, pino `redact`): tokens, passwords, API keys, cookies,
   authorization headers, `email`, `diff`, `patch`, `code`, `prompt`, `messages`, `body`,
   `content`, plus the request/response header paths Fastify emits. Fast, runs before
   serialisation, also applied to child bindings by pino itself.
2. **Deep key redaction** (`isSensitiveKey`, `scrubValue`): keys are normalised (lower-case,
   `_` and `-` removed) and matched, both as written and with one trailing `s` removed, by
   **exact name, suffix, prefix or substring** (`SENSITIVE_KEYS` + `SENSITIVE_KEY_RULES`):
   - suffixes: `token secret password passwd pwd apikey key pem cookie auth jwt signature dsn
diff hunk patch content prompt snippet code`
   - prefixes: `diff auth prompt`; substrings: `credential privatekey`
   - exact names such as `pass`, `pwd`, `dsn`, `authorization`, `email`, `body`, `text`,
     `messages`, `system`.

   So `githubToken`, `accessTokens`, `apiKeys`, `x-access-token`, `dbPassword`, `byokKey`,
   `privateKeyPem`, `authHeader`, `oauth_code`, `rawDiff`, `diff_hunk`, `fileContent`,
   `contents`, `sourceCode`, `codeSnippet`, `userPrompt`, `promptText` and `awsCredentials`
   are all redacted, at any depth. **Over-matching is the policy** (`countryCode`, `publicKey`
   and `dispatch` are redacted too); the small explicit **allowlist** `ALLOWED_KEYS` keeps what
   operators need: `statusCode`, `errorCode`, `exitCode`, `requestId`, `author`, the LLM
   metering counters (`inputTokens`, `outputTokens`, `promptTokens`, `completionTokens`,
   `totalTokens`, `maxTokens`, `tokenCount`), `idempotencyKey`, `cacheKey`. Values under
   allowlisted keys are still scrubbed as text. Bounded: depth 8, 1000 nodes per log call,
   cycles replaced by `[circular]`.

3. **Value scrubbing** (`scrubSecrets`): anything that _looks_ like a secret inside free text
   (messages, error messages, stacks, URLs, **and object/Map keys**): URL userinfo
   (`postgres://user:pass@host`, `https://x-access-token:ghs_…@github.com`), GitHub tokens
   (`ghp_ gho_ ghs_ ghu_ ghr_ github_pat_`), Anthropic `sk-ant-` keys, generic `sk-` keys, JWTs,
   emails (alphabetic TLD only, so `pino@10.4.0` is left alone; URL-encoded `%40` forms too),
   PEM private-key blocks, AWS access and secret keys, `Bearer`/`bearer`, GitHub's
   `Authorization: token …` scheme and `token <40 hex>`, `Basic …`. Replaced with
   `[redacted:<kind>]`. Every regex is one bounded character-class run between literals (no
   nested quantifiers).

### Values that are not plain data

Class instances are **never passed through** to pino (their getters and `toJSON` would run
inside the serializer and their fields would escape redaction): `Error` → `{type, message,
stack, …own props}` scrubbed; `URL` → `protocol//host/path` with no userinfo, query or fragment
and a scrubbed path; `Map`, `Set`, `Headers` → plain objects/arrays, then walked; `Buffer` and
other binary views → `[object Buffer]`; anything with `toJSON` → its result, walked; everything
else → `[object ClassName]`. Every property read happens inside a try: a throwing getter yields
`[unreadable]` for that property (or the opaque form for an instance) and never makes a log
call throw. An own `__proto__` key (from JSON input) is kept as an ordinary property. Fastify's
`req`/`res` go through their allowlist serializers first and the result is walked.

### Bounds per log call

Each string is scanned over at most `MAX_STRING_LENGTH + SCAN_MARGIN` (8 KiB + 4 KiB)
characters, then cut to 8 KiB, so a secret straddling the cut is still caught and the work per
string is constant. Keys are cut to `MAX_KEY_LENGTH` (256) and scrubbed. A whole call scans at
most `MAX_CHARS_PER_CALL` (64 KiB) of text, **message and interpolation values first** so a
large payload cannot wipe out the message; further strings become
`[truncated N chars: log call budget exhausted]`. 999 strings of 1 MiB, or 50 keys of 1 MB, log
in milliseconds (tested under a loose 2 s bound, against the 126 s stall the review found).

### The `code` exception

A `code` key **on an Error** keeps error-code identifiers of these exact shapes:
`E[A-Z]+` (`ECONNRESET`), `ERR_[A-Z_]+`, a 5-character SQLSTATE (`23505`, `42P01`) and
`P\d{4}` (`P2002`). Anything else under `code`, and `code` on a plain object, is redacted.

## Request ids and tracing

- HTTP: `Fastify(fastifyLoggerOptions(log))` + `addRequestIdHeader(app)` (from
  `@rocky-reviews/log/fastify`). Every line of a request carries `requestId` (server-generated
  UUID; client `x-request-id` is ignored), the id is returned in the `x-request-id` response
  header, and Fastify's own lines log only `method` and a **scrubbed path without the query
  string** (`/invite/<token>` becomes `/invite/[redacted:github_token]`); no headers, no client
  IP. `/healthz` runs at `logLevel: "warn"`, so probes are silent unless they fail.
- Child loggers: `log.child({...})` and `log.setBindings({...})` bindings go through the same
  redaction and scrubbing (`createLogger` wraps both methods; grandchildren inherit them).
- Jobs and other entry points: `withRequestId(log, id?)`.
- OpenTelemetry: when a span is active, `trace_id`, `span_id` and `trace_flags` are added
  (`@opentelemetry/api` only; a no-op without an SDK). A log call cannot override them.

## Testing new log lines

Use `createLogger(name, { destination })` with an in-memory sink and assert on the parsed JSON.
Fake secrets for tests come from `packages/log/src/fixtures.ts`; they are assembled at runtime so
gitleaks never sees a token-shaped literal. Keep it that way. `hardening.test.ts` holds one
regression test per finding of the two P2-4 review passes (`F1`–`F9`, `N1`–`N7`).
