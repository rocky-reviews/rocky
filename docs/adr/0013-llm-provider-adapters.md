# ADR 0013: LLM provider adapters

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P4-2
- **Builds on:** [ADR 0004](0004-schema-first-llm.md) (schema-first output),
  [ADR 0012](0012-llm-roles-and-provider-port.md) (roles, config and the `LlmProvider` port)
- **Amended by:** H4-4 (the sent schema versus the validating schema, a prompt-mode delivery for
  the graph, and a content-free failure diagnostic; "Amendment (H4-4)" below); H4-5 (the graph
  asks for lanes, nodes and edges only and is an enforced output again; "Amendment (H4-5)" below)

## Context

ADR 0012 fixed the provider port and the config that picks a provider per role. This task adds the
adapters behind that port:

- the Anthropic API;
- Claude on Amazon Bedrock, Google Vertex AI and Microsoft Foundry;
- an OpenAI-compatible server (Ollama, vLLM).

Every one of them carries PR content to a third party, and most of them hold a credential. So the
adapters are where key leakage, provider-side retention, prompt-cache sharing, prompt injection,
SSRF and error-body leakage are either prevented or not.

API shapes come from the `claude-api` skill (cached 2026-10-06) and the platform pages it lists
(Bedrock, Vertex, Foundry and structured outputs, read 2026-10-27). They were checked against the
installed SDK sources.

## Decision

### 1. One Claude adapter core, four thin platform factories

`packages/llm/src/adapters/claude.ts` builds the request and maps the result for every Claude
platform. Each platform factory only builds its SDK client and maps the model id:

