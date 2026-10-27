# LLM provider fixtures

Responses used by the provider contract tests (P4-2, ADR 0013). They are **not recorded**. They
are **documentation-shaped**: they follow the wire shapes the providers document, as given by the
`claude-api` skill (cached 2026-10-06) and the installed SDK types (`@anthropic-ai/sdk` 0.135.0),
with synthetic values:

- message ids `msg_01Fixture…`;
- request id `req_fixture…`;
- signature `fixture-signature`;
- one synthetic review answer.

They hold no keys, account ids, project ids, ARNs or customer content. `src/adapters/hygiene.test.ts`
scans every file here with the log scrubber's credential patterns.

Tests serve them through an injected `fetch` (`src/adapters/test-support.ts`). No test calls a live
API.

## `claude/`: Messages API server-sent events

One set serves all four Claude platforms. The Anthropic API, Bedrock Mantle
(`/anthropic/v1/messages`), Vertex `:streamRawPredict` and Foundry all stream the same SSE events.

| File                       | Stop reason                     | What it is                                                                                                                      |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `end-turn.sse`             | `end_turn`                      | A thinking block (omitted display), then the JSON answer in two `text_delta`s; cache read 1536, writes 1024 (5 min) + 256 (1 h) |
| `refusal.sse`              | `refusal`                       | Declined before any output, with `stop_details` (`category: cyber`)                                                             |
| `max-tokens.sse`           | `max_tokens`                    | Partial JSON cut off at the output cap                                                                                          |
| `context-window.sse`       | `model_context_window_exceeded` | Partial JSON cut off at the context window                                                                                      |
| `invalid-json.sse`         | `end_turn`                      | Prose instead of JSON                                                                                                           |
| `schema-mismatch.sse`      | `end_turn`                      | JSON that fails the output schema                                                                                               |
| `tool-use.sse`             | `tool_use`                      | An unexpected stop (Rocky sends no tools)                                                                                       |
| `fallback.sse`             | `end_turn`                      | Server-side fallback mid-stream: partial text, a `fallback` block (Opus 5.5 → Opus 4.8), the answer, and `usage.iterations`     |
| `overloaded-midstream.sse` | none                            | An `error` event (`overloaded_error`) after output started                                                                      |

`claude/errors/*.json` hold the documented error body for each HTTP status the adapters map: 400
(invalid request, and the prompt-too-long case), 401, 402, 403, 404, 413, 429, 500 and 529. Their
messages follow the shape in the skill's error-code reference. The 400 prompt-too-long text is a
best guess: the API documents no typed signal for it (ADR 0013, residual risks).

## `openai-compatible/`: chat completions and embeddings

They follow the OpenAI response shapes that Ollama and vLLM implement.

| File                       | What it is                                                                 |
| -------------------------- | -------------------------------------------------------------------------- |
| `chat-stop.json`           | `finish_reason: stop` with the JSON answer; 1200 prompt tokens, 256 cached |
| `chat-length.json`         | `finish_reason: length` (truncated)                                        |
| `chat-refusal.json`        | `message.refusal` set                                                      |
| `chat-content-filter.json` | `finish_reason: content_filter`                                            |
| `chat-invalid-json.json`   | Prose instead of JSON                                                      |
| `chat-no-usage.json`       | A server that reports no usage (zeros)                                     |
| `embeddings.json`          | Two 4-dimensional vectors, deliberately out of `index` order               |
| `error-400-context.json`   | `context_length_exceeded`                                                  |
| `error-401.json`           | `invalid_api_key`                                                          |

## Recording real responses

Recording real responses is a follow-up (`docs/progress.md`, P4-2), and it needs credentials for
each platform. When recording:

- keep only the event and field shapes;
- replace every id, request id, signature, model deployment name and account or project
  identifier;
- never commit a request; the adapters' requests are asserted in the tests, not stored.
