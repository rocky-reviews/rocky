# Logging

Rule (Definition of Done): **logs never contain code, diffs, tokens, emails or prompts.**
`@rocky-reviews/log` (P2-4) enforces it with three independent layers; every service must log
through `createLogger` and never through `console` (ESLint `no-console`, tested in
`scripts/lint-rules.test.ts`; only `scripts/**` may print).

## What must never reach the logger

> **Key-name redaction and value scrubbing are a best-effort safety net, not the control.**
> The rule for code is: **request bodies, diffs, file contents, prompts and model output are
> never passed to the logger at all.** Log ids, sizes and hashes instead: `{ prId, files: 12,
diffBytes: 48213, promptSha256 }`, not `{ diff }` or `{ prompt }`. A field name the rules do
> not recognise, a token in an unexpected shape, or a string that does not look like a secret
> will get through; the net exists for mistakes, not for routine use. Reviewers reject log
> lines that carry content, whatever the key is called (also stated in `CLAUDE.md`).

## Layers

1. **Field paths** (`REDACT_PATHS`, pino `redact`): tokens, passwords, API keys, cookies,
   authorization headers, `email`, `diff`, `patch`, `code`, `prompt`, `messages`, `body`,
   `content`, plus the request/response header paths Fastify emits. Fast, runs before
   serialisation, also applied to child bindings by pino itself.
2. **Deep key redaction** (`isSensitiveKey`, `scrubValue`): keys are normalised (lower-case,
   `_` and `-` removed) and matched in every **variant** (trailing digits or `v2` removed, one
   trailing `s` or `es` removed), in this order:
   1. exact names (`SENSITIVE_KEYS`) and the hard prefixes `authorization*`, `authheader*`,
      `authtoken*` → redacted, no allowlist can rescue them;
   2. the allowlist (`ALLOWED_KEYS`: `statusCode errorCode exitCode requestId inputTokens
outputTokens promptTokens completionTokens totalTokens maxTokens tokenCount promptId
promptVersion promptHash resource`; `ALLOWED_KEY_PREFIXES`: `author*` unless the rest is
      itself sensitive, so `authorLogin` is kept and `authorEmail` is not) → kept, value still
      scrubbed as text;
   3. suffixes `token secret password passwd pwd apikey key pem cookie auth jwt signature dsn
email diff hunk patch content body text message prompt snippet code output source`, prefixes
      `diff patch code prompt`, substrings `credential privatekey` → redacted.

   So `githubToken`, `accessTokens`, `apiKeyV2`, `token2`, `x-access-token`, `dbPassword`,
   `byokKey`, `idempotencyKey`, `cacheKey`, `privateKeyPem`, `basicAuth`, `oauth2`,
   `authHeader`, `oauth_code`, `rawDiff`, `diff_hunk`, `filePatches`, `requestBody`,
   `responseText`, `fileContent`, `sourceCode`, `codeBlock`, `llmMessages`, `modelOutput`,
   `userPrompt`, `promptText` and `awsCredentials` are all redacted, at any depth.
   **Over-matching is the policy** (`countryCode`, `publicKey`, `context`, `dispatch` are
   redacted too). Two keys are **scrub-only** (`SCRUB_ONLY_KEYS`): `message` and `msg` keep a
   scrubbed value, so pino's message, `err.message` and API error bodies (`{ message, code }`)
   stay readable; `messages`, `errorMessages`, `llmMessages` are still redacted. Bounded: depth 8,
   1000 nodes per log call, cycles replaced by `[circular]`.

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
else → `[object ClassName]`. Every property read, including on the top-level merge object,
happens inside a try: a throwing getter yields `[unreadable]` for that property (or the opaque
form for an instance) and never makes a log call throw. An own `__proto__` key (from JSON input)
is emitted as `[__proto__]`: assigning it would replace the prototype, and pino's own redact
copy drops a depth-1 own `__proto__`, so the rename keeps the data. Fastify's `req`/`res` go
through their allowlist serializers first and the result is walked.

### Bounds per log call

Each string is scanned over at most `MAX_STRING_LENGTH + SCAN_MARGIN` (8 KiB + 4 KiB)
characters, then cut to 8 KiB, so a secret straddling the cut is still caught and the work per
string is constant. Keys are scanned over `MAX_KEY_LENGTH + KEY_SCAN_MARGIN` (256 + 512) then cut
to 256, for the same reason. A whole call scans at most `MAX_CHARS_PER_CALL` (64 KiB) of text,
**message and interpolation values first** so a large payload cannot wipe out the message;
further strings become `[truncated N chars: log call budget exhausted]`. 999 strings of 1 MiB,
or 50 keys of 1 MB, log in milliseconds (tested under a loose 2 s bound, against the 126 s
stall the review found).

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
regression test per finding of the P2-4 review passes (`F1`–`F9`, `N1`–`N11`).
