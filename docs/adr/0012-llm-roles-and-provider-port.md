# ADR 0012: LLM roles, per-role config and the provider port

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P4-1
- **Builds on:** [ADR 0004](0004-schema-first-llm.md) (every model call returns schema-valid JSON)
- **Revised:** review round 1:
  - the full active Claude catalogue with per-model effort;
  - per-role platform model ids;
  - https rules for base URLs;
  - the provider stamped on results;
  - cache writes split by lifetime;
  - `LlmCallError`;
  - schema issues on `invalid_output`;
  - the Bedrock region fallback;
  - key-shaped variable names refused;
  - notes N4, N5, N7, N9.
- **Revised:** P4-2 ([ADR 0013](0013-llm-provider-adapters.md)):
  - optional `attempts` on results (refusal fallbacks);
  - Bedrock catalogue limited to the models Mantle serves;
  - per-platform `platformModel` shapes for Vertex and Foundry;
  - the Foundry model form confirmed.

## Context

The analysis pipeline (P4-3) does five kinds of LLM work: cheap per-file triage, deep review of
the files that matter, the change-map graph, repository Q&A, and embeddings for memory and
indexing (P8, P9). Each kind wants a different price/quality point, and operators need to choose
where it runs: the Anthropic API, Claude on Amazon Bedrock, Google Vertex AI or Microsoft Foundry,
or a local OpenAI-compatible server (Ollama, vLLM) when self-hosting. Provider clients arrive in
P4-2; this task fixes the contract they implement and the config that picks them, so that moving
a role to another provider never needs a code change.

## Decision

### 1. Roles are the only thing the pipeline sees

`packages/core/src/llm.ts` defines the port:

- `LLM_ROLES`: `triage`, `review`, `graph`, `ask` (completion roles) and `embed`.
- `LlmRoles.completion(role).complete(request)`: one structured completion. The request has
  Rocky's instructions, the PR content as `untrusted` parts (P4-4 delimits them), the output
  schema (JSON Schema + validator, ADR 0004) and an output token cap. The result is `ok` with the
  parsed value, or `refused`, `truncated` or `invalid_output`. Either way it is data, never an
  action.
  - `invalid_output` may carry `issues`, built from schema paths and issue codes only, never
    values.
  - Every result carries `provider` (the kind). The registry stamps it last, so adapters don't
    supply it and can't misstate it. Metering (P4-5) reads it.
  - `usage` has `inputTokens`, `outputTokens`, `cacheReadInputTokens` and cache writes split by
    lifetime: `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens`. They mirror Anthropic's
    `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, which are
    priced differently. Providers without a cache report zeros.
  - `attempts` (P4-2, the only port change it needed) lists each billed attempt's model and usage
    when a server-side refusal fallback re-ran the call on another model. `usage` is then the
    attempt that produced the answer, and `model` names the model that served it. Without it,
    metering (P4-5) would miss the declined attempt's tokens.
- `LlmRoles.embedding()`: an embedding client, or `undefined` when embeddings are off.
- `LlmProvider`: what an adapter implements: `completeStructured` and/or `embed`. It receives the
  request plus the role's target: `role`, `model`, `platformModel`, `effort` (`dimensions` for
  embeddings).
- `LlmCallError`: how an adapter reports a failed call. Each error has a `kind` and a fixed
  message per kind. It never carries a provider body, prompt, output or `cause`. It may carry a
  `retryAfterMs` hint.

  | Kind group | Kinds                | Source (Anthropic HTTP status)   |
  | ---------- | -------------------- | -------------------------------- |
  | Retryable  | `rate_limited`       | 429                              |
  |            | `overloaded`         | 529                              |
  |            | `server_error`       | 500 and other 5xx                |
  |            | `timeout`, `network` | timeouts, connection failures    |
  | Fatal      | `auth`               | 401                              |
  |            | `permission`         | 403                              |
  |            | `billing`            | 402                              |
  |            | `invalid_request`    | 400                              |
  |            | `model_not_found`    | 404                              |
  |            | `request_too_large`  | 413                              |
  |            | `context_too_long`   | 400 for an input that cannot fit |
  |            | `cancelled`          | the caller's abort signal        |

  The split follows the `claude-api` skill's error-code table. Other providers map onto the same
  kinds in P4-2.

  **Context window:** an input that cannot fit is `context_too_long`, thrown, because nothing was
  generated and the caller must shrink the input (P4-6 splits the PR). A generation that stops at
  the output cap, or at the context window mid-answer, is the result `truncated`, because the
  call ran and was billed. That split is what lets metering (P4-5) record every billed call.

Core names no vendor SDK (lint allow-list plus `llm.test.ts`).

### 2. Per-role config: provider + model + effort

`packages/llm` validates one config object (`parseLlmConfig`, zod plus cross-field checks):

```text
providers: { <kind>: settings }      non-secret settings per provider kind
roles:     { triage | review | graph | ask: { provider, model, effort? },
             embed: { provider, model, dimensions } | null }
