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
   `_` and `-` removed) and matched by **exact name, suffix, prefix or substring**
   (`SENSITIVE_KEYS` + `SENSITIVE_KEY_RULES`): `*token`, `*secret`, `*password`, `*passwd`,
   `*pwd`, `*apikey`, `*cookie`, `*hunk`, `*patch`, `*dsn`, `diff*`, `*credential*`, plus exact
   names such as `pass`, `pwd`, `dsn`, `authorization`, `email`, `code`, `body`, `content`,
   `text`, `prompt`, `messages`. So `githubToken`, `x-access-token`, `dbPassword`, `diff_hunk`
   and `awsCredentials` are all redacted, at any depth. Over-matching is the intended failure
   mode (a `dispatch` field is redacted too). Bounded: depth 8, 1000 nodes per log call, cycles
   replaced by `[circular]`.
3. **Value scrubbing** (`scrubSecrets`): anything that _looks_ like a secret inside free text
   (messages, error messages, stacks, URLs): URL userinfo (`postgres://user:pass@host`,
   `https://x-access-token:ghs_…@github.com`), GitHub tokens (`ghp_ gho_ ghs_ ghu_ ghr_
github_pat_`), Anthropic `sk-ant-` keys, generic `sk-` keys, JWTs, emails (alphabetic TLD only,
   so `pino@10.4.0` is left alone), PEM private-key blocks, AWS access and secret keys,
   `Bearer`/`bearer`, GitHub's `Authorization: token …` scheme and `token <40 hex>`, `Basic …`.
   Replaced with `[redacted:<kind>]`. Every regex is one bounded character-class run between
   literals (no nested quantifiers).

### Values that are not plain data

Class instances are **never passed through** to pino (their getters and `toJSON` would run
inside the serializer and their fields would escape redaction): `Error` → `{type, message,
stack, …own props}` scrubbed; `URL` → `protocol//host/path` with no userinfo, query or fragment
and a scrubbed path; `Map`, `Set`, `Headers` → plain objects/arrays, then walked; `Buffer` and
other binary views → `[object Buffer]`; anything with `toJSON` → its result, walked; everything
else → `[object ClassName]`. Fastify's `req`/`res` go through their allowlist serializers first
and the result is walked.

### Bounds per log call

Each string is scanned over at most `MAX_STRING_LENGTH + SCAN_MARGIN` (8 KiB + 4 KiB)
characters, then cut to 8 KiB, so a secret straddling the cut is still caught and the work per
string is constant. A whole call scans at most `MAX_CHARS_PER_CALL` (64 KiB) of text; further
strings become `[truncated N chars: log call budget exhausted]`. 999 strings of 1 MiB log in a
few milliseconds (tested under 250 ms).

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
- Child loggers: `log.child({...})` bindings go through the same redaction and scrubbing
  (`createLogger` wraps `child`; grandchildren inherit it).
- Jobs and other entry points: `withRequestId(log, id?)`.
- OpenTelemetry: when a span is active, `trace_id`, `span_id` and `trace_flags` are added
  (`@opentelemetry/api` only; a no-op without an SDK). A log call cannot override them.

## Testing new log lines

Use `createLogger(name, { destination })` with an in-memory sink and assert on the parsed JSON.
Fake secrets for tests come from `packages/log/src/fixtures.ts`; they are assembled at runtime so
gitleaks never sees a token-shaped literal. Keep it that way. `hardening.test.ts` holds one
regression test per finding of the P2-4 review.
