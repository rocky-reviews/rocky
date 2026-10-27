# ADR 0016: Evals and the quality gate

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P4-7

## Context

P4-3 and P4-4 test the pipeline's wiring and its injection defences with scripted models. They
say nothing about how well a real model reviews. P4-7 needs a measure of review quality that
runs nightly and on any prompt or model change, and fails CI when recall drops by more than
5 points. Real runs cost money and need a key that forks and most contributors do not have.

## Decision

1. **Seeded PRs as data plus a scorer.** `packages/evals/src/seeded/` holds five small synthetic
   PRs (32 seeded findings) with expected findings and provenance notes. `score.ts` matches
   produced findings to seeded ones by file, lines (±2), severity (one step) and keywords, as a
   maximum bipartite matching, so a score does not depend on finding order. The rules are in
   the package README and tested.
2. **The real pipeline, the real roles.** The runner calls `analyzePullRequest` with `LlmRoles`
   built exactly as the worker builds them (`llmConfigFromEnv`, `providerAdapters`,
   `envSecrets`). Nothing in the eval path calls a provider SDK directly.
3. **Where the CLI lives.** `packages/evals` does not depend on `packages/llm`, because
   `packages/llm` already depends on the evals corpus in its tests and a workspace cycle would
   follow. The entry point `scripts/evals.ts` (root) wires the real roles into `evalsCli`, which
   takes them as an injected dependency and is tested with fakes.
4. **`--fake` is test support.** The scripted roles may only be imported by tests and
   test-support files (P4-3's lint rule). The fake target lives in
   `src/run/fake/test-support.ts` and the CLI imports it dynamically, only for `--fake`, so a
   live run never loads it. Its scores measure scripts, never a model.
5. **A versioned report without content.** Reports hold scores, counts, ids, paths, lines,
   versions (`PIPELINE_VERSION`, a hash of `PROMPT_TEXTS`), models and token usage per role,
   never code, prompts or model text, so they are safe to publish and to commit.
6. **The gate.** `compare` fails when total recall drops more than 5 points or the critical
   false-positive rate rises at all, over the PRs both reports ran; an incomplete (capped)
   report, a kind mismatch or no PR in common also fails. A placeholder baseline exits 3 and
   gates nothing; CI warns until a human commits the first real baseline.
7. **Spend control.** One meter per run counts tokens per role and refuses calls once
   `--max-tokens` is reached; `--dry-run` checks config and key without calling anything. In
   CI the key is a repository secret passed only to the step that runs the evals; without it the
   job skips with a notice.

## Consequences

- Recall on pr-847 tops out at 80% by design (two low findings in files the pipeline does not
  review). Precision is a lower bound: a real model may report real issues nobody seeded; the
  `tolerated` list absorbs known harmless ones.
- One clean sample is the reference for `verdictChanged` in the injection metrics, so with real
  models it includes sampling noise; it is reported, not gated.
- The critical false-positive gate fails on any rise, which with few critical findings is
  sensitive to noise. If nightly runs flap, the threshold is the knob, not the matching rules.
- Seeded PRs are small and public, so a model may eventually have seen them; add new ones over
  time rather than tuning prompts to these.
