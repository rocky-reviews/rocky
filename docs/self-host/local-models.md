# Local models

Rocky can run every role on a model you host, through any server that speaks the OpenAI
chat-completions and embeddings API: Ollama, vLLM, or a router in front of several servers. When
every role, embeddings included, runs on such a server, Rocky sends code and diffs to no model
provider. (GitHub still holds the code, and Rocky still reads it from GitHub.)

> **No measured results on this page.** Nothing here comes from running Rocky against a local
> model: there are no scores, speeds or model recommendations because none have been measured.
> The quality notes explain what is expected to degrade and why, from how Rocky uses each role.
> The way to know for your model is to [run the evals](#measuring-your-model-with-the-evals).

## Configuring the endpoint

One OpenAI-compatible endpoint serves every role that uses the `openai-compatible` provider:
`ROCKY_LLM_OPENAI_BASE_URL`, including the `/v1` suffix
([configuration](configuration.md#provider-settings)). On this provider each role needs a model
(there is no default model), and there is no default effort.

### Every role on Ollama

```sh
ROCKY_LLM_PROVIDER=openai-compatible
ROCKY_LLM_OPENAI_BASE_URL=http://127.0.0.1:11434/v1
ROCKY_LLM_TRIAGE_MODEL=<a small, fast model>
ROCKY_LLM_REVIEW_MODEL=<your strongest model>
ROCKY_LLM_GRAPH_MODEL=<a mid-size model>
ROCKY_LLM_ASK_MODEL=<a mid-size model>
# Embeddings (optional; the repository index and Ask need them)
ROCKY_LLM_EMBED_PROVIDER=openai-compatible
ROCKY_LLM_EMBED_MODEL=<an embedding model>
ROCKY_LLM_EMBED_DIMENSIONS=<that model's output width, at most 1024>
```

The model names are whatever your server lists (`ollama list`, or `GET /v1/models`). Ollama
serves several models from one endpoint and loads them on demand, so one base URL covers all
roles.

### vLLM

```sh
ROCKY_LLM_PROVIDER=openai-compatible
ROCKY_LLM_OPENAI_BASE_URL=https://vllm.internal.example/v1
ROCKY_LLM_OPENAI_API_KEY_ENV=VLLM_API_KEY      # the name of the variable, not the key
VLLM_API_KEY=<the key vLLM was started with>
ROCKY_LLM_TRIAGE_MODEL=<served model name>
ROCKY_LLM_REVIEW_MODEL=<served model name>
ROCKY_LLM_GRAPH_MODEL=<served model name>
ROCKY_LLM_ASK_MODEL=<served model name>
```

A vLLM process usually serves one model. Since Rocky has one OpenAI-compatible base URL, either
use the same model for every role, put a router that dispatches by model name in front of
several vLLM processes, or mix providers (below). The same applies to embeddings: the embedding
model must be reachable at the same base URL.

### Mixing local and hosted

Each role picks its own provider, so you can keep the role where quality matters most on a hosted
model and run the rest locally, or the other way round:

```sh
ROCKY_LLM_PROVIDER=openai-compatible
ROCKY_LLM_OPENAI_BASE_URL=http://127.0.0.1:11434/v1
ROCKY_LLM_TRIAGE_MODEL=<local model>
ROCKY_LLM_GRAPH_MODEL=<local model>
ROCKY_LLM_ASK_MODEL=<local model>
ROCKY_LLM_REVIEW_PROVIDER=anthropic   # review back on the default model and effort
ANTHROPIC_API_KEY=<your key>
```

Code sent to a hosted role leaves your network; only the roles on `openai-compatible` stay local.

### Rules the configuration enforces

- **Keys over plain http are refused.** With `ROCKY_LLM_OPENAI_API_KEY_ENV` set, the base URL
  must be https, or http on `127.0.0.1`, `localhost` or `[::1]`. Without a key, http is accepted
  anywhere, which is the usual layout for a model server on a private network (for example a
  sibling container); keep such a server off any network others can reach.
- **Effort** is optional and maps to `reasoning_effort` (`low`, `medium` or `high`). Leave
  `ROCKY_LLM_<ROLE>_EFFORT` unset unless your model and server accept it; some servers reject the
  field for models without a reasoning mode.
- **Embedding width must match.** `ROCKY_LLM_EMBED_DIMENSIONS` is sent as `dimensions`, and every
  returned vector must have exactly that width, or the call fails (no silently wrong vectors).
  Many local servers ignore `dimensions` and return the model's native width, so set it to that
  width. The index holds at most 1024 dimensions: a model with wider output cannot be used unless
  the server truncates it.
- **Changing the embedding model re-indexes everything.** Vectors from different models are never
  compared; the index records the provider, model and width on every row.
- **Changing a role's model re-analyses.** Stored analysis units are keyed on the model and
  provider settings, so the next analysis of a pull request calls the new model for every file.
- An unknown `ROCKY_LLM_*` variable stops the process, so a typo cannot leave a role on its
  default without you noticing.

### Server settings that matter

- **Context length.** Triage and review send one file's diff per call, with the instructions
  and the output schema; the change map sees the whole pull request (up to a cap). A server that
  answers "context too long" gets that file marked too large, which is visible. A server that
  instead cuts the prompt to its configured context does so silently, and the result looks like a
  poor review rather than an error. Set the server's context length as high as the model and your
  memory allow (in Ollama, its context length setting, `OLLAMA_CONTEXT_LENGTH` in recent
  versions), and lower `ROCKY_ANALYSIS_TOKEN_LIMIT` so that pull requests too large for your
  setup wait for "Analyze anyway" instead of being sent.
- **Structured output.** Rocky asks for JSON that matches a schema
  (`response_format: json_schema`, strict) and also puts the schema in the system message for
  servers that ignore that field. Ollama and vLLM both accept `response_format`; vLLM answers 400
  for a schema its guided-decoding backend cannot compile.
- **Time.** Each call is a single non-streaming request with a 10-minute deadline, and a response
  body is capped at 16 MiB. On slow hardware the review role is the first to hit the deadline;
  `ROCKY_ANALYSIS_CONCURRENCY` (default 4) is how many analyses share your GPU at once, so lower it
  rather than letting calls queue past the deadline.
- **Cost.** Local calls are metered like any other (tokens per call in `llm_usage`), with no
  price: a self-hosted model has no list price, so their cost is recorded as unknown, not zero.

## What to expect from a local model

Rocky's safety does not depend on the model. Every answer is validated against a schema, an
answer that fails gets one repair round and is then dropped, model output never triggers a side
effect, and only a person posts a review. A weaker model therefore produces a worse review, not
an unsafe action. What degrades, and why:

| Role or feature        | What degrades with a weaker model                                                                                                                                                                                          | What you see                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Review** (findings)  | Finding real bugs in a diff takes the most reasoning of any role. Smaller models are expected to miss more seeded bugs (recall) and to report more vague or wrong findings (precision).                                    | Fewer and noisier drafts. The reviewer still decides every one; nothing is posted without them.                           |
| **Schema adherence**   | Smaller models break long, strict JSON schemas more often, even with structured output on. Each broken answer costs a repair call; a second failure drops that unit.                                                       | Files marked as not analysed, a change map marked unavailable, or a failed analysis; more tokens.                         |
| **Triage**             | Misjudging which files carry risk sends the review's attention to the wrong places.                                                                                                                                        | Important files reviewed with less depth, or noise files reviewed at all.                                                 |
| **Graph** (change map) | Grouping changes into a coherent map needs the whole diff in view, so a short context hurts most here.                                                                                                                     | A flatter or fragmented map, or none.                                                                                     |
| **Ask**                | Answers are only as good as the excerpts retrieved and the model's reading of them. Rocky keeps only citations that point at code the model was shown.                                                                     | Less useful answers, and fewer citations that survive the check.                                                          |
| **Embeddings**         | General-purpose embedding models are expected to retrieve code less precisely than code-specific ones.                                                                                                                     | Ask finds the relevant file less often.                                                                                   |
| **Prompt injection**   | Pull request content is always passed as untrusted, labelled input, and the schema limits what an answer can contain. Smaller models are expected to follow instructions planted in a diff more often within those limits. | Misleading findings or a misleading summary on a hostile pull request. They cannot post, approve or reach another tenant. |
| **Project memory**     | Learning a convention from dismissals, and applying it, depends on the model reading the memory entries it is given.                                                                                                       | Fewer learned conventions; repeated drafts the team already dismissed.                                                    |

## Measuring your model with the evals

The eval suite (`packages/evals`, [its README](../../packages/evals/README.md)) runs seeded pull
requests with known bugs through the real analysis pipeline and scores the result. It reads the
same `ROCKY_LLM_*` variables as the worker, so it measures exactly the configuration you deploy.
Reports hold no code, diffs, prompts or model text, so they are safe to keep and share.

What it measures:

| Flag              | Measures                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| (always)          | Recall (seeded bugs found) and precision (findings that match a seeded bug) per pull request and in total; tokens per role. |
| `--injection`     | The prompt-injection corpus: whether planted instructions changed the output (reported, not gated).                         |
| `--memory`        | Whether project memory is learned and applied (two synthetic pull requests).                                                |
| `--ask`           | Ask's answers on a synthetic repository: on target, with valid citations. Needs the embedding role.                         |
| `--ask-injection` | The injection corpus on Ask's inputs.                                                                                       |

What it does not measure: speed, behaviour on your own repositories, and how useful a reviewer
finds the drafts. Precision is a lower bound, since a model may report real issues nobody seeded.

From the repository root, with your `ROCKY_LLM_*` variables set (for example from `.env`):

```sh
pnpm evals run --dry-run                          # checks the configuration, calls nothing
pnpm evals run --only pr-847 --out local-try.json # one seeded PR first
pnpm evals run --injection --memory --ask --out my-model.json
```

- `--max-tokens` (default 1,000,000) caps the whole run. A local model costs nothing per token
  but the cap still bounds how long the run takes.
- `pnpm evals compare <baseline.json> <report.json>` fails when total recall drops more than 5
  points or precision more than 10 against a baseline. The repository's own live baseline
  (`packages/evals/baselines/live.json`) is a placeholder, and comparing against it exits 3.
  Use your own: keep the first good report for your model as the baseline, and compare every
  model, server or configuration change against it.
- To compare with a hosted model, run the same command once with the hosted configuration and a
  key (that run is billed to you), and compare the two reports.

Measuring local models and publishing the results is planned work; until then, this page states
expectations only.
