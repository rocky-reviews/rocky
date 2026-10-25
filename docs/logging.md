# Logging

Rule (Definition of Done): **logs never contain code, diffs, tokens, emails or prompts.**
`@rocky-reviews/log` (P2-4) enforces it with three independent layers; every service must log
through `createLogger` and never through `console` (ESLint `no-console`, tested in
`scripts/lint-rules.test.ts`; only `scripts/**` may print).

## Layers

1. **Field paths** (`REDACT_PATHS`, pino `redact`): tokens, passwords, API keys, cookies,
   authorization headers, `email`, `diff`, `patch`, `code`, `prompt`, `messages`, `body`,
   `content`, plus the request/response header paths Fastify emits. Fast, runs before
   serialisation.
2. **Deep key redaction** (`SENSITIVE_KEYS`, `scrubValue`): the same families at **any depth**,
   case-insensitive and ignoring `_`/`-` (`access_token` = `accessToken`). Bounded: depth 8,
   1000 nodes per line, cycles replaced by `[circular]`. `Error` instances are serialised here
   (type, message, stack, own properties) so their text is scrubbed too.
3. **Value scrubbing** (`scrubSecrets`): anything that _looks_ like a secret inside free text
   (messages, error messages, stacks, URLs): GitHub tokens (`ghp_ gho_ ghs_ ghu_ ghr_
github_pat_`), Anthropic `sk-ant-` keys, generic `sk-` keys, JWTs, emails, PEM private-key
   blocks, AWS access and secret keys, `Bearer`/`Basic` credentials. Replaced with
   `[redacted:<kind>]`. Every regex is one bounded character-class run between literals (no
   nested quantifiers), strings over 1 MiB are not scanned at all, and emitted strings are cut at
   8 KiB after scrubbing.

One deliberate exception: a `code` key keeps **error-code identifiers** (`ECONNRESET`,
`ERR_STREAM_PREMATURE_CLOSE`, `23505`, `P2002`) because operators need them; anything else under
`code` is redacted (`isErrorCodeIdentifier`).

## Request ids and tracing

- HTTP: `Fastify(fastifyLoggerOptions(log))` + `addRequestIdHeader(app)` (from
  `@rocky-reviews/log/fastify`). Every line of a request carries `requestId` (server-generated
  UUID; client `x-request-id` is ignored), the id is returned in the `x-request-id` response
  header, and Fastify's own lines log only `method` and `url` **without the query string**
  (OAuth codes live there); no headers, no client IP.
- Jobs and other entry points: `withRequestId(log, id?)`.
- OpenTelemetry: when a span is active, `trace_id`, `span_id` and `trace_flags` are added
  (`@opentelemetry/api` only; a no-op without an SDK). A log call cannot override them.

## Testing new log lines

Use `createLogger(name, { destination })` with an in-memory sink and assert on the parsed JSON.
Fake secrets for tests come from `packages/log/src/fixtures.ts`; they are assembled at runtime so
gitleaks never sees a token-shaped literal. Keep it that way.
