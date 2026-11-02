# ADR 0014: The analysis pipeline

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P4-3
- **Amended by:** H4-7 (the map's flows and walkthrough are their own calls; "Amendment (H4-7)"
  below), H4-5 (the change map shows logic only: a deterministic scope on the graph
  call's input, cards reference mapped files only; "Amendment (H4-5)" below)
- **Revised:** review round 2: files with no hunks stay triaged (SF1); unanalysed files of unknown
  risk floor the verdict at medium, also at the write (SF2); fixed reasons for a raised verdict;
  every `@rocky-reviews/*/testing` subpath banned from production code, dynamic imports included.
- **Revised:** review round 1 (Fixes A to G): verdict floor for files that were not reviewed;
  deletion-only risky files marked unanalysed; quoted rename and copy paths; header consistency
  in the diff reader; raw review minutes in file units; the scripted fake banned from production
  code; the lease as a merge gate for the queue lane.
- **Revised:** P4-6 ([ADR 0017](0017-analysis-queue-and-token-limit.md)): the queue lane, the
  lease on `running` rows (R3 closed), the per-PR token limit and `awaiting_approval`.
- **Builds on:** [ADR 0004](0004-schema-first-llm.md) (schema-first output, one repair round),
  [ADR 0012](0012-llm-roles-and-provider-port.md) (roles and the provider port),
  [ADR 0013](0013-llm-provider-adapters.md) (adapters, prompt layout),
  [ADR 0010](0010-pull-request-mirror.md) (the mirror the pipeline reads)

## Context

P4-3 turns one pull request revision into one analysis document: rules pre-triage, then triage,
review of the files that matter, the change map, validate-and-repair, and storage. It must be
incremental: on a push, only the files that changed are sent to a model again. Everything it
reads from a pull request is untrusted, and everything a model says about it is too. The
pipeline must never store a partial or unvalidated document, and model output must never cause
an action.

## Decision

### 1. Where it lives

- `packages/core/src/analysis/`: the pipeline itself, pure domain code over ports. It takes the
  diff text, the PR's identifiers and the previous analysis, and returns an outcome. It has no I/O
  of its own: `LlmRoles` for models, `Clock`, and an injected `sha256Hex`. Core may import zod
  and `@rocky-reviews/schema`, and nothing else (ESLint).
- `packages/db/src/analyses.ts`: the `analyses` rows, inside `withOrg`.
- `apps/worker/src/analysis.ts`: `runAnalysis(deps, claim)` (P4-6: a claim from the queue) runs a leased row,
  reads the diff on a read-only repository session, runs the pipeline and stores the outcome.
- `packages/core/src/analysis/testing.ts` (`@rocky-reviews/core/testing`): a scripted
  `LlmRoles` for tests and evals.
- `packages/evals`: the pr-847 seeded diff, its scripted answers and the finding scorer that
  P4-7 grows into the eval suite.

### 2. Stage contracts

```text
diff ──parseUnifiedDiff──► files (known facts)
     ──preTriage (rules)──► noise | binary/too-large (unanalysed) | to analyse (+ floor)
     ──per file────────────► triage (role triage) ──floor──► level
                             └─ critical/important with new-side lines ──► review (role review)
     ──whole PR────────────► change map (role graph)   failure → graphUnavailable
                             briefing (role review)    failure → analysis failed
     ──assemble + parseAnalysisDocumentJson──► done (document + units) | failed (code)
```

| Stage    | Role     | Untrusted parts (labels)                                       | Answer contract                                               | On failure after repair                 |
| -------- | -------- | -------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| triage   | triage   | `file_path`, `file_status`, `diff`                             | `TriagedFile` without `path`; levels stop at `low`            | file unanalysed                         |
| review   | review   | `file_path`, `diff`                                            | `{ findings }`, each `Finding` without `id`, `path`, `memory` | file unanalysed (its triage is dropped) |
| graph    | graph    | `pr_title`, `file.N.path`, `file.N.diff` (triaged files)       | `Graph`                                                       | `graphUnavailable: analysis-failed`     |
| briefing | review   | `pr_title`, `triage`, `findings`, `noise`, `unanalysed` (JSON) | `summary`, `verdict`, `reviewPath`, `checkedOk`               | Rocky's fallback briefing (ADR 0015 §6) |
| repair   | the same | the same, plus `validation_issues`                             | the same                                                      | as above                                |

- **Known facts** (paths, statuses, counts, hunks, SHAs, PR number, repository, timestamp,
  generator, `unanalysed`, `graphUnavailable`) come from the diff and the caller. A model cannot
  name a file: the pipeline sets each finding's `path` to the file it reviewed, triage answers
  carry no path, and graph and briefing paths are integrity-checked against the file list.
- **Pipeline-computed fields:** finding ids (by severity, then file order, then line);
  `estimatedReviewMinutes` (the sum of the per-file minutes, scaled down to fit the 480-minute
  cap); `memoryApplied: []` (project memory is P8); the verdict, raised to the higher of two
  floors whatever the model said (`verdict.ts`):
  - the findings' floor: a critical finding means critical, a high one at least medium;
  - the floor of files that were **not reviewed**, that is, the files in `provenance.unanalysed`
    (review round 1 Fix A, round 2 SF2):
    - a file the rules floor (migration, auth path) or that triage called critical: at least high;
    - one triage called important: at least medium;
    - one whose risk is unknown (its triage failed or was refused, or it was too large or binary
      with no rules floor): at least medium. This fails closed.

    This covers every way a file can miss its review: triage or review failed (refused, invalid,
    timeout), too large, binary, or deletion-only. Otherwise a PR author could make a risky file
    fail on purpose (pad `src/payments/charge.ts` past the cap, get its triage refused) and talk
    the briefing into "low". Noise files and files triaged normal or low are not unanalysed: they
    are not reviewed by design and do not raise the verdict.

  - **Reason:** when a floor raises the level, the model's reason ("Looks fine.") is replaced by
    fixed Rocky text: `RAISED_FOR_FINDINGS` when the findings set the level, else
    `RAISED_FOR_UNREVIEWED` (round 2, N4). An unraised verdict keeps the model's reason.
- **Deletion-only files (Fix B):** a critical or important file with deleted lines and no
  new-side lines cannot carry a finding, so it is not shown as reviewed and clean. It goes to
  `provenance.unanalysed` (`analysis-failed`) with the fixed `detail` `DELETION_ONLY_DETAIL`. A
  deletion-only file triaged normal or low stays triaged; those levels are not reviewed anyway.
- **Files with no hunks (round 2, SF1):** a pure rename or copy, a mode-only change and an empty
  new file have no line to review. They stay triaged, are not sent to review, and do not raise
  the verdict.
- **Stored verdict check:** the not-reviewed floor is also a stored-document rule, as far as the
  document can express it. `belowVerdictFloor` (named `belowUnanalysedFloor` until P4-4, which
  added the critical-triage floor, ADR 0015 §8) runs in the pipeline's final check (defence in
  depth: the clamp above makes it unreachable) and in `completeAnalysis`. So no `done` row can
  hold a verdict below medium next to any unanalysed file, or below high next to an unanalysed
  migration or auth file. A non-rule file triaged critical whose review failed is high in the
  pipeline but only checked as medium at the write: an unanalysed file carries no triage level in
  the document, and carrying one is a schema change (a new optional field, a minor version, which the reading
  policy `SUPPORTED_VERSION_PATTERN` would make a cross-version migration). That is left to a
  schema task. The same reasoning keeps the deletion-only case on the existing
  `analysis-failed` reason with a fixed detail, rather than a new enum value.
