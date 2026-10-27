# ADR 0012: LLM roles, per-role config and the provider port

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P4-1
- **Builds on:** [ADR 0004](0004-schema-first-llm.md) (every model call returns schema-valid JSON)

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
- `LlmRoles.embedding()`: an embedding client, or `undefined` when embeddings are off.
- `LlmProvider`: what an adapter implements: `completeStructured` and/or `embed`. It receives the
  request plus the role's target (`role`, `model`, `effort`; `dimensions` for embeddings).

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
- malformed regions, names and URLs, and URLs with credentials, a query or a fragment;
- unknown keys;
- any value shaped like a credential (the `packages/log` scrubber's patterns).

A validated config is frozen and registered. The registry refuses any other object.

**Models.** The Claude platforms share one catalogue of canonical Claude API ids:
`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and
`claude-haiku-4-5`. An id outside it is refused. The adapter maps the id to its platform's form
in P4-2: Bedrock adds the `anthropic.` prefix, and Vertex uses the bare id. Foundry's form is
confirmed in P4-2. An OpenAI-compatible server serves whatever it has loaded, so any well-formed
id is accepted there.

**Effort** is a provider-neutral scale `low < medium < high < xhigh < max`, validated against
what the provider and model support. Each adapter maps it to its own parameter (P4-2):

| Provider             | Accepted levels                 | Maps to (P4-2)                                 |
| -------------------- | ------------------------------- | ---------------------------------------------- |
| Claude, current gen. | all five                        | `output_config.effort`, with adaptive thinking |
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
- `ROCKY_LLM_<ROLE>_{PROVIDER,MODEL,EFFORT}`;
- `ROCKY_LLM_EMBED_{PROVIDER,MODEL,DIMENSIONS}`;
- the provider settings `ROCKY_LLM_{ANTHROPIC,BEDROCK,VERTEX,FOUNDRY,OPENAI}_*`.

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

None of this is built here.

## Consequences

- Moving a role to another provider is a config change. A new provider is a capability row plus
  an adapter factory.
- The Claude catalogue is code: a new Claude model id is a one-line change and a release, not a
  config edit. That is the price of refusing typos and unknown ids at boot.
- Bedrock inference-profile ids (regional prefixes) and Foundry deployment names are not
  expressible yet. P4-2 adds them, as a per-provider model mapping, if a platform needs one.
- Validation reads the catalogue, not the provider's live Models API, so a model the provider
  withdraws fails at the first call, not at boot. The P10-2 setup wizard's test call covers that.