```

Provider kinds: `anthropic`, `bedrock`, `vertex`, `foundry`, `openai-compatible`.

| Kind                | Settings                                       | Credentials                             |
| ------------------- | ---------------------------------------------- | --------------------------------------- |
| `anthropic`         | `apiKeyEnv`, optional `baseUrl` (e.g. gateway) | key in the env var named by `apiKeyEnv` |
| `bedrock`           | `region`                                       | AWS default credential chain            |
| `vertex`            | `projectId`, `region`                          | Google application default credentials  |
| `foundry`           | `resource`, `apiKeyEnv`                        | key in the env var named by `apiKeyEnv` |
| `openai-compatible` | `baseUrl`, optional `apiKeyEnv`                | optional key in the env var it names    |

Validation fails fast and reports every problem at once. It rejects:

- an unknown provider;
- a blank model, or one outside the provider's catalogue;
- an effort outside the scale, or one the provider or model lacks;
- a missing role;
- an embed role on a provider without embeddings;
- a role whose provider has no settings block;
- malformed regions, names and URLs, and URLs with credentials (userinfo), a query or a
  fragment (`@` elsewhere in a path is fine);
- plain-http base URLs where a key would travel in clear (below);
- a `*_API_KEY_ENV` value that looks like a key rather than a variable name: over 64 characters,
  or no `_` with a high share of digits;
- a `platformModel` on a provider that takes none, or one with spaces, control characters or
  over 512 characters;
- unknown keys;
- any value shaped like a credential (the `packages/log` scrubber's patterns).

A validated config is frozen and registered. The registry refuses any other object.

**Base URLs (review S2).** The rule follows the server's rule for `ROCKY_PUBLIC_URL`: https, or
http only on the loopback hosts `127.0.0.1`, `localhost` and `[::1]`.

- `anthropic.baseUrl` (a gateway) must be https. The key always travels there.
- `openai-compatible.baseUrl` with `apiKeyEnv` set must be https, or plain http on loopback.
- Without a key, plain http to any host is allowed.

The keyless case is the usual self-host layout: Ollama as a sibling container
(`http://ollama:11434`) on a private Docker network, which serves no TLS out of the box. Requiring
https there would push operators to add a TLS proxy for a hop that never leaves the host network.
No credential can leak on that hop. PR content does cross it in clear, and the operator who puts
the model server on another machine owns that network's confidentiality (the self-host docs,
P10-3, will say so).

**Models.** The Claude platforms share one catalogue of canonical Claude API ids, with each
model's effort levels:

| Model                                                                    | Effort levels                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `claude-fable-5-1`, `claude-fable-5`                                     | all five                                                       |
| `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7` | all five                                                       |
| `claude-sonnet-5-5`, `claude-sonnet-5`                                   | all five                                                       |
| `claude-haiku-5-5`                                                       | all five                                                       |
| `claude-opus-4-6`, `claude-sonnet-4-6`                                   | `low`, `medium`, `high`, `max` (`xhigh` arrived with Opus 4.7) |
| `claude-opus-4-5`                                                        | `low`, `medium`, `high`                                        |
| `claude-haiku-4-5`                                                       | none (the API rejects `effort`)                                |

Source: the `claude-api` skill's model table and its thinking and effort table (cached
2026-10-06). The skill gives an effort set for every catalogued model, so no entry is a guess.
Claude Mythos (access program only) is left out.

