# Runbook: time the repository index live

P9-1's targets are a full index of a 100k-line repository in under 10 minutes and the re-index
of a push in under 30 seconds ([ADR 0040](../adr/0040-repository-index-and-embedding-spaces.md)).
`pnpm index:bench` measures everything except the two network ends (GitHub and the embedding
provider), which it simulates. This runbook is the live measurement. It calls a real provider
with a real key and spends on it, so a maintainer runs it.

## Offline first

```sh
pnpm index:bench                                          # no simulated latency
pnpm index:bench --embed-latency-ms 800 --forge-latency-ms 200
pnpm index:bench --without-hnsw                           # what the HNSW index costs the writes
```

Needs Docker (a throwaway Postgres container with the real migrations). Prints one JSON line per
stage: `repository`, `chunking`, `full_index`, `push_reindex`, with seconds, counts and the time
spent in the database and in embedding calls. Options: `--loc`, `--lines-per-file`,
`--embed-batch`, `--dimensions`, `--push-files`. A last `criteria` line holds the pass or fail
of each target, and the command exits non-zero when one is missed: the full index over 600 s, or
the push re-index over 30 s once the worst queue wait is added (the inbox poll, 2 s, plus the
index lane's tick, 10 s).

## Live

1. Pick a repository of about 100 000 lines in the supported languages that the GitHub App is
   installed on (Rocky itself is about that size). Check its size with
   `git ls-files | xargs wc -l | tail -1`.
2. Accept the `push` event subscription for that installation if GitHub asks (installations
   created before P9-1 have to accept it on the installation's settings page).
3. In `.env`: `ROCKY_LLM_EMBED_PROVIDER=openai` (or `voyage`), the key in `OPENAI_API_KEY` (or
   `VOYAGE_API_KEY`), `ROCKY_INDEX_AUTO=on`. Keep the default `ROCKY_INDEX_TOKEN_LIMIT`; a
   100k-line repository is about 1M tokens.
4. `pnpm dev`, then push a commit to the repository's default branch. The worker logs
   `code index run finished` with `fullRun: true`, the counts and `spentTokens`. The run's
   duration is the time between the `index started` and `code index run finished` lines.
   For the push figure, measure from the push itself: it includes up to 12 s of queue wait
   (inbox poll and index tick) before `index started`.
5. Push a second commit that changes a few files. The next `code index run finished` line has
   `fullRun: false`, `filesWritten` equal to the changed files and most chunks reused.
6. Check the spend: `select role, provider, model, count(*), sum(input_tokens) from llm_usage
where role = 'embed' group by 1, 2, 3;` (as the owner, `DATABASE_ADMIN_URL`).
7. Record both durations, the repository's line count, the provider and model, and the token
   count in `docs/progress.md` under P9-1.

Turn `ROCKY_INDEX_AUTO` off again afterwards if the instance should not keep indexing.