- **Instructions** are `rockyInstructions` literals (`instructions.ts`); the repair instruction
  is joined to them with `joinInstructions`. Nothing that varies per call is in them.
- **Output caps** (`MAX_OUTPUT_TOKENS`): triage and briefing 16K, review and graph 64K (ADR
  0012 N9). Token budgets per PR are P4-6.

### 3. Rules pre-triage

Deterministic, from the path only (`rules.ts`), checked in this order:

1. **Migrations** (a `migrations`, `migration`, `migrate` or `alembic` directory, or any `.sql`
   file) and **auth paths** (`auth`, `login`, `session`, `permission`, `secret`, `crypt`,
   `token`, `jwt`, `acl`, ... anywhere in the path) get a **floor of `important`**: they are
   always reviewed. Over-matching (`author.ts`) only adds review. **Test files do not get the
   auth floor:** files under a `test/`, `tests/`, `spec/`, `specs/`, `e2e/` or `__tests__/`
   directory, and names like `*.test.*`, `*.spec.*`, `*_test.*` and `*_spec.*`. The model still
   triages them, and a steered model can triage them low (R2). Migrations have no test exemption.
2. **Lockfiles** (exact basenames) and **generated files** (a `generated` directory,
   `.generated.`, `.pb.go`, `_pb2.py`, `.min.js`, ...) are **noise**. They are never sent to a
   model, and their summary is fixed Rocky text saying the AI did not read them.
3. Binary files and files over 5 000 patch lines or 200 000 characters are unanalysed
   (`binary`, `too-large`) without a model call. Their rules floor still counts toward the
   verdict (§2, Fix A).

Security rules win over noise rules. Only rules make a file noise: the triage contract has no
`noise` level.

The diff reader (`diff.ts`) is strict (review round 1, Fixes C and D):

- `rename from|to` and `copy from|to` values are C-unquoted when git quoted them; they carry no
  `a/` or `b/` prefix. A copy is read as an added file at its target.
- Every source that names a side must agree, or the diff fails as `diff_unparseable`. The sources
  are the `diff --git` pair (when it splits unambiguously), the `---`/`+++` paths (ignoring
  `/dev/null`), and the rename and copy paths.
- `---` and `+++` come as a pair, once each. A new file's base side and a deleted file's head
  side must be `/dev/null`. A file cannot be both renamed and copied, or created and deleted.

### 4. Validate and repair