| Kind        | Client (package)                                       | Model sent when `platformModel` is unset                         | Credentials                                             |
| ----------- | ------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `anthropic` | `Anthropic` (`@anthropic-ai/sdk`)                      | canonical id                                                     | key from `SecretSource` by `apiKeyEnv`, per call        |
| `bedrock`   | `AnthropicBedrockMantle` (`@anthropic-ai/bedrock-sdk`) | `anthropic.<id>`                                                 | AWS default chain (SigV4) or `AWS_BEARER_TOKEN_BEDROCK` |
| `vertex`    | `AnthropicVertex` (`@anthropic-ai/vertex-sdk`)         | bare id; `claude-opus-4-5@20251101`, `claude-haiku-4-5@20251001` | Google application default credentials                  |
| `foundry`   | `AnthropicFoundry` (`@anthropic-ai/foundry-sdk`)       | canonical id (Foundry's default deployment name)                 | key from `SecretSource` by `apiKeyEnv`, per call        |

`platformModel` is sent verbatim when set: a Bedrock inference profile or ARN, a Vertex dated id,
or a Foundry deployment name.

- **Bedrock** uses the Mantle (Messages API) endpoint, the skill's recommended client. Mantle
  serves Opus 4.7 and later and Haiku 4.5. Opus 4.6, Opus 4.5 and Sonnet 4.6 exist only on the
  legacy `InvokeModel` integration, so the Bedrock catalogue leaves them out and config validation
  refuses them at boot.
- **Vertex** puts the model id in the URL path. So a Vertex `platformModel` may not contain `/`
  or `:`, and a Foundry one must be a deployment name (letters, digits, `.`, `_`, `-`; at most 64).
  Bedrock keeps ADR 0012's shape, because ARNs need `:` and `/`; Mantle sends the model in the body.

Every request has the same shape:

- **Transport:** always streamed (`client.beta.messages.stream(...).finalMessage()`) and
  accumulated internally. The skill requires streaming for large `max_tokens` (N9: 64K and more at
  `xhigh`/`max`), and one code path is simpler than two. The port's result is unchanged.
- **Bounds (T9):** every call has one deadline for the whole call (default 10 minutes, an
  `AbortController` timer cleared when the call ends, combined with the caller's signal). The
  call body (client construction, credential lookups, the SDK's auth middleware and the stream)
  is raced against that signal, so a Google or AWS credential source that never answers ends as
  `timeout` or `cancelled` too; the abandoned lookup takes no signal and is left to settle. The
  SDK's own `timeout` covers only the fetch and stops counting once headers arrive, so it cannot
  end a stream that keeps dripping or a hanging credential lookup.
  Each call's client gets a `fetch` that stops every response body after 16 MiB, error bodies
  included; past the cap the call fails as `server_error`. A stream that ends without
  `message_stop` is a dropped link (`network`), never a short answer.
- **Clients:** built per call over that call's capped `fetch`. The Bedrock, Vertex and Foundry
  SDKs (and `google-auth-library`) are imported on first use, so a worker that only uses the
  Anthropic API never loads the AWS or Google runtimes.
- **Structured outputs:** `output_config.format = { type: "json_schema", schema }`, on every
  catalogued model and platform (the structured-outputs page lists them all). The schema first
  goes through the SDK's public `jsonSchemaOutputFormat` helper, which strips constraints the API
  rejects (`minLength`, `minimum`, ...). The port's validator then checks the full schema, so a
  stripped constraint is still enforced. The role schemas are shaped for that helper by core
  (`providerJsonSchema`, amendment H4-4 below); a schema it still refuses fails the call as
  `invalid_request` before anything is sent. The full graph schema exceeded the API's grammar
  limits and was sent as text for a while (`mode: "prompt"`, amendment H4-4); since H4-5 the
  graph asks for lanes, nodes and edges only and is enforced like the other roles.
- **Effort:** `output_config.effort` when the role sets one. Config validation already refused
  levels the model lacks.
- **Thinking:** `thinking: { type: "adaptive" }` on every model that takes it. Haiku 4.5 and
  Opus 4.5 take only `budget_tokens`, so they run without thinking. Summaries are not requested:
  Rocky reads only the JSON answer.
- **Sampling:** no `temperature`, `top_p` or `top_k` (rejected on current models). No assistant
  prefill. **No tools and no `tool_choice`**, so the model has nothing to call.
- **Refusal fallbacks (Anthropic API only):** `fallbacks: "default"` with beta
  `server-side-fallback-2026-07-01`, as the skill says to include by default, on the models that
  take it: Fable 5.1, Opus 5.5, Opus 5 and Sonnet 5.5. Haiku 5.5 and older models get neither the
  parameter nor the beta header. On a policy decline the API re-runs the request on the model's
  server-defined fallback, inside the same call. `ROCKY_LLM_ANTHROPIC_FALLBACKS=off` turns it off,
  for a gateway at `baseUrl` that rejects the beta. Bedrock, Vertex and Foundry have no server-side
  fallback. Their client-side middleware needs a fallback model id valid on that platform (a
  deployment, an inference profile), which only the operator knows, so on those platforms a
  refusal is returned as `refused` (follow-up: a per-role fallback model setting).

### 2. Prompt layout, cache breakpoints and untrusted content

```text
system:   [ { text: <untrusted-content preamble> + instructions, cache_control: ephemeral 5m } ]
messages: [ { role: user, content: [
              <pr_content id="<nonce>" label="<label>"> … </pr_content id="<nonce>">  (one block per part)
              "Answer with one JSON document that matches the output schema." ] } ]
```

- **Instructions** are Rocky-authored and go only in `system`. PR content (`untrusted` parts)
  goes only in the user turn. It is never in the system slot, never in a tool, and never part of
  a cached prefix. "Rocky-authored" is a type, not a convention: `instructions` is a
  `RockyInstructions` value (ADR 0012 §1), which only the `rockyInstructions` template tag (literal
  text, no substitutions) and `joinInstructions` issue. Adapters refuse anything else with
  `invalid_request` before a request is built, so a PR title cannot become a system prompt by
  accident. P4-4 builds the full defence on this. `isRockyInstructions` (like `isLlmCallError`)
  relies on a single loaded copy of `@rocky-reviews/core`: a second copy would have its own
  registry and class, and its values would be refused (fail closed).
- **Delimiters:** each part is wrapped in a `pr_content` marker. The marker carries a per-call
  96-bit random id that PR content cannot predict, so a forged closing marker in a diff cannot end
  the block. Labels are Rocky-authored (N7) and checked against `^[a-z][a-z0-9_.:-]{0,63}$`; a bad
  label fails the call before anything is sent. The `system` preamble says that marked content is
  data, never instructions. It is fixed text, so the cached prefix stays byte-stable. The full
  injection defence (corpus, verdict invariants, leak guard) is [ADR 0015](0015-prompt-injection-defence.md), which moved the preamble to core.
- **Cache breakpoints:** exactly one, on the `system` block: Rocky's instructions for the role and
  nothing else. There is no top-level automatic caching, because that would place a breakpoint on
  the last block, which is PR content. TTL is the default 5 minutes. Pipeline calls that share a
  prefix start well under 5 minutes apart (one PR's triage and review run back to back), so the
  1-hour TTL's doubled write cost would buy nothing (the skill's TTL table). Prefixes below the
  model's minimum (512–4096 tokens) silently do not cache. That costs money, never correctness.
- **OpenAI-compatible** uses the same layout with plain chat messages and no cache markers.

### 3. Results

| Provider signal                                                               | Port result                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `stop_reason: refusal`; OpenAI `message.refusal` or `content_filter`          | `refused`                                              |
| `stop_reason: max_tokens` or `model_context_window_exceeded`; OpenAI `length` | `truncated`                                            |
| answer not JSON                                                               | `invalid_output`, issues `["(root): invalid_json"]`    |
| JSON that fails the validator                                                 | `invalid_output`, the validator's path-only issues     |
| any other stop (`tool_use`, `pause_turn`, `stop_sequence`)                    | `invalid_output`, issues `["(root): unexpected_stop"]` |
| `end_turn` / `stop` with valid JSON                                           | `ok`                                                   |

The answer is the text after the last `fallback` content block (a mid-stream decline keeps its
partial output before the block), with thinking blocks ignored. A fallback ran when there is a
`fallback` block **or** a `fallback_message` entry in `usage.iterations`: a sticky turn (served by
the fallback model from the start) has no block. A `message` iteration with `model: null` ran on
the requested model.

**Usage:**

- `input_tokens` → `inputTokens`, `output_tokens` → `outputTokens`, and
  `cache_read_input_tokens` → `cacheReadInputTokens`.
- `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` → the two cache-write
  fields. When a platform omits the breakdown, the total counts as 5-minute writes, the only TTL
  Rocky asks for.
- OpenAI-compatible: `prompt_tokens` less `prompt_tokens_details.cached_tokens` → input, cached →
  cache reads, and zero writes.

**Port change (minimal):** results may carry `attempts`, with the model and usage of every
attempt the provider **reported**, when a server-side fallback ran. The top-level `usage` covers
only the attempt that produced the answer, and `model` names the model that served it. A reported
attempt is not necessarily billed at list price: a decline before any output follows the
provider's "how refusals are billed" rules, and fallback attempts carry credit-style cache
repricing. So P4-5 prices `attempts` by those rules; it does not sum them. See ADR 0012 §1.

### 4. Errors

Every failure becomes an `LlmCallError` with a fixed message, no `cause` and no body. The only
data it carries is the kind and a retry-after hint (`retry-after-ms` or `retry-after`, seconds or
an HTTP date, capped at 24 h, retryable kinds only).

- **HTTP status first** (ADR 0012's table): 400 → `invalid_request`, or `context_too_long` when
  the provider says the prompt does not fit; 401 → `auth`; 402 → `billing`; 403 → `permission`;
  404 → `model_not_found`; 408 → `timeout`; 413 → `request_too_large`; 429 → `rate_limited`;
  529 → `overloaded`; other 5xx → `server_error`; other 4xx → `invalid_request`.
- **Mid-stream SSE errors** have no status; the error `type` decides (`overloaded_error`,
  `rate_limit_error`, `api_error`, ...).
- **Without a response:** an abort by the caller's signal → `cancelled`; the call deadline or an
  SDK timeout → `timeout`; a connection failure (including AWS credential-chain and Google
  credential failures) → `network`; a stream that ends without `message_stop` → `network`. An
  error the SDK wraps with a `cause` is `network` only when the cause is an I/O failure (fetch's
  `TypeError`, undici `terminated`, `ECONNRESET` and other socket codes); a `SyntaxError` from
  malformed event JSON stays `server_error`.
- **Broken install:** a platform SDK or `google-auth-library` that fails to import →
  `invalid_request` (fatal): retrying cannot fix it.
- **Broken answers:** a body past the byte cap, an OpenAI-compatible answer that is not a JSON
  object, and anything post-processing throws that is not an `LlmCallError` (a validator tripping
  on a hostile shape) → `server_error`.
- **Anything else** (an unexpected SDK or programming error) → `server_error`. It is never
  rethrown, because its message might quote a body.
- **Before the network:** a missing key → `auth`; a bad label, instructions that are not
  `RockyInstructions`, a refused environment switch (T1) or a non-positive or non-integer
  `maxOutputTokens` → `invalid_request`.

The context-window check reads the provider's message (`prompt is too long`, `context length`,
`maximum context`) only to choose the kind. No typed signal exists, and the text is dropped
afterwards.

**Retries:** the SDKs retry 408/409/429/5xx and connection errors twice by default, honouring
`retry-after`. That covers a blip. The queue (P4-3) owns longer retries, from `retryable` and
`retryAfterMs`.

### 5. OpenAI-compatible adapter (no SDK)

`POST {baseUrl}/chat/completions` and `POST {baseUrl}/embeddings` through `fetch`. The surface
Rocky needs is two endpoints with small, stable shapes, and Node has `fetch` built in. An `openai`
SDK would add a large dependency for that, and it reads `OPENAI_*` environment variables Rocky
must not honour.

- **Structured output:** `response_format: { type: "json_schema", json_schema: { name, schema,
strict: true } }` (Ollama and vLLM support it) plus the schema in the system message (ADR 0004:
  "for other providers the schema is in the prompt"). A server that ignores `response_format`
  still gets the schema in the prompt. **That is the documented fallback**, and the validator
  decides either way. It helps only servers that ignore `response_format`: vLLM answers 400 for a
  schema its guided-decoding backend cannot compile, and the prompt copy does not change that.
  Effort maps to `reasoning_effort`.
- **Requests:** non-streaming, with a 10-minute timeout. The response body is read through a
  16 MiB cap. The key, when configured, is sent as `Authorization: Bearer`, read per call. Every
  field of the answer is type-checked before use; a body that is not a JSON object is
  `server_error`.
- **Embeddings:** `encoding_format: "float"`. Each entry's `index` must be an integer, and the
  indices must be exactly `0..n-1`; vectors are placed by index. The count and width are checked
  against the request (`dimensions`). A mismatch is `invalid_request`, never a silently wrong or
  misattributed vector.

### 6. Dependencies

Exact versions, each the newest release past the workspace's 7-day `minimumReleaseAge`:

| Package                     | Version | Why                                                                                      |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `@anthropic-ai/sdk`         | 0.135.0 | Official SDK: streaming accumulation, typed errors, schema transform, beta params        |
| `@anthropic-ai/bedrock-sdk` | 0.35.0  | `AnthropicBedrockMantle`: SigV4 signing and the AWS credential chain (pulls the AWS SDK) |
| `@anthropic-ai/vertex-sdk`  | 0.21.0  | `AnthropicVertex`: Vertex URL rewriting and Google ADC (pulls `google-auth-library`)     |
| `@anthropic-ai/foundry-sdk` | 0.6.0   | `AnthropicFoundry`: resource URL and Foundry auth headers                                |
| `google-auth-library`       | 10.9.1  | Google ADC, built by Rocky so a failed lookup is retried (already in the Vertex tree)    |

The 1.x majors (API version `2026-10-21`, Apache-2.0) are under a week old. They also change
auth headers (`Authorization: Bearer` for keys), and Bedrock accepts `2026-10-21` only for 4.7
and later models: the Bedrock catalogue still has Haiku 4.5, so that upgrade must either keep
Bedrock on a `2023-06-01` version override or drop Haiku 4.5 from it. Moving to 1.x is a follow-up once they clear `minimumReleaseAge`. Rocky sends no
sampling parameters, so its requests already fit that version. `pnpm security:scan` (osv-scanner)
is clean for the added tree.

### 7. Wire-up

`providerAdapters(transport?)` returns the `ProviderAdapters` map for `createLlmRoles`. The
optional transport (`fetch`, retries, deadline, byte cap, nonce source, Bedrock credential
resolver, Vertex auth source) exists for tests. P4-3 calls `providerAdapters()` in the worker.

**Platform credentials.** Vertex: Rocky builds the Google auth client itself
(`GoogleAuth.getClient()`, cloud-platform scope) and hands it to `AnthropicVertex`. The Vertex
client would otherwise cache the lookup's promise in its constructor, rejection included, so one
failed metadata-server call would fail every later call. Rocky keeps a successful client (it
caches its token) and drops a failed lookup. Bedrock: the Mantle client resolves the AWS
credential chain on every request, so a failure is not cached. Credentials are not memoised
either; that costs a chain lookup per call (a local file or the instance metadata service), not
correctness. A lookup that fails late drops only itself, never a newer lookup that replaced it.

## Threat model

Assets: provider credentials (Anthropic and Foundry keys, AWS and Google credentials), PR
content (other tenants' code), Rocky's instructions, and the integrity of the analysis
(verdicts, findings).

Attackers: a PR author (hostile diff, title or comment), another tenant on the same instance, a
compromised or misconfigured endpoint or proxy, and anyone who reads logs, errors, traces or
fixtures.

| #   | Threat                                                                                                                                                                                                                        | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **Key leakage** through logs, errors, `inspect`, traces or fixtures.                                                                                                                                                          | Keys are read from `SecretSource` inside the call. The client holding a key is built per call and dropped, and never on the adapter object. SDK logging is off (`logLevel: "off"`, a silent logger), so `ANTHROPIC_LOG=debug` cannot turn it on. OpenTelemetry is off (`openTelemetry: false`), so SDK spans cannot copy prompts or headers into traces. Errors carry no `cause` or body. Fixtures hold placeholder auth only. Two switches cannot be turned off from code, so Rocky refuses to boot with them (and fails each call, before anything is sent, if they appear later): `ANTHROPIC_CUSTOM_HEADERS` (merged after Rocky's headers, so it could replace `x-api-key` or `Authorization`, and sent to every Claude platform) and, for Vertex, `GOOGLE_SDK_NODE_LOGGING` (google-auth-library debug logging prints token-endpoint traffic, access tokens included). The AWS SDK tree has no environment-driven logger. | `adapters/hygiene.test.ts`: a key in every key variable; every adapter's results, errors (message, stack, JSON, `inspect`), the adapter objects and every `console` call are checked; `ANTHROPIC_LOG=debug` is set; the fixture files are scanned with `scrubSecrets` and for the test key; `secrets.get` runs per call and never at construction. `claude.contract.test.ts` "refuses to run with ANTHROPIC_CUSTOM_HEADERS set" and "refuses GOOGLE_SDK_NODE_LOGGING on Vertex only". |
| T2  | **Ambient credentials** (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an `ant` profile) sent to the wrong host, or a profile choosing the base URL.                                                                           | `apiKey` comes only from `SecretSource`, and `authToken` is `null`. An explicit key also disables profile resolution. Vertex passes `apiKey: null` itself. Mantle never resolves Anthropic credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `claude.contract.test.ts`: every contract test runs with ambient Anthropic keys and base-URL variables set to an attacker's values, and "sends one structured, streamed request to the configured host only" checks the auth headers.                                                                                                                                                                                                                                                 |
| T3  | **SSRF / exfiltration via base URLs:** an env var (`ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`) or a redirect sends the key or PR content elsewhere. | Each adapter computes its base URL from validated config. Foundry and Vertex build it from shape-checked resource and region names, and Bedrock from the region. The gateway and OpenAI base URLs follow ADR 0012 §2 (https unless keyless or loopback). Every request uses `redirect: "error"`: a cross-origin redirect would keep `x-api-key`. Org overlays still may not set URLs (ADR 0012 §7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Contract tests assert the exact host per platform with those variables set to an attacker host. The fetch init has `redirect: "error"`.                                                                                                                                                                                                                                                                                                                                               |
| T4  | **Path injection through the model id:** Vertex puts the model in the URL path.                                                                                                                                               | Vertex `platformModel` without `/` or `:`; Foundry deployment-name shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `config.test.ts` / `env.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| T5  | **Prompt-cache cross-tenant leakage:** with the instance key, all tenants share one workspace cache, and a hit on another tenant's PR prefix is a timing side channel.                                                        | The only breakpoint is on Rocky's instructions. No top-level `cache_control`, and untrusted parts are never cached. Caches are never shared across Anthropic organizations or workspaces (BYOK isolates fully).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Contract test "caches only Rocky's instructions".                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| T6  | **Injection via untrusted parts:** PR content posing as instructions, closing its delimiter, or reaching tools.                                                                                                               | Untrusted parts only in the user turn, each in a nonce-delimited marker. Instructions must be `RockyInstructions` (literal templates only; lint bans calling the tag directly). The system preamble marks them as data. No tools and no `tool_choice` are sent. Output is schema-validated data (ADR 0004). Labels are validated. Full defence: ADR 0015.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `untrusted.test.ts` (forged closing marker, nonce not in content, label rules, unbranded instructions), `core/src/llm.test.ts` (no substitutions, forged template arrays) and the contract tests (no `tools`, instructions not in `messages`, PR text not in `system`).                                                                                                                                                                                                               |
| T7  | **Error-body leakage:** provider bodies echo prompts, keys or account ids.                                                                                                                                                    | `LlmCallError` takes only a kind and a retry hint; SDK errors are never rethrown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Error-mapping tables per adapter, with bodies containing the key and PR text, assert clean errors.                                                                                                                                                                                                                                                                                                                                                                                    |
| T8  | **Provider-side data retention:** PR content is retained by the provider.                                                                                                                                                     | Not preventable in code. It is a deployment choice, documented per platform: Anthropic API (org retention settings; Fable 5.x needs 30-day retention), Bedrock and Vertex (governed by AWS and Google; Bedrock has zero operator access), Foundry (Anthropic acts as processor for Microsoft; Hosted-on-Azure keeps prompts in Azure).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `needs-human`: the DPA and subprocessor list (P10).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T9  | **Hostile or broken endpoint:** a huge body, a hang, a stream that never ends, or a malformed answer exhausts the worker or escapes as a raw error.                                                                           | One deadline per call covering the whole stream (10 min; the SDK's own timeout stops at headers), a 16 MiB cap on every response body on both adapters (Claude through a counting `fetch`), `network` for a stream cut before `message_stop`, and type checks on every OpenAI-compatible field with a `server_error` catch-all. `max_tokens` does not bound a hostile server, so it is not relied on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `claude.contract.test.ts` "ends a stream that keeps dripping at the call deadline", "the call deadline covers credential acquisition" (hanging Vertex auth, Vertex headers and Bedrock credentials → `timeout` / `cancelled`), "stops reading a response past the byte cap", "treats a stream that ends without message_stop as a network failure"; `openai-compatible.contract.test.ts` "refuses an oversized body" and "malformed answers never escape as raw errors".              |
| T10 | **Malformed output treated as truth.**                                                                                                                                                                                        | Every answer goes through the port's validator. Refusals and truncations never parse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Contract tests per stop reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Residual risks:**

- The context-window check matches provider message text, which is not documented as stable.
  At worst a too-long input is reported as `invalid_request` (fatal) instead of
  `context_too_long` (also fatal).
- `NODE_DEBUG=http,fetch` (Node's own debug output) can print request URLs and paths. It does not
  print headers or bodies; URLs carry no key.
- **Process-wide switches stay operator responsibility (T1, T3).** Rocky refuses only the two
  variables that undo its own client options. These change the whole process and are the
  operator's to keep unset or trusted: `NODE_TLS_REJECT_UNAUTHORIZED=0` (no TLS verification),
  `NODE_EXTRA_CA_CERTS` (extra trusted CAs), `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` (gaxios
  honours proxies for the Google token endpoint), and `GCE_METADATA_HOST` / `GCE_METADATA_IP`
  (they redirect where ADC fetches its token). The self-host docs (P10-3) name them.
- **The acceptance criterion "recorded responses" is only partly met.** The fixtures are
  documentation-shaped (built from the API reference and SDK types), and the recording gate in
  `packages/llm/fixtures/README.md` says how to replace them. Recording real responses needs
  provider accounts (`needs-human`). The most important ones: Anthropic `end_turn` and `refusal`
  streams and one prompt-too-long 400.
- Fallback attempts are reported, not priced: pricing them by the provider's refusal and credit
  rules is P4-5.
- The OpenAI-compatible request is non-streaming, so a server slower than undici's 300-second
  header timeout fails as `network`.

## Amendment (H4-4): the sent schema and the validating schema

**Context.** Dogfooding on a real PR: triage succeeded and the graph call failed in 17 ms, before
any request, and the analysis ended as `internal_error`. Three provider-side limits stand between
the graph schema and Anthropic structured outputs, found one behind the other with an offline
probe (`max_tokens: 1`; a 400 is unbilled):

1. **The SDK's transform** (`jsonSchemaOutputFormat` → `transformJSONSchema`) refuses any
   subschema with neither a `type` nor a combinator. The graph schema carries three hand-written
   "at least one of" constraints, added with `.meta()` for the published analysis-document
   schema: `Payload` (`anyOf: [{ required: ["request"] }, { required: ["response"] }]`) and the
   `selection` variant of `ViewScope` and `StepFocus`
   (`anyOf: [{ properties: { lanes: { minItems: 1 } }, required: ["lanes"] }, …]`). Each is a
   combinator **beside a `type`** whose variants have no `type`. The thrown value was a plain
   `Error`, not an `LlmCallError`, so it escaped the port and the pipeline's catch-all mapped it
   to `internal_error` with no detail (by design: an unknown error's text could quote content).
2. **The API refuses recursive definitions** ("Circular reference detected in schema
   definitions: JsonValue -> JsonValue"): the drill-down `View` tree and the JSON `sample`
   value. Unrolling them a bounded number of levels gets past this and into the next limit.
3. **The API's grammar limits.** An enforced schema is compiled into a grammar: at most 24
   optional parameters in a request (the graph has 47 even with every defaulted field made
   required and the recursion unrolled once), and an internal grammar-size limit that lanes +
   nodes + edges pass but flows, views or a walkthrough on top of them do not (the probe:
   lanes/nodes/edges with one level of views and no walkthrough compiles; adding either the
   flows or the walkthrough fails with "The compiled grammar is too large"). The limits are
   documented on the structured-outputs page (schema complexity limits; 24 optional, 16
   union-typed parameters).

Triage, review and briefing compile (the probe returns 200 for each). The real-model evals did
not catch any of this: the job skips itself when `ROCKY_EVALS_ANTHROPIC_API_KEY` is unset in the
environment (every run so far), and even with the key a failed subject is scored, not fatal, and
the placeholder live baseline turns the gate into a warning.

**Decision.**

1. **Two schemas, one validator.** A role's `LlmOutputSchema.jsonSchema` is the schema **sent**
   to a provider; `parse` is the Zod schema itself and is the only validation. The sent schema
   is the Zod emission (`z.toJSONSchema`, input side) passed through core's
   `providerJsonSchema` (`packages/core/src/analysis/provider-schema.ts`): a combinator beside a
   `type` is folded into the description, in the SDK's own `{key: json}` style for constraints
   it strips, and removed from the schema. Zod never emits that shape itself (a union is a bare
   combinator; an enum is `type` + `enum`), so the rule touches only `.meta()` constraints. A
   bare combinator is a union and stays. Giving the variants `type: "object"` was rejected: the
   SDK closes every object (`additionalProperties: false`, `properties: {}`), so such a variant
   would forbid every property and the schema would be unsatisfiable. The published
   analysis-document JSON Schema (`packages/schema/json-schema/`) is a different emission and is
   unchanged. The OpenAI-compatible adapter sends the same `jsonSchema`.
2. **Two delivery modes.** `LlmOutputSchema.mode` is `structured` (default: the provider
   enforces the schema, as §1 says) or `prompt`: the serialised schema follows Rocky's
   instructions in the system slot (`systemPromptWithSchema`: it is Rocky-authored and static, so
   it sits inside the one cached block, T5) behind the fixed line `SCHEMA_PREAMBLE`, the final
   line is `FINAL_INSTRUCTION_PROMPT_SCHEMA` ("only one JSON document … no code fences"), and no
   `output_config.format` is sent. The mode is a request to the adapter, which decides how to
   honour it: today only the Claude adapter does; the OpenAI-compatible adapter still sends
   every output as a strict `response_format` (follow-up in `docs/progress.md`). Both lines are in `PROMPT_TEXTS` for the leak guard (ADR
   0015); the schema JSON is not, since an answer legitimately repeats its field names. The graph
   is the one prompt-mode output (`GRAPH_OUTPUT`), because no projection of it compiles (limits 2
   and 3) short of dropping flows, views or the walkthrough, which is a product decision, not a
   provider fix. A prompt-mode answer may arrive inside a Markdown fence: for a prompt-mode output only,
   `toResult` removes one fence that encloses the whole answer and nothing else (`unfenced`); the validator judges the
   content, and an answer that misses the schema is `invalid_output` with a repair round (ADR
   0014), exactly as for an enforced output. `PIPELINE_VERSION` is bumped (the graph prompt
   changed).
3. **Fail closed, typed.** `wireSchema` in the Claude adapter wraps the SDK transform: a schema
   it refuses is `LlmCallError("invalid_request", { origin: "sdk_schema_transform" })`, raised
   before anything is sent, with none of the SDK's text. The port's promise (only `LlmCallError`
   leaves an adapter) holds for this path too.
4. **A content-free diagnostic.** `LlmCallError` gains an optional `origin`, a fixed tag an
   adapter writes in source, checked against `^[a-z][a-z0-9_]{0,31}$` (a `RangeError`
   otherwise). A failed `AnalysisOutcome` may carry `diagnostic: { origin, errorClass? }`: the
   adapter's origin for a fatal `LlmCallError`, or `pipeline` plus the thrown value's class name
   for the catch-all: read only from a real `Error`, from its prototype's constructor function,
   matching `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$`, else `unknown` (primitives, plain objects, proxies
   and planted own properties never name a class). The worker logs them as `errorOrigin` and
   `errorClass` on "analysis failed", next to `errorCode` (the line used `code`, which the log
   scrubber redacts: the failure code never reached the log; "analysis requeued" had the same
   defect); the CLI prints `analysis failed: <code> (<origin>[, <class>])`. A message is never
   read.
5. **Regression test on the SDK's own transform.** `packages/llm/src/adapters/wire-schema.test.ts`
   runs `jsonSchemaOutputFormat` over every stage's output schema (`STAGE_CALLS`), prompt-mode
   ones included, so switching a role between modes stays safe, and asserts the result has no
   open object, no type beside a combinator and (for enforced roles) no `$defs` cycle; it fails
   on the previous `main`. `packages/core/src/analysis/provider-schema.test.ts` covers the fold
   and that the moved constraints are still enforced by `parse`. The adapter contract tests
   exercise prompt mode with the fixtures' toy verdict schema, not the graph schema; the
   graph's own shape is covered by the transform test and the real run. The grammar limits (3) have no
   offline oracle: the evidence is the probe and a completed real run on a private dogfooding
   pull request, recorded in `docs/progress.md`.

**Threat model (adds to the table above).**

| #   | Threat                                                                                                                                                                                                                                                                                | Prevention                                                                                                                                                                                                                                                                                              | Test                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | **A sent schema the provider transform refuses**, so every analysis fails (this bug), or a future `.meta()` constraint brings it back.                                                                                                                                                | `providerJsonSchema` on every stage schema; the Claude adapter maps a refused schema to a typed `invalid_request` with an origin tag before any request.                                                                                                                                                | `wire-schema.test.ts` (the real SDK transform on every role; a refused schema sends nothing and carries no SDK text).                                                                                                                                                                                                                                                                            |
| S2  | **A looser sent schema** (a folded constraint; a prompt-mode schema nothing enforces) lets the model produce a shape Rocky then rejects.                                                                                                                                              | The constraint stays visible to the model; the Zod validator is unchanged, so such an answer is `invalid_output` and gets a repair round (ADR 0014), never a stored document. Prompt mode changes nothing after the answer arrives: parse, validate, integrity, leak guard, repair.                     | `provider-schema.test.ts` "still validates what the moved constraints say"; `output.test.ts` (a fenced invalid answer is `invalid_output`); the contract test for prompt mode.                                                                                                                                                                                                                   |
| S3  | **Validation weakened by accident**: the rewrite reaches the validator, or edits the emitted schema in place; `unfenced` repairs more than a fence, or repairs an enforced output's answer (which the provider guaranteed to be JSON: a fence there is a broken answer, not a style). | `parse` runs the Zod schema, never any JSON Schema; the rewrite copies and only folds; `unfenced` runs only for a prompt-mode output and matches one fence around the whole text or returns the text unchanged; the published schema file is compared byte for byte with its emission.                  | `provider-schema.test.ts` (copy, no-op on triage, `outputSchema` round trip); `output.test.ts` (a fenced answer from an enforced output is `invalid_json`; prose around a fence stays invalid JSON); `packages/schema/src/json-schema.test.ts`.                                                                                                                                                  |
| S4  | **The rewrite drops a union Zod emitted** (nullable, discriminated union), losing the model's guidance.                                                                                                                                                                               | Only a combinator with a sibling `type` is folded; unions have none.                                                                                                                                                                                                                                    | `provider-schema.test.ts` "leaves a combinator without a sibling type alone"; the SDK transform output is checked for closed, typed objects.                                                                                                                                                                                                                                                     |
| S5  | **The diagnostic leaks content** (an error message quoting a body, an identifier-shaped value planted on a thrown object's `constructor.name` or served by a proxy, a thrown string).                                                                                                 | `origin` is a regex-checked fixed tag; `errorClass` is read only from a real `Error` (`instanceof`), from its prototype's constructor (a function, never an own property), and must match an identifier shape, else `unknown`; nothing reads `message`; the worker and CLI print only those two fields. | `llm.test.ts` (origin shapes), `pipeline.test.ts` (a plain object or a proxy with an identifier-shaped planted name, an Error with a planted own `constructor`, a proxy whose prototype trap plants one, a trapping proxy, primitives: `unknown` or the real class; the message and the planted names never appear), `analysis.e2e.test.ts` and `cli/analyze.test.ts` (the log line and stderr). |
| S6  | **Prompt mode moves PR content or the schema into the wrong slot**: the schema in the user turn (uncached, after PR content), or PR content in the system block beside it.                                                                                                            | `buildPrompt` places the schema in the system slot only, through `systemPromptWithSchema`, which takes `RockyInstructions` (ADR 0012 §1); PR content stays in the delimited user blocks; the cache breakpoint stays on the system block alone.                                                          | The contract test for prompt mode on every platform (schema after the instructions in the cached block, absent from the user turn, no `cache_control` on PR content, no `output_config.format`).                                                                                                                                                                                                 |

**Residual risks.**

- A prompt-mode answer is not grammar-constrained: more `invalid_output` answers than for an
  enforced role are possible, each costing a repair round of the graph call (up to
  `MAX_REPAIR_ROUNDS`). Metering and the token caps bound it; the unit of evidence is the live
  eval once it runs.
- The grammar limits (3) are the provider's and change without notice; a role that compiles today
  may stop compiling. The failure would be `llm_invalid_request` with no origin tag (the
  provider's 400), which the CLI and worker now log as such.
- The real-model evals still cannot catch a provider-side schema rejection until a human sets
  `ROCKY_EVALS_ANTHROPIC_API_KEY` in the `evals-live` and `evals-nightly` environments and the
  runner treats a failed subject as a failed run (`packages/evals/src/run/**` is protected by the
  `evals-baseline-change` label; recorded in `docs/progress.md`).

## Consequences

- P4-3 gets real adapters by passing `providerAdapters()` to `createLlmRoles`. No adapter is
  visible to the pipeline.
- A new Claude platform is a client factory and a model-id rule. The request and result code is
  shared.
- Upgrading to the 1.x SDKs is a dependency bump plus a test run. The adapters already avoid what
  `2026-10-21` removes.

## Amendment (H4-5): the graph is an enforced output again

**Context.** H4-4 put the graph in prompt mode because no projection of the full graph compiled
under the API's grammar limits short of dropping flows, views or the walkthrough, which was a
product decision. The maintainer took it (`docs/progress.md`, "Dogfooding follow-ups"): the model
is asked only for what the page draws.

**Decision.**

1. **`GraphAnswer` is lanes, nodes and edges** (`Graph.pick`, `packages/core/src/analysis/outputs.ts`),
   and `GRAPH_OUTPUT` is `mode: "structured"` like every other role. The projection has no
   recursive definition and 16 optional fields (the limit is 24), and H4-4's probe compiled it.
   The analysis-document schema is unchanged: `flows` and `views` default to empty and the
   `walkthrough` stays absent, so stored documents, the published JSON Schema, the renderer and the
   web's parser keep working. Flows, views and the walkthrough come back as their own calls with
   their UI (ADR 0021 amendment H4-5).
2. **Prompt mode stays.** `LlmOutputSchema.mode: "prompt"`, `systemPromptWithSchema`, `unfenced`
   and their tests are unchanged and generic; no role uses the mode today. The fold
   (`providerJsonSchema`) still runs on every role's schema and is exercised on the full graph in
   `provider-schema.test.ts`, which a later flows or views call would send.
3. **Regression test extended.** `wire-schema.test.ts` asserts every role is `structured`, runs
   the `$defs` cycle check on all of them (the graph included), counts the graph's optional
   fields against the published limit and checks that no flow, view, walkthrough or recursive
   definition is in what is sent.

**Threat model.** S1–S6 above still hold. The one change is that the graph's answer is grammar
constrained again (the H4-4 residual on repair rounds for a prompt-mode output no longer applies
to it); S2's "looser sent schema" case now concerns only a role that opts into prompt mode.

**Residual risk.** The grammar-size limit remains the provider's and has no offline oracle: the
evidence is a completed real run on the private dogfooding pull request after this change
(`docs/progress.md`). A rejection would surface as `llm_invalid_request`.
