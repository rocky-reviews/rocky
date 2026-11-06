# ADR 0040: The repository index and embedding spaces

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-06
- **Task:** P9-1
- **Amends:** [ADR 0012](0012-llm-roles-and-provider-port.md) §6 (the embed role gets a default
  provider; the vector column's width is settled), [ADR 0013](0013-llm-provider-adapters.md)
  (two hosted embedding adapters), [ADR 0008](0008-github-app-manifest.md) (the app subscribes to
  `push`; no new permission)
- **Builds on:** [ADR 0005](0005-migrations-and-roles.md) (RLS, `withOrg`), [ADR 0007](0007-webhook-inbox.md)
  and [ADR 0010](0010-pull-request-mirror.md) (inbox rows are hints, GitHub is re-read),
  [ADR 0016](0016-llm-metering.md) (metering), [ADR 0017](0017-analysis-queue-and-token-limit.md) (queue
  lanes and leases)

## Context

P9 answers questions about a repository and its pull requests from its code. P9-1 builds the
index under it: the code cut into chunks along function and class boundaries, each chunk
embedded, stored per tenant, kept current as the default branch moves, and searchable by vector
within one repository. ADR 0012 §6 left two things open: which embedding provider is the default,
and the width of the vector column (a `vector(1536)` placeholder). Nothing wrote embeddings
before this task.

## Decision

### 1. Providers: OpenAI by default, Voyage AI and self-hosted as alternatives

The embed role takes a provider, a model and a width (`ROCKY_LLM_EMBED_PROVIDER`, `_MODEL`,
`_DIMENSIONS`). Three providers have embeddings:

| Provider (`kind`)   | Default model            | Width sent as                    | Key (env, by name)                                         |
| ------------------- | ------------------------ | -------------------------------- | ---------------------------------------------------------- |
| `openai` (default)  | `text-embedding-3-small` | `dimensions`                     | `OPENAI_API_KEY` (`ROCKY_LLM_OPENAI_PLATFORM_API_KEY_ENV`) |
| `voyage`            | `voyage-code-3`          | `output_dimension`, `input_type` | `VOYAGE_API_KEY` (`ROCKY_LLM_VOYAGE_API_KEY_ENV`)          |
| `openai-compatible` | none (operator's model)  | `dimensions`                     | the server's own (`ROCKY_LLM_OPENAI_COMPATIBLE_*`)         |

OpenAI is the default because it is the most widely held key, its small model is cheap and
accurate enough for code search, and it accepts a reduced width. Voyage's code model is the
stronger choice for code and is one variable away. Self-hosted (Ollama, vLLM, any
`/v1/embeddings` server) keeps code on the operator's machines. Both hosted adapters are thin
`fetch` clients (no SDK), read their key per call through `envSecrets`, refuse before sending
when it is missing, never log, and map failures to `LlmCallError` without a provider body
(contract tests on fixtures in `packages/llm/fixtures/{openai,voyage}`, key hygiene in
`hygiene.test.ts`). Voyage receives `input_type: document` for indexed chunks and `query` for
questions (`EmbeddingRequest.purpose`); the others ignore it.

**Embeddings stay off until configured.** Without `ROCKY_LLM_EMBED_PROVIDER` the role is `null`,
and `ROCKY_INDEX_AUTO=on` without it stops the worker at boot. Choosing a provider adds a data
processor for the code it embeds, so the operator opts in.

Neither hosted provider has a verified price row yet: their calls are metered with
`cost_status = no_price` until a maintainer adds a price table version from the published
pages (`packages/llm/src/prices.ts`, needs-human).

### 2. Embedding spaces: stored with every vector, never compared across

An **embedding space** is (provider, model, dimensions). Vectors from different spaces are not
comparable, even at the same width. So:

- every `embeddings` row stores `provider`, `model` and `dimensions` (migration 0022);
- `code_indexes` records the space a repository's index is in;
- a run whose configured space differs from the stored one **empties the repository's index
  first and indexes in full** (`beginCodeIndexRun`): switching the model is a re-index, and one
  repository's index never holds two spaces;
- search takes the space of its query vector and filters on it (with the org and the
  repository), so a query from another model finds nothing rather than nonsense;
- a stored vector is reused for an unchanged chunk only within the same space.

### 3. One indexed width: `vector(1024)`, narrower spaces zero-padded

The column is `vector(1024)` for every space, with one HNSW index (`vector_cosine_ops`) over it,
plus a btree on (org, repository, space) for the filter. A space narrower than 1024 is stored
zero-padded; its true width is on the row. Padding with zeros changes neither the dot product
nor the norms, so cosine distances within a space are exactly those of the unpadded vectors, and
the filter keeps spaces apart.

Why 1024: every default fits it without loss of what matters. OpenAI's `text-embedding-3-*` are
trained so a shortened vector (`dimensions`) keeps most of the quality, Voyage's models offer
256/512/1024/2048 with 1024 as their default, and most self-hosted code models are 768 or 1024
wide. Wider spaces (OpenAI's 1536 and 3072 natives, Voyage's 2048) are refused at configuration
time with the supported widths in the message, and the request asks the provider for ≤ 1024.

The alternative, one column or partial index per model, was rejected: pgvector indexes need a
fixed width, so each new model would need a migration (or dynamic DDL in a tenant transaction,
which the role cannot run), and an instance changing its model would carry two indexes during
the switch. One width keeps one schema and one index for every install; the cost is that a
model wider than 1024 must be used at 1024, which the providers above support.

**Search plan.** Up to `CODE_SEARCH_EXACT_MAX_VECTORS` (20 000) vectors in a repository's space,
search is exact: the filtered rows first (a materialized CTE, so the planner cannot swap in the
HNSW index and drop rows), then every distance. That covers most repositories (a 100k-line one
has about 7 000 chunks) and gives exact answers in milliseconds. Above it, the HNSW index with
pgvector's iterative scan (`hnsw.iterative_scan = strict_order`, `ef_search = 200`) keeps
scanning in distance order until `k` rows pass the tenant filter, and falls back to the exact
plan if it still comes back short.

**What the index costs writes.** `pnpm index:bench --without-hnsw` measures it: on the synthetic
100k-line repository, maintaining the HNSW index is most of the database time of a full index
(about 27 s of 30 s on a laptop). That is well inside the target and buys sub-linear search for
large repositories; if writes become the bottleneck, building the index only when a repository
passes the exact-search size is the next step (follow-up).

### 4. Chunks: tree-sitter at function and class boundaries, with fallbacks

`packages/indexer` parses with `web-tree-sitter` (WebAssembly; exact versions, no native build,
grammar install scripts not run) for TypeScript, TSX, JavaScript, Python, Go, Rust and Java: the
languages of most repositories Rocky reviews, and each one a grammar package that ships a
prebuilt `.wasm`. Core's `chunkFromSyntax` takes top-level functions, classes, methods and their
kin as chunks, splits one over `maxChunkLines` (150) or `maxChunkChars` (6 000) along its
children, and merges the glue between them (imports, constants) into small chunks. Other text
(Markdown, YAML, SQL, shell, C and more) and a parse that fails or passes its time bound (2 s)
fall back to line windows cut at blank lines. Each chunk is embedded as its path, a newline and
its text, so the path's words count.

Skipped by path before anything is fetched: vendored directories, generated directories and
names (lockfiles, minified bundles, `*.pb.go`, …), unknown extensions, files over 512 KiB, unsafe
paths. Skipped by content after fetching: binary (NUL bytes or invalid UTF-8), generated markers
in the first lines or minified text, empty. Content-skipped files are stored as `skipped` with their blob id, so
they are not fetched again until they change. At most 500 chunks per file.

### 5. Storage: no code text; tenant tables with RLS

`code_indexes` (one row per repository: status, the commit and space it holds, the job's lease),
`code_files` (path, blob id, language, indexed or skipped) and `code_chunks` (line range, node
kind, sha256 of the text), all with `org_id`, RLS (FORCE) and composite foreign keys with
cascades; `embeddings.code_chunk_id` links a vector to its chunk. Everything is written and read
inside `withOrg`, and every query filters by org and repository as well.

**The chunk text is not stored.** The project stores derived data it can rebuild from GitHub
(diffs are kept as size and sha256 only, ADR 0010), and code is the most sensitive content a
tenant has. A reader (P9-2) re-fetches the lines of a hit by its blob id on a short-lived,
repository-scoped token; the blob id makes that read exact even after the branch moved. The
sha256 lets an unchanged chunk keep its vector (a renamed file, or a changed file whose other
functions did not change, costs nothing to embed). Vectors are derived from code, so they are
tenant data and are erased with the org (cascade).

### 6. Keeping it current: the push event, the tree diff, and the queue

The GitHub App now subscribes to `push` (it already holds `contents: read`, ADR 0008). The
webhook decoder keeps only pushes to the repository's default branch that did not delete it, as
`repository.push` (ids and the new head). The worker's repository lane re-checks the
installation and the org with GitHub, upserts the repository and queues its index
(`enqueueCodeIndex`) in the same tenant transaction that completes the inbox row; with indexing
off it finishes the row as `indexing_off` without a GitHub read. A new `push` subscription is
only offered to existing installations after their owner accepts it on GitHub (needs-human).

A run (`apps/worker/src/code-index.ts`) reads the default branch's head again, the commit's tree
(`git/trees/{sha}?recursive=1`), and compares it with what the index holds (`planIndexRun`):
new or changed blobs are fetched, stored paths that are gone, renamed away or no longer eligible
are removed with their chunks and vectors. A first index is the same plan with nothing stored.
Up to 200 files are read blob by blob; more come from one archive download (`tarball`), streamed
and filtered without being written to disk, the redirect followed without the token. A truncated
tree listing (very large repositories) is replaced by the archive, compared by blob id as it
streams. The token is minted per run, scoped to the one repository with `contents: read` only,
and revoked at the end.

The queue mirrors the analysis queue (ADR 0017): `worker.claim_code_indexes` (SECURITY DEFINER,
owned by `rocky_lifecycle`, worker login only) hands out at most one running index per org,
leased; every write checks and locks the lease; an expired lease is reclaimed, and failed after
five claims. A push while a run is going bumps the row's `generation` and the run queues itself
again when it finishes, so the last push always gets indexed. Outages (GitHub, the provider, the
database) are retried with backoff; other errors fail the row with a fixed code.

### 7. Budget and metering

Every embedding call goes through the metered embed role (`meterRoles`, ADR 0016) with a
per-org sink, so `llm_usage` gets a row per call with role `embed`, the provider and model of
the space, and the reported token count. Like an analysis's per-PR limit, a run has a token
limit (`ROCKY_INDEX_TOKEN_LIMIT`, default 5 000 000): the plan's estimate (from blob sizes) is
checked before anything is fetched, and over it the row waits as `over_limit` with the estimate
until a person approves it ("Index anyway", `approveCodeIndex`, audited). While running, the
real spend may pass the limit by a quarter (the estimate is from sizes) before the run stops as
`over_limit`. A push re-index is a small fraction of a full one.

### 8. Logs

Ids, counts, commits and error codes only: never paths, code, chunk text, vectors, keys or
prompts. The e2e test plants a marker in the code and checks it reaches neither the database nor
the logs, and that no path is logged.

## Measured

`pnpm index:bench` (synthetic repository: 667 TypeScript, Python and Go files, 100 050 lines,
2.7 MB; deterministic embedder; Postgres in Docker with the real migrations; laptop):

| Scenario                                                      | Full index | Push re-index (23 changed, 3 deleted) |
| ------------------------------------------------------------- | ---------- | ------------------------------------- |
| no simulated latency                                          | 31 s       | 0.5 s                                 |
| 800 ms per embedding call (128 inputs), 200 ms per forge read | 78 s       | 2.4 s                                 |
| no latency, HNSW index dropped (`--without-hnsw`)             | 3.6 s      | 0.1 s                                 |

Chunking alone: 6 651 chunks in 0.3 s (about 330 000 lines a second). The targets (a full index
of a 100k-line repository under 10 minutes, a push re-index under 30 s) hold with a wide margin
at these latencies. The live timing (a real repository, GitHub and a real provider) is a
maintainer's step: [runbook](../runbooks/index-live-timing.md).

## Consequences

- One schema and one index for every instance and model; a model change is a re-index.
- Code never rests in Rocky's database; P9-2 pays one blob read per hit it shows.
- `push` is a new webhook event; existing installs must accept it before their indexes refresh
  on push (until then the index only moves when something enqueues it).
- Memory entries (P8) still have no vectors; when they get them, they use the same column, width
  and space rule.