An id outside the catalogue is refused. The catalogue id is the _capability key_: effort
validation and defaults read it. The literal string sent to a platform is either derived by the
adapter (P4-2, ADR 0013: Bedrock adds the `anthropic.` prefix; Vertex uses the bare id, or the
dated id for Opus 4.5 and Haiku 4.5; Foundry uses the canonical id, its default deployment name),
or set per role as `platformModel` (`ROCKY_LLM_<ROLE>_PLATFORM_MODEL`). That
override covers:

- a Bedrock inference profile (`eu.anthropic.claude-opus-5-5`) or ARN;
- a Vertex dated id (`claude-haiku-4-5@20251001`);
- a Foundry deployment name.

`platformModel` is allowed only on bedrock, vertex and foundry. It is shape-checked only, since
platforms mint these strings, and the credential check applies to it as to every field. P4-2 adds
two per-platform shapes:

- **Vertex** puts the model in the URL path, so one path segment only (no `/` or `:`).
- **Foundry** takes a deployment name: letters, digits, `.`, `_` and `-`, at most 64 characters.

**Bedrock catalogue (P4-2).** Bedrock's catalogue is the Claude catalogue less Opus 4.6, Opus 4.5
and Sonnet 4.6. The adapter uses Bedrock's Messages API endpoint (Mantle), and those three models
exist only on the legacy `InvokeModel` integration (ADR 0013 §1). An
OpenAI-compatible server serves whatever it has loaded, so any well-formed id is accepted there,
and it needs no override.

**Effort** is a provider-neutral scale `low < medium < high < xhigh < max`, validated against
what the provider and model support. Each adapter maps it to its own parameter (P4-2):

| Provider             | Accepted levels                 | Maps to (P4-2)                                 |
| -------------------- | ------------------------------- | ---------------------------------------------- |
| Claude, current gen. | all five                        | `output_config.effort`, with adaptive thinking |
| `claude-opus-4-5`    | `low`, `medium`, `high`         | `output_config.effort`, no thinking            |
| `claude-haiku-4-5`   | none (the API rejects `effort`) | not sent                                       |
| `openai-compatible`  | `low`, `medium`, `high`         | `reasoning_effort`                             |

Leaving `effort` out means "the provider's default for the model". That default differs per model
(Opus 5.5 and Haiku 5.5 default to `medium`, Sonnet 5.5 to `high`), so Rocky's defaults set effort
explicitly. Sources: Anthropic's model and effort reference, via the `claude-api` skill (model
table cached 2026-10-06).

**Defaults** (no variables set): the plan's models, with explicit efforts.

| Role   | Default                       | Why this effort                                              |
| ------ | ----------------------------- | ------------------------------------------------------------ |
| triage | `claude-haiku-5-5`, `low`     | per-file classification at volume                            |
| review | `claude-opus-5-5`, `high`     | correctness-sensitive; Opus 5.5 would otherwise run `medium` |
| graph  | `claude-sonnet-5-5`, `medium` | structural summary, not deep reasoning                       |
| ask    | `claude-sonnet-5-5`, `medium` | interactive Q&A over code                                    |

These efforts are starting points; the evals (P4-7) tune them. The default model and effort apply
only on a Claude platform, and only when the model supports that level. An OpenAI-compatible
role must name its model.

### 3. Config source: the environment

12-factor, like the rest of Rocky's config. `llmConfigFromEnv` reads:

- `ROCKY_LLM_PROVIDER`, which moves every role;
- `ROCKY_LLM_<ROLE>_{PROVIDER,MODEL,EFFORT,PLATFORM_MODEL}`;
- `ROCKY_LLM_EMBED_{PROVIDER,MODEL,DIMENSIONS}`;
- the provider settings `ROCKY_LLM_{ANTHROPIC,BEDROCK,VERTEX,FOUNDRY,OPENAI}_*`.

Bedrock's region falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`, as the AWS SDK's does.
Errors then name the variable that was read. Those variables alone never switch Bedrock on.

Every key is documented in `.env.example`. Errors name the variable to fix and never its value.
An unknown `ROCKY_LLM_*` variable is an error, so a typo cannot silently leave a role on its
default. The plan's single YAML file has no loader yet. When it gets one, it produces the same
object for `parseLlmConfig`.

### 4. Secrets stay out of the config