Every answer is schema-validated by the port (the stage's Zod contract, emitted as JSON Schema),
then integrity-checked by the same code that checks a stored document:

- a triage or review answer is placed in a **one-file analysis document** with the file's known
  facts (and its full new-side content when the diff holds it, for suggestion checks) and parsed
  with `parseAnalysisDocumentJson`;
- graph and briefing answers are checked in the **whole assembled document**.

Issues go back as `path: CODE` lines rebased onto the answer, in an untrusted
`validation_issues` part: never messages, which can quote values. There is **at most one repair
round** (`MAX_REPAIR_ROUNDS = 1`, ADR 0004), so a unit costs at most two calls. Refused and
truncated answers are not repaired. An issue outside the answer (a pipeline fault) is
unrepairable. Before the change map and the briefing, the units are checked together; after the
briefing, the whole document is parsed once more, and only a document that passes is returned.

### 5. Errors

- `context_too_long` / `request_too_large` → the unit is `too-large`; `timeout` → `timeout`.
- Other retryable kinds and `cancelled` are thrown; the worker requeues the row and returns
  `retryAfterMs` for the queue.
- Other fatal kinds → the analysis fails as `llm_<kind>`.
- Anything else → `internal_error`. Nothing from the error is kept.

Failure codes are fixed (`AnalysisFailureCode`, plus the worker's `forge_*`, `diff_unavailable`,
`diff_not_utf8`, `repository_inaccessible`, `no_org`) and shape-checked at the write.

### 6. Incremental keying

A file's unit key is `sha256(JSON[PIPELINE_VERSION, salt, path, previousPath, status, patch])`:

- the **patch** includes the hunk headers, so line numbers are part of the key;
- `PIPELINE_VERSION` is bumped whenever instructions, contracts or rules change;
- the **salt** is a digest of the triage and review roles' provider, model, effort, platform
  model and provider settings (`unitKeySaltFor`), so a model change re-analyses everything.

A file is reused from the pull request's previous finished analysis only when:

- the unit key matches;
- its known facts match;
- it was analysed (it is in `triage.files` and not in `unanalysed`; failures are retried).

Its triage and findings are taken from that document (ids and memory dropped), floors are
re-applied, and the result is validated with the rest. The unit stores the triage model's own
`reviewMinutes` (review round 1, Fix E). Its document copy may have been scaled down to fit the
480-minute cap, and a reused file takes the raw value back, so a later push never scales a file
twice and the ratio between files is kept. Graph and briefing are whole-PR and run
on every push. The key and reuse are tested in `pipeline.test.ts` (A5). The second-push
criterion is tested in `pr-847.test.ts` and `analysis.e2e.test.ts`.

### 7. Storage

No new table. Migration 0010 adds `analyses.file_units jsonb` (`[{ path, key, reviewMinutes }]`),
allowed only on
`done` rows (CHECK), and an index on `(org_id, revision_id)`. The row keeps its tenant policy
(0003), its composite foreign key to `pr_revisions`, retention (`analyses`, 90 days) and
erasure.

- **States:** `queued` → `running` (claimed atomically) → `done` | `failed`, or back to `queued`
  for a retryable failure. Since P4-6 also `awaiting_approval` (over the per-PR token limit).
- **A row could stay `running`** after a worker crash, or when `failAnalysis` or
  `requeueAnalysis` itself throws inside `runAnalysis`'s error path (a database outage). P4-6
  (migration 0012, [ADR 0017](0017-analysis-queue-and-token-limit.md)) adds the lease that was the
  merge gate for the queue lane (R3): the claim hands out a lease, every write needs it, and an
  expired lease is reclaimed by the next claim.
- **`completeAnalysis`** parses the document again at the write, stores the parsed value, and
  checks that every unit names a triaged file of it. It also refuses a verdict below an
  unanalysed migration or auth file (`belowUnanalysedRuleFloor`, Fix A).
- **`failAnalysis`** stores a code matching `^[a-z][a-z0-9_]{0,63}$`, with no document and no
  units.
- **`loadPreviousAnalysis`** finds the latest `done` row of the same pull request (any
  revision) and re-validates it; anything that does not validate is not offered for reuse.
- **Roles:** the worker's login (`rocky_app` + `rocky_worker`) and the server's (`rocky_app`)
  both run these under RLS. Nothing needs `rocky_worker` or `rocky_lifecycle`, and no grant
  changes.

### 8. Worker wiring and seams

- **At boot:** the worker validates `ROCKY_LLM_*` (`loadWorkerConfig`) and builds the roles
  (`createLlmRoles(config.llm, providerAdapters(), envSecrets(env))`). A bad config stops it
  before it claims work.
- **Test fakes:** ESLint bans value imports of every `@rocky-reviews/*/testing` subpath outside
  `*.test.ts` and `test-support.ts` files. This covers the scripted `LlmRoles`, recording
  adapters, database fixtures and the fake GitHub. It uses
  `@typescript-eslint/no-restricted-imports`, and type-only imports are allowed. Testing modules
  themselves get no exemption. `import("@rocky-reviews/<pkg>/testing")` with a literal specifier
  is banned too (`no-restricted-syntax`). A computed specifier (a variable or template) is not
  caught by lint; that gap is accepted, since production code has no reason to build one. Planted
  cases are in `scripts/lint-rules.test.ts` (review round 1 Fix F, round 2 N2).
- **Queue:** `runAnalysis` is the unit of work for the queue lane. P4-6 built the lane (enqueue on
  a new head revision, claim with a lease, retry with backoff, org concurrency cap):
  [ADR 0017](0017-analysis-queue-and-token-limit.md).
- **Metering (P4-5)** wraps the `LlmRoles` handed to the pipeline. Every call goes through it,
  and results carry `provider`, `model`, `usage` and `attempts`.
- **Token limits (P4-6)** plug in before `analyzePullRequest`: `estimateAnalysisTokens` and the
  `awaiting_approval` hold ([ADR 0017](0017-analysis-queue-and-token-limit.md) §5). The per-file
  `too-large` and graph-size checks are unchanged.

## Threat model

**Assets:**

- the integrity of the review: findings, triage levels, the verdict;
- tenant code and diffs;
- Rocky's instructions;
- the stored analysis (what humans act on);
- provider spend.

**Attackers:**

- a PR author: a hostile diff, path, title, or a file shaped to steer a model;
- a model steered by them;
- another tenant;
- anyone reading logs or errors;
- a tampered or stale database row.

| #   | What can go wrong                                                                                                       | Prevention                                                                                                                                                                            | Test                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | PR text (title, path, diff) becomes instructions                                                                        | Instructions are `rockyInstructions` literals; PR text and model-derived text travel only in `untrusted` parts under fixed labels; adapters delimit them (ADR 0013)                   | `pipeline.test.ts` "A1 …" (every call's instructions are one of the literals; title and paths never in them; labels fixed)                                                                                                      |
| A2  | A bad answer is stored, partially stored, or repaired forever                                                           | Contract + integrity per unit; one repair round; units checked together; whole document parsed before return and again at the write; failures are codes with no document              | `pipeline.test.ts` "A2 …" (1 + `MAX_REPAIR_ROUNDS` calls, unanalysed, briefing → no document, graph → unavailable, strict contract); `analyses.test.ts` "refuses an invalid document…"                                          |
| A3  | A model (or PR) talks a file or a risk out of review                                                                    | Noise only by rules; floors on migrations and auth paths; review failure makes the file unanalysed, not clean; verdict raised to the findings' floor                                  | `rules.test.ts`; `pipeline.test.ts` "A3 …"; `pr-847.test.ts` "noise and files below important never reach the review model" (decoys)                                                                                            |
| A4  | A finding lands on another file or outside the diff                                                                     | The pipeline sets `path`; ranges checked against hunks (`LINE_OUTSIDE_DIFF`); suggestions against the new-side content                                                                | `pr-847.test.ts` "a finding outside the diff goes back for one repair round…"; `pipeline.test.ts` "a model cannot invent a field…"                                                                                              |
| A5  | Stale or poisoned reuse (another PR, another tenant, changed code, changed model)                                       | sha256 key over everything sent + version + role-config salt; same PR only, loaded inside `withOrg`; facts must match; stored rows re-validated on read; reused units validated again | `pipeline.test.ts` "A5 …" (salt, forged key, tampered document, changed facts, failed unit retried); `analyses.test.ts` "a stored document that no longer validates…", "tenancy"                                                |
| A6  | Cross-tenant access to analyses                                                                                         | RLS + explicit `org_id` filters; composite FK to `pr_revisions`; claim/finish/requeue match `org_id`                                                                                  | `analyses.test.ts` "another org cannot claim, finish, requeue or reuse a row", "…another org's revision (composite FK)"; `analysis.e2e.test.ts` "another org's analysis id is not claimed"                                      |
| A7  | Model output causes a side effect                                                                                       | The pipeline has no forge handle; the worker uses a read-only `RepositorySession` (reads + `close`); no tools are sent (ADR 0013); output is a stored draft                           | `analysis.e2e.test.ts` (the recording forge sees `openRepository`, `getDiff`, `close` only)                                                                                                                                     |
| A8  | Code, diffs, titles, prompts or model output in logs or errors                                                          | Logs carry ids, counts, sizes, fixed codes; errors map to codes; non-LLM errors become `internal_error` with nothing kept; issue lists never logged                                   | `analysis.e2e.test.ts` (no title marker, code, path or model text in captured logs); `pipeline.test.ts` "a port that throws something else…"                                                                                    |
| A9  | A hostile diff crashes the parser or smuggles a header                                                                  | Hunks read by header counts; strict header grammar; unknown lines, bad counts, out-of-order hunks, unsupported paths, duplicates fail the diff; never throws                          | `diff.test.ts` (fails-closed cases, header-in-content, fast-check fuzz)                                                                                                                                                         |
| A10 | An incomplete diff is analysed as if complete (files silently missing)                                                  | A truncated diff (`max_bytes`, `forge_limit`) fails as `diff_truncated`; `unavailable` fails; non-UTF-8 fails                                                                         | `pipeline.test.ts` "A4 …"; `analysis.e2e.test.ts` "fails closed before any model call"                                                                                                                                          |
| A11 | Unbounded cost or size (huge files, huge PRs, many issues)                                                              | Per-file patch cap; graph input cap; output caps; ≤ 2 calls per unit; ≤ 50 issues per repair; the document's own limits                                                               | `pipeline.test.ts` "A6 …", "a PR too large for the change map…"                                                                                                                                                                 |
| A12 | Failure text carries PR content into the UI or the database                                                             | Noise summaries and `graphUnavailable` are fixed text or absent; `error_code` shape-checked; `unanalysed.detail` only ever the fixed `DELETION_ONLY_DETAIL`                           | `rules.test.ts` "noise summaries are fixed…"; `analyses.test.ts` "codes are shape-checked"                                                                                                                                      |
| A13 | An outage marks good files unanalysed, or a retry loses the row                                                         | Retryable kinds abort the run (siblings cancelled) and requeue the row with the hint; only `timeout` and size are per-unit                                                            | `pipeline.test.ts` "a retryable … error is thrown…", "the first failure stops the other files"; `analysis.e2e.test.ts` "requeues the row"                                                                                       |
| A14 | A bad LLM config runs until the first PR                                                                                | Config validated and roles built at worker boot                                                                                                                                       | `config.test.ts` "validates the LLM roles at boot (P4-3)…"                                                                                                                                                                      |
| A15 | A risky file fails on purpose (refused review, padding, a NUL byte, deletion only) and injected text lowers the verdict | Not-reviewed floor: rules-floored or critical → ≥ high, important → ≥ medium; the rules half re-checked in the final check and at the write                                           | `pipeline.test.ts` "A15 …" (refused review/triage, too-large auth and migration, binary auth, critical/important levels); `analyses.test.ts` "refuses a document whose verdict sits below an unanalysed auth or migration file" |
| A16 | A deleted critical file looks reviewed and clean                                                                        | Deletion-only critical/important files go to `unanalysed` with fixed detail and count toward A15                                                                                      | `pipeline.test.ts` "A16 …" (deleted `src/auth/guard.ts` and `src/core/engine.ts` triaged critical)                                                                                                                              |
| A17 | Header confusion in the diff: a file reviewed under one path and stored under another; a quoted rename failing the PR   | Header, `---`/`+++`, rename and copy paths must agree; `---`/`+++` paired; `/dev/null` sides checked; quoted move paths unquoted                                                      | `diff.test.ts` "unquotes git's C-quoted rename and copy paths…", "a +++ path that disagrees with the header" and the other Fix D cases                                                                                          |
| A18 | Reuse skews review minutes (scaled twice)                                                                               | Units hold the raw `reviewMinutes`; scaling happens only when composing the document                                                                                                  | `pipeline.test.ts` "A17 reused units keep raw review minutes…"                                                                                                                                                                  |
| A19 | Test fakes answer in production                                                                                         | ESLint bans value imports (static and literal dynamic) of every `@rocky-reviews/*/testing` subpath outside test and test-support files                                                | `scripts/lint-rules.test.ts` "the scripted LLM fake stays out of production code…" (incl. round 2: other subpaths, testing modules, dynamic import)                                                                             |
| A20 | A file with no hunks (rename, mode change, empty file) is marked unanalysed and forces the verdict up                   | The deletion-only branch requires deleted lines; files with no hunks stay triaged and are not reviewed                                                                                | `pipeline.test.ts` "A20 files with no hunks are not deletion-only…"                                                                                                                                                             |
| A21 | A non-rule risky file is padded, made binary or has its triage refused, and the briefing says "low"                     | Unanalysed files of unknown risk floor the verdict at medium; at the write, any unanalysed file needs ≥ medium; a raised verdict gets a fixed reason                                  | `pipeline.test.ts` "A21 …", "A22 …"; `analyses.test.ts` "refuses a verdict below medium next to any unanalysed file"                                                                                                            |

### Residual risks

- **R1:** a PR author can name a file so a rule calls it a lockfile or generated, and keep it
  from the AI (not from humans). It stays in the noise list with a summary saying the AI did not
  read it. Security paths are never noise. Content-based checks for generated files are a
  follow-up.
- **R2:** a model steered by PR content can still write a wrong or misleading draft: a lower
  triage on a path no rule floors (test files included), a soft verdict reason, a persuasive body.
  That is a draft for a human, never an action. P4-4 adds the injection corpus, the leak guard and
  the verdict invariants ([ADR 0015](0015-prompt-injection-defence.md), R1 and R2).
- **R3 (closed by P4-6):** a crash between claim and finish, or a database error inside
  `runAnalysis`'s own failure path, left a row `running`. The lease of
  [ADR 0017](0017-analysis-queue-and-token-limit.md) §3 reclaims it (Q1, Q2 there).
- **R4:** a retryable failure late in a run (graph, briefing) re-runs the whole revision,
  including units already answered, so the spend repeats. Checkpointing units is a follow-up.
- **R5:** real model quality (recall, precision, critical false positives) is not measured here:
  the tests use a scripted model. P4-7 and P4-8 measure it with a real key.
- **R6:** structured outputs on a real provider may reject parts of the stage schemas (the
  graph's recursive views). That is untested live. It shows up as `invalid_request` →
  `llm_invalid_request` and needs a P4-8 run.

## Consequences

- Moving a stage to another model is config. A changed prompt is a `PIPELINE_VERSION` bump,
  which re-analyses every file once.
- The analysis document stays the only AI output anything reads. A unit holds a path, a key and
  `reviewMinutes`, a bounded integer from the triage model (0 to 480, schema-checked). It is not
  a second copy of model output.
- Per-file triage is cheap to cache, but it cannot rank files against each other: scores are
  per file. The briefing orders the review path.

## Amendment (H4-5): the change map shows logic only

**Context.** Dogfooding on a private pull request (a money ledger plus repository scaffold): the
map had ten cards, of which five were logic modules, one the tests, three configuration (the CI
workflow, ESLint, the toolchain) and one documentation. The graph call got every triaged file.
Product rule (decided by the maintainer, `docs/progress.md` "Dogfooding follow-ups"): the map
shows **code with behaviour**; configuration or documentation appears only when it changes
behaviour the code reads at run time. H4-4's follow-up is paired with it: the model is asked only
for what the page draws (lanes, nodes, edges), as an enforced output again
([ADR 0013](0013-llm-provider-adapters.md), [ADR 0021](0021-change-map-renderer.md), amendments
H4-5).

**Decision.**

1. **A deterministic scope on the graph call's input** (`packages/core/src/analysis/map-scope.ts`,
   `mapCategory` and `changeMapScope`), from the path alone, like the rules pre-triage it extends
   (§3). It narrows only the graph call: every file is still triaged and reviewed. The first rule
   that matches wins:

   | #   | Category  | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
   | --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | 1   | `test`    | by name or Jest convention: `__tests__/`, `__mocks__/`, `__fixtures__/`, `__snapshots__/`; `*.test.*`, `*.spec.*`, `*_test.*`, `*_spec.*`, `*.cy.*`, `*.snap`, `test_*`, `conftest.py`; `*Test.java`-style class suffixes only behind a boundary on the original-case name (`LedgerTest.java`, `ledger_test.kt`; `Contest.java`, `Latest.kt`, `Attest.swift` are code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
   | 2   | `logic`   | **kept definitions by name**: `.sql`, `.proto`, `.graphql`/`.gql`, `.prisma`, `.avsc`, `.thrift`, `.fbs`, `.wsdl`, `openapi.*`, `swagger.*`, `*.schema.*`; `Dockerfile*`, `docker-compose*`, `compose.*`, `*.dockerfile`, `fly.toml`, `Procfile`, `app.yaml`, `serverless.yml`, `vercel.json`, `*.tf`; `.env*` the application reads (`.envrc` included; not the samples, row 7). They win over a test directory (`api/spec/openapi.yaml` is the API), not over row 1                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
   | 3   | `test`    | by directory: `test/`, `tests/`, `spec/`, `specs/`, `e2e/`, `cypress/` anywhere; `fixtures/`, `testdata/`, `test-data/` under one of them or at a root (`app/fixtures/seed.rb` is code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
   | 4   | `ci`      | `.github/`, `.gitlab/`, `.circleci/`, `.buildkite/`, `.ci/`, `ci/` at a root (`src/integrations/ci/runner.ts` is code), and the well-known pipeline files (`.gitlab-ci.yml`, `.travis.yml`, `azure-pipelines.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `.drone.yml`, `appveyor.yml`, `cloudbuild.yaml`, ...)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
   | 5   | `logic`   | **kept definitions by directory**: migrations (`migrations/`, `migration/`, `migrate/`, `alembic/`) and deploy trees (`k8s/`, `kubernetes/`, `helm/`, `terraform/`, `deploy/`, `deployment/`), for a file that is not a doc                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
   | 6   | `tooling` | by name: package manifests and lockfiles (`package.json`, `pnpm-workspace.yaml`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `requirements*.txt`/`.in`, `pom.xml`, `*.csproj`, `*.sln`, `*.lock`, ...); a build, lint, format, type-check, test-runner or scanner tool **only as its configuration file**: `<tool>.config.*`, `<tool>.conf.*`, `<tool>.workspace.*`, `<tool>.setup.*`, `.<tool>rc*`, `.<tool>ignore`, `<tool>.{json,jsonc,json5,yaml,yml,toml,ini,cjs,mjs}` (tools: eslint, prettier, vite, vitest, jest, babel, rollup, webpack, esbuild, tsup, playwright, cypress, tailwind, postcss, biome, turbo, nx, lerna, renovate, codecov, sonar, gitleaks, semgrep, trivy, snyk, hadolint, markdownlint, yamllint, cspell, ...; `lib/jest.ts` and `semgrep.ts` are code); `tsconfig*.json`; editor and repository dotfiles (`.editorconfig`, `.gitignore`, `.npmrc`, `.nvmrc`, `.tool-versions`, ...) |
   | 7   | `docs`    | Markdown, MDX, reStructuredText, AsciiDoc, `.txt`, `.org`, `.pod`, `.cff`; `docs/`, `doc/`, `documentation/`, `adr/`, `adrs/`, `rfc/`, `rfcs/`, `wiki/` at a root (`src/docs/generator.ts` is code); `README`, `LICENSE`/`LICENCE`, `COPYING`, `NOTICE`, `AUTHORS`, `CONTRIBUTORS`, `CHANGELOG`, `CHANGES`, `HISTORY`, `CODEOWNERS`, `CONTRIBUTING`, `SECURITY`, `FUNDING`, `CODE_OF_CONDUCT`, `CITATION` **only without an extension** (`LICENSE-MIT`) or with a doc one (`SECURITY.md`; `security.ts`, `history.rb`, `license.ts` are code); `.mailmap`; `.env.example`, `.env.sample`, `.env.template`, `.env.dist`                                                                                                                                                                                                                                                                                                    |
   | 8   | `tooling` | by directory at a root: `scripts/`, `tools/`, `.husky/`, `.changeset/`, `.vscode/`, `.idea/`, `.devcontainer/`, `.yarn/` (`src/agent/tools/search.ts` and `cmd/tools/main.go` are code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
   | 9   | `logic`   | everything else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

   A root is the repository root or a package root: the directory right under `apps/`,
   `packages/`, `services/`, `libs/`, `modules/`, `crates/`, `projects/` or `workspaces/`
   (`packages/core/scripts/gen.ts` is tooling). Review round 1 (B1, S1–S4) anchored every rule
   this way after ordinary production names (`security.ts`, `history.rb`, `lib/jest.ts`,
   `Contest.java`, `src/agent/tools/search.ts`) were misclassified by stem, prefix, suffix or
   segment matches that ignored the extension or the position in the path.

   Judgment calls, recorded: deploy configuration is kept because a path cannot tell whether it
   changes what runs, and the graph instructions tell the model to map configuration only where
   code reads it; `next.config.js`, `app.config.ts`, `config/*.yml` and `settings.*` are logic
   (runtime settings); `vite.config.ts` and `tailwind.config.js` are tooling (build); test-runner
   configuration is tooling, a test tree is a test; a documentation site's own code under `docs/`
   is left out; `scripts/` is tooling even when a script runs in production (follow-up if it
   bites); `bin/` is logic.

2. **What the call gets.** `changeMapScope` runs over every file the rules left to the AI
   (noise excluded), each marked mappable when its triage succeeded (S5). The logic files decide:
   when the pull request changes logic, the map is the mappable logic files in diff order, or
   unavailable when none of them could be sent (`too-large` when a binary or over-size file is
   among them, else `analysis-failed`), never a map drawn from the tests. Without logic, the
   tests are the logic, with the same rule ("the tests are the logic"). With neither, no call is
   made and the document records `provenance.graphUnavailable: { reason: "no-logic" }` (schema
   1.2), which the renderer and the web show as Rocky's fixed sentence about the path rules; a
   pull request whose triaged set is empty (all noise or unanalysed) keeps today's "no graph, no
   reason". The map's input budget (`GRAPH_MAX_INPUT_CHARS`) is counted over the mapped files
   only, so documentation cannot push a small change over it. The excluded files' paths and
   diffs are not in the call at all, which also makes it cheaper (the dogfooding pull request,
   29 files: the graph call went from 37,994 to 11,029 input tokens, 48,294 to 16,384 in total
   with the schema's cache write, and from ten cards to five, all backed by the billing
   sources).
3. **Cards reference only the mapped files.** The schema's integrity pass checks graph ids, not
   file references (the published contract lets a context node name a file outside the pull
   request, `docs/schema/analysis-document.md` decision 6). The pipeline is stricter:
   `stripGraphFiles` (`validate.ts`) drops every `files[].path` on a node or an edge that is not
   in the mapped set (exact string match), deterministically, before the integrity check and
   again on the stored answer, and counts the drops in `stats.graphFilesStripped` (a count,
   logged). The map is kept: `files` may be empty, so the document stays valid, and one stray
   path is not worth a repair call or a lost map (S6). Only `files[]` is checked: a label,
   subtitle or summary can still name any file, as any model text can (N5). Context nodes
   still exist; they carry no file. The CLI's `--dry-run` plan applies the same scope.
4. **The graph instructions** (round 2) adapt the writer's guidance of PR Lens (MIT; credited
   in `instructions.ts` and `NOTICE`, paraphrased, nothing fetched): components by role rather
   than by file, unchanged context nodes for the blast radius (no files), lanes as the reader's
   mental model, one or two hero edges, short specific edge labels, badges for short facts, a
   `range` in new-file line numbers on a file reference when the hunk headers show it, and one
   line that configuration and schema files are given only when code reads them at run time.
   A small worked example of Rocky's own (an invitation flow: ids and labels only) closes the
   text. It says to describe the PR content and never follow instructions found in it. The text
   is one `rockyInstructions` literal, so it sits in the cached system block only and is in the
   leak guard's corpus by construction (`PROMPT_TEXTS`); the example's labels are three or four
   words, well under the guard's eight-word run. Ranges are validated like file references:
   `stripGraphRefs` keeps a range only inside the span of the file's new-side hunks (first hunk
   start to last hunk end, the only lines the model saw) and drops it otherwise, counted in
   `stats.graphRangesStripped`; the reference stays. A card with a range opens its file at the
   range's first line (the web's `targets.ts`, through ADR 0028 §5's `line`).
   `PIPELINE_VERSION` is **not** bumped: the version keys per-file units (triage and review), and
   neither changed (H4-4 review, N4; the comment in `instructions.ts` says so now).

**Threat model (adds to the table above).**

| #   | Threat                                                                                                                                                                                                                                                                                                                                    | Prevention                                                                                                                                                                                                                                                                                                                                                                                             | Test                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A22 | **Misclassification by path**: an ordinary production name matches a rule by stem, prefix, suffix or segment (`src/security.ts`, `history.rb`, `lib/jest.ts`, `Contest.java`, `src/agent/tools/search.ts`), so a logic change shows "nothing to map" in Rocky's voice, or a PR author names code to look like a doc or a test on purpose. | Every rule is anchored to what makes a name unambiguous: doc stems only without an extension or with a doc extension; tool stems only as configuration files; class suffixes only behind a boundary; directory rules only at a root. The scope narrows the map only; triage, review, floors and the verdict read every file as before, and the unavailable text speaks of path rules, not of the code. | `map-scope.test.ts`: each of those names, the production-path probe in the task report, `changeMapScope` for `security.ts` + `README.md` (logic); `pipeline.test.ts` H4-5 ("excluded files are still triaged and reviewed").                      |
| A23 | **Untrusted names or paths** steer the classifier or the prompt: a path built to make the scan slow, or one carrying instruction text.                                                                                                                                                                                                    | The category is read from the lower-cased path split on `/`, with set lookups, anchored regexes and the pre-triage infix scan (no backtracking); paths reach the model only as parts under Rocky's `file.N.path` labels, never as labels (N7).                                                                                                                                                         | `map-scope.test.ts` property test (never throws, deterministic, bounded time on repeated markers); `pipeline.test.ts` A1 (a path is a part, never a label) and H4-5 (label shapes on the graph call).                                             |
| A24 | **Excluded-file content reaches the model** anyway (a diff of a doc in the graph call), defeating the product rule and the saving.                                                                                                                                                                                                        | The graph parts are built from the mapped set only; nothing else is in the call.                                                                                                                                                                                                                                                                                                                       | `pipeline.test.ts` H4-5: no excluded path or diff in any graph part; the test-only and docs-only cases; the budget counts mapped files only.                                                                                                      |
| A25 | **The model maps files outside the set**: a card backed by an excluded file (seen in a previous run, or guessed: `README.md`, `.github/workflows/ci.yml`) or a non-PR file.                                                                                                                                                               | `stripGraphFiles` on every graph answer, before the integrity check and before storage: the reference is dropped, the map kept, the count logged. The schema's own checks and the leak guard are unchanged; a map that is otherwise invalid still gets its repair round.                                                                                                                               | `validate.test.ts`; `pipeline.test.ts` H4-5 (an excluded PR file, a file outside the PR, a differently-spelled path, an edge: one call, the reference gone, `graphFilesStripped` counted; a stripped map with an unknown lane is still repaired). |
| A26 | **"Nothing to map" shown with model text**, or a model claiming a map is unavailable.                                                                                                                                                                                                                                                     | `no-logic` is an enum value written by the pipeline; `applyKnownFields` owns `graphUnavailable`; the renderer and the web print their own sentence for it; `BriefingUnavailable` keeps its three reasons.                                                                                                                                                                                              | `v1-2.test.ts` (accepted for the graph, refused for the briefing, any other text refused); `render.test.ts` and `briefing-model.test.ts` (fixed text).                                                                                            |

**Residual risks.**

- **R7:** a runtime file the rules call tooling or docs (a settings file at a root `scripts/`,
  a `robots.txt`, a `requirements/` tree's `.txt`) is missing from the map. Only the map: the
  review is complete. The table is deliberately narrow and amended by evidence (the probe over
  NestJS, Rails, Django, Go, agent `tools/` and JVM paths in the H4-5 report).
- **R8:** the grammar-size limit on the enforced graph schema is the provider's and unverified
  offline (ADR 0013 amendment H4-5); the real run is the evidence.
- **R9:** the path rules are heuristics. A root `docs/` holding a documentation site's code, a
  root `tools/` holding a product's own tools, or a test tree holding a `.sql` definition (kept)
  are classified by convention, not by content; `fixtures/` under `app/` is code. The map's
  unavailable text says "Rocky's path rules found only …", never a claim about the code.
- **R10:** a model can still name an excluded file in a card's label, subtitle or summary; only
  `files[]` is checked, so such a card is a picture with a misleading caption, not a link.
- **R11:** a range is checked against the span of the file's hunks, not against the component's
  real lines: a range inside the span that points at the wrong lines of a mapped file is kept
  and the card opens there. The new file's length is unknown to the pipeline, so nothing
  beyond the last hunk is accepted, which can drop a correct range on an unchanged tail.

## Amendment (H4-7): the map's flows and walkthrough are their own calls

**Context.** H4-5 asked the graph role for lanes, nodes and edges only, as an enforced output,
and left the document's `flows` empty and its `walkthrough` absent; `docs/progress.md` recorded
"flows as their own call" as the approved direction (a sequence shows the order of checks, which
a component map cannot) and the walkthrough as its own call too, since the walkthrough on top of
the graph pushed the enforced grammar over its limit (H4-4). H4-6 builds their UI in parallel.

**Decision.**

1. **Two more calls on the graph role, after the graph call, each its own enforced output**
   (`stages.ts`: `flows`, `walkthrough`; `AnalysisStage` grows accordingly). They run only when
   the map was drawn: `no-logic`, `too-large` and a failed graph call skip both, with no call and
   no reason in the document (the map's own reason covers them; `stats.flows` and
   `stats.walkthrough` say `skipped`).
   - **The flows call** asks for one to three key runtime sequences as ordered steps between the
     map's node ids. `FlowsAnswer` (`outputs.ts`) is the document's `Flow` with the message's
     `payload` left out: the payload's sample is a recursive JSON value, which no enforced
     grammar takes, and the sequence is what the reader needs. Zod cannot `.omit()` from a
     refined object, so `FlowMessageBase` (schema) is the unrefined shape and the projection
     re-applies the self rule. 9 optional fields, no `$defs`.
   - **The walkthrough call** asks for three to seven steps, each the document's step `id`,
     `heading` and `body` with a flat focus of node and edge ids (`StepFocusAnswer`). The
     document's `StepFocus` also takes lanes, a stage and a flow's message ids, which need views
     or a staged flow that Rocky does not draw; `toWalkthrough` (`validate.ts`) writes the flat
     selection into the document's shape, an empty one as `{ kind: "all" }`. 2 optional fields.
   - Both schemas go through the SDK transform and the optional-field count in
     `wire-schema.test.ts`, like every stage.
2. **Input follows the graph call's rules.** Each call gets exactly the graph call's parts (the
   title and the mapped files' paths and diffs: logic only, A24) plus the map's **outline** as an
   untrusted part labelled `graph` (ids, labels, kinds, lanes and edge ends; no summaries, no
   file references), and the walkthrough call also the flows' outline under `flows` (`[]` when
   none). The outline is model-written text and travels like the diff it describes; the
   instructions (`FLOWS_INSTRUCTIONS`, `WALKTHROUGH_INSTRUCTIONS`) are `rockyInstructions`
   literals, in `PROMPT_TEXTS`, paraphrasing PR Lens's guidance (credited in `instructions.ts`
   and `NOTICE`). The walkthrough runs after the flows so it can name them; the two are not run
   in parallel, which also keeps one reservation in flight under the CLI's cap.
3. **Validation is the document's, with references stripped first.** `stripFlowRefs` drops a
   participant that names no declared node, then every message no longer between two
   participants, then a flow left under the document's minimum; message file references and
   ranges follow the graph's `keep` (mapped set, hunk span). `stripWalkthroughRefs` drops focus
   ids the map does not declare and a step whose named focus lost every id; a step given no focus
   keeps meaning the whole map. Drops are counted (`stats.flowsStripped`,
   `stats.walkthroughStripped`; file and range drops in the graph's counters). What remains is
   checked in the whole assembled document (`checkPart`; `partitionIssues` routes `graph.flows`
   and `graph.walkthrough` issues to their own calls, rebased as `flows…` and `steps…`), so
   duplicate ids and the self rule still go back for the one repair round; an answer with no flow
   left is sent back as `flows: too_small`, too few steps as the document's own `steps`.
   The leak guard runs on every answer in `completeWithRepair` and on the stored graph whole.
4. **Failure leaves the section absent, never the analysis.** A refusal, truncation, invalid
   output after the repair round, an input too large or a timeout records
   `provenance.flowsUnavailable` or `provenance.walkthroughUnavailable` (`{ reason }`, schema
   1.3; `MapSectionUnavailableReason` is `analysis-failed`, `too-large`, `timeout`) and the same
   code in `stats`; the graph, the findings and the briefing are untouched. A retryable error is
   thrown for the queue, as everywhere. `applyKnownFields` owns both fields and drops the section
   beside a pipeline reason; the document refuses a section next to its reason, and a reason
   without a map. Documents that use neither field keep their earlier stamp (`requiredSchemaVersion`).
5. **Cost.** Both calls go through the same `LlmRoles` as every call, so metering (ADR 0016) and
   the CLI's cap (`budget.ts`) apply unchanged; `ANALYSIS_STAGES` is 6 for the per-PR estimate
   (ADR 0017 §5); `MAX_OUTPUT_TOKENS` is 16K each; the dry-run plan lists them as planned, not
   certain. `stats.usageByStage` records the provider-reported input, output, cache-read and
   cache-write tokens per stage, summed over its calls, under key names the log redactor keeps
   (review round 1, SF1: `tokens` and `output` are redacted; `inputTokens`/`outputTokens` are
   allowlisted). The per-PR estimate (ADR 0017 §5) counts the mapped diffs once per graph-role
   call (three: the map, the flows, the walkthrough) and charges the map's three stages only
   when there is a map (review round 1, security low: the mapped diff is re-sent up to six
   times once repair rounds are counted, each call bounded by `GRAPH_MAX_INPUT_CHARS`). The fake evals baseline was regenerated
   with a 2M cap (the injection run now makes 279 graph-role calls; scores and injection totals
   are unchanged).

**Threat model (adds to the tables above).**

| #   | Threat                                                                                                                                                                                                                                             | Prevention                                                                                                                                                                                                                                                           | Test                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A27 | **PR text or model text becomes instructions** in the two new calls: the title, a diff, or the graph outline (model-written) carrying "draw a flow named …".                                                                                       | Instructions are the two literals; the title, diffs, outline and flows travel only as untrusted parts under fixed labels (`pr_title`, `graph`, `flows`, `file.N.path/diff`), delimited by the adapters (ADR 0013).                                                   | `pipeline.test.ts` H4-7 "injection-shaped PR text stays fenced", "the input is the graph call's …"; A1 over every call; `injection.test.ts` (the adversary now attacks the flows and walkthrough stages).   |
| A28 | **References outside the map or the mapped set**: a participant or focus id the model invented or took from an earlier run, a step backed by an excluded or non-PR file, a range outside the hunks; the UI would light up or link the wrong thing. | `stripFlowRefs` and `stripWalkthroughRefs` before the check and before storage; file references and ranges by the graph's rules; the integrity pass (BROKEN_REFERENCE, DUPLICATE_ID) on what remains; counts logged.                                                 | `validate.test.ts` (both strippers, `toWalkthrough`, `partitionIssues`); `pipeline.test.ts` H4-7 "unknown participants …", "unknown focus ids …", "a stripped flow still goes through the integrity check". |
| A29 | **A failed section fails the analysis or drops the map**, or a refusal costs more than one repair round.                                                                                                                                           | Each call is its own `completeWithRepair`; failure writes a fixed reason into provenance and stats; nothing else changes; ≤ 2 calls each.                                                                                                                            | `pipeline.test.ts` H4-7 "a flows call that is …" (refused, truncated, invalid, too large, timeout), "a walkthrough call that is …", "both calls failing …" (and a retryable error thrown).                  |
| A30 | **Prompt text leaks through the new sections** (a flow label, a step heading).                                                                                                                                                                     | Both instruction texts are in `PROMPT_TEXTS`; the guard runs on each answer against the call's own parts and on the stored graph whole; the sections are absent, not stored, when it trips.                                                                          | `pipeline.test.ts` H4-7 "the leak guard applies …"; `injection.test.ts` leak modes over the new stages (L1).                                                                                                |
| A31 | **A model writes the pipeline's reasons**, or a section next to its reason, or a reason without a map.                                                                                                                                             | `flowsUnavailable`/`walkthroughUnavailable` live in provenance (overwritten by `applyKnownFields`, which also drops the section); the document refines both pairings; fixed enum.                                                                                    | `v1-3.test.ts`, `known-fields.test.ts`, `property.test.ts` (generator and mutators).                                                                                                                        |
| A32 | **Unbounded spend**: the calls run with nothing to map, re-run forever, or carry the excluded files.                                                                                                                                               | No call without a drawn map; ≤ 2 calls each; output caps; the mapped set only, each call bounded by `GRAPH_MAX_INPUT_CHARS`; the same metering and cap wrappers; the estimate counts the mapped diffs once per graph-role call and the map's stages only with a map. | `pipeline.test.ts` H4-7 "neither call runs when …", call counts in every H4-7 case; `estimate.test.ts`; `plan`/`render` tests (CLI).                                                                        |
| A33 | **Content in logs** through the new stats.                                                                                                                                                                                                         | Stats carry counts and fixed codes only (`MapSectionStatus`, strip counts, `usageByStage` under redactor-safe names); `analysis-stats-log.test.ts`, the e2e log test and the injection check's L1 cover the stats object.                                            | `pipeline.test.ts` H4-7 "the token counts …" (integers and enum values); `analysis.e2e.test.ts` log checks; `check.ts` L1 over `stats`.                                                                     |
| A34 | **A schema the provider refuses** (H4-4's bug again) makes every analysis fail before a request.                                                                                                                                                   | Both answer schemas are projections with no recursion and no type-sided combinator; the wire-schema test runs the SDK transform and counts optional fields on every stage.                                                                                           | `wire-schema.test.ts` "the flows and walkthrough schemas compile on their own …".                                                                                                                           |
| A35 | **Output triggers a side effect** or is acted on.                                                                                                                                                                                                  | Unchanged: the pipeline has no forge handle, the port offers no tools, the sections are data in the stored document a human reads.                                                                                                                                   | A7 (`analysis.e2e.test.ts`), the port type test in `injection.test.ts`.                                                                                                                                     |

**Residual risks.**

- **R12:** the grammar-size limit on the two enforced schemas is the provider's and has no
  offline oracle (as R8); each is a fraction of the graph's grammar, which compiled on the real
  provider, but the evidence is the next real run. A rejection shows as `llm_invalid_request`.
- **R13:** the walkthrough is flat: no stage (a step cannot play over a flow), no lane focus, no
  message focus. The schema keeps those for a later call shape (`docs/progress.md`).
- **R14:** a flow or a step can still describe the code wrongly (a plausible but false order of
  checks). It is a draft for a human, like every model text (R2), and shown next to the diff.
- **R15:** the `payload` samples PR Lens draws are not asked for; a step says what moves in its
  label only.
- **R16:** two more calls on the graph role per analysed PR, each re-reading the mapped
  diffs: on the order of 12–30K input tokens per call (the mapped diffs plus the outline and
  the schema's cached system block) and 1–3K output tokens each, on top of H4-5's map call;
  a repair round doubles a call. The estimate and the per-PR limit count them (§5 above).

## Amendment (H4-8): the briefing is a short TL;DR

**Context.** Dogfooding: the briefing's `summary` was one paragraph of about 600 characters that
listed every scaffolding detail, and `verdict.reason` was a second paragraph. The reviewer asked
for a TL;DR of at most four sentences that is easier to scan than a paragraph.

**Decision.**

1. **The briefing call answers with `tldr`** (schema 1.4, `docs/schema/analysis-document.md`):
   two to four one-line bullets of at most 160 characters. `BriefingAnswer` (`outputs.ts`)
   requires it and no longer has `summary`; the AI briefing is stored without a summary.
   Rocky's fallback briefing (§2, ADR 0015 §6) keeps its fixed summary paragraph, so its
   document stays a 1.1 document.
2. **The verdict reason is one short sentence.** The answer schema holds it to
   `MAX_VERDICT_REASON_ANSWER_LENGTH` (200); the document keeps `MAX_REASON_LENGTH` (500) so
   two-sentence reasons in older documents still read. Rocky's own reasons (`RAISED_FOR_*`,
   `FALLBACK_REASON`) are written by the pipeline, not answered, and keep the document limit.
3. **`BRIEFING_INSTRUCTIONS`** ask for the first bullet to say what the PR does in plain words,
   the others for what matters most to the reviewer (the riskiest thing, the key finding by its
   id, where to start), no lists of files or tools, at most four sentences, paths and
   identifiers in backticks. The instructions stay a `rockyInstructions` literal in
   `PROMPT_TEXTS`; inputs are unchanged. The briefing is not a unit, so `PIPELINE_VERSION` is
   unchanged.
4. **Readers.** The web shows the verdict, then a "TL;DR" list; a document without a TL;DR shows
   the summary paragraph as before. The CLI prints a TL;DR block or the summary. The answer
   schema goes through the SDK transform in `wire-schema.test.ts` (no `$defs`, no combinator;
   the array and length limits move into descriptions as for every role).
5. **Rollout.** The briefing call always answers with a TL;DR, so almost every AI-briefed
   document is stamped 1.4; only Rocky's fallback briefing stays 1.1. A server or web build that
   only reads up to 1.3 refuses a 1.4 document (UNSUPPORTED_SCHEMA_VERSION), so the readers
   (server and web) must be deployed before the worker that writes 1.4.

**Threat model.** No new input or side effect: the TL;DR is model text like the summary it
replaces, validated as single-line text (no control, bidi or invisible characters, no newline, tab,
U+2028 or U+2029, so a bullet cannot fake a second line), checked by
the leak guard with the rest of the document (`pipeline.test.ts` H4-8, `injection.test.ts`'s
adversary now writes TL;DR bullets), rendered through `InlineText` in a `<bdi>`
(`Briefing.test.tsx` "untrusted model output") and through the CLI's gutter (`render.test.ts`).
A bullet can name a finding id that does not exist; it is a draft for a human (R2), and a check
is a follow-up in `docs/progress.md`.