The config holds the _name_ of the variable that holds a key (`apiKeyEnv`), never the key. The
registry passes each adapter factory a `SecretSource` (`get(name)`). Adapters look the key up
when they need it, never at construction, so a dump of the config, an error or the `LlmRoles`
object cannot contain a key. `hygiene.test.ts` puts a key in every variable and field and checks
that no message, stack, JSON or `inspect` output contains it.

### 5. Registry: role → configured adapter

`createLlmRoles(config, adapters, secrets)` builds one adapter per provider kind in use, from the
factories it is given. Adapters are injected, so P4-2 adds factories and nothing else changes.
It fails fast when a role's provider has no factory installed, or when the adapter lacks the
capability (completions for the four roles, embeddings for `embed`). Callers get `LlmRoles` and
never learn the provider. `registry.test.ts` runs one pipeline stand-in against three
environments (Anthropic, Bedrock, a local server) with the same code and the same adapters.

### 6. The embed role has no default (needs a human decision)

Anthropic has no embeddings endpoint on any of its platforms. So no default can share the
completion roles' provider, and any default would add a vendor and a data processor on behalf of
every install. The vendor, its terms and its price are product decisions. The embed role
therefore needs explicit configuration: provider, model and `dimensions`. Until it has one it is
`null`, `LlmRoles.embedding()` is `undefined`, and features that need vectors stay off (nothing
uses them before P8 and P9).

`dimensions` is required because the vector column's width is fixed. It is a placeholder
`vector(1536)` today and is settled in P9-1. Today only `openai-compatible` (`/v1/embeddings`,
e.g. Ollama or vLLM) supports embeddings. A hosted embeddings provider is a new kind plus an
adapter, chosen when P8 and P9 need one. **Needs human:** pick the default embedding provider,
if any, before P8.

### 7. Per-org overrides and BYOK plug in later (C-5, P10)

An instance overrides any role through the environment (§3). Per-org overrides and BYOK (C-5 and
the setup wizard, P10-2) plug in as follows:

- an org's overlay (`roles` and `providers` fragments) is merged over the instance config and
  passed through the same `parseLlmConfig`, so the same checks apply;
- the org's key reference resolves through a `SecretSource` backed by the plan's `LlmKeyProvider`
  (envelope-encrypted per org, ADR 0006) instead of the environment;
- a per-org `createLlmRoles` (cached per org and config version) hands the pipeline an `LlmRoles`
  for that org. Nothing in the roles or the pipeline changes.

Two limits on overlays (review N4):

- An org overlay may not set `baseUrl` or `apiKeyEnv`. Otherwise an org admin could point the
  instance's key at their own host, or name an instance variable (another tenant's key, a
  database URL) as their key.
- Org keys come only from the org-scoped `SecretSource`, never from the environment. Any
  org-supplied endpoint, if one is ever allowed, needs an SSRF policy: https only; no private,
  loopback or link-local addresses after DNS resolution; no redirects.

None of this is built here.

### 8. Notes for later tasks

- **N5:** `ask` will want streaming for an interactive UI (P9). It will be an optional
  `streamStructured` on `LlmProvider` and `CompletionRoleClient`, beside `complete`. The existing
  contract stays as it is.
- **N7:** `LlmUntrustedText.label` is Rocky-authored (`"diff"`, `"title"`, a file index). It is
  never built from PR content, such as a file path or a branch name, because adapters use it in
  the delimiters that mark untrusted text (P4-4).
- **N9:** at `xhigh` and `max` effort, give `maxOutputTokens` at least 64K, and stream. Thinking
  counts against the cap, so a lower cap risks `truncated` (P4-2, P4-3).

## Consequences

- Moving a role to another provider is a config change. A new provider is a capability row plus
  an adapter factory.
- The Claude catalogue is code. A brand-new Claude model still needs a catalogue entry (one line
  and a release), because its capabilities, such as effort levels, are validated from it. That is
  the price of refusing typos and unknown ids at boot. Regional and platform forms, inference
  profiles, ARNs, dated ids and deployments need no catalogue entry: they go in `platformModel`.
- Validation reads the catalogue, not the provider's live Models API, so a model the provider
  withdraws fails at the first call, not at boot. The P10-2 setup wizard's test call covers that.
