# ADR 0014: The analysis pipeline

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P4-3
- **Revised:** review round 2: files with no hunks stay triaged (SF1); unanalysed files of unknown
  risk floor the verdict at medium, also at the write (SF2); fixed reasons for a raised verdict;
  every `@rocky-reviews/*/testing` subpath banned from production code, dynamic imports included.
- **Revised:** review round 1 (Fixes A to G): verdict floor for files that were not reviewed;
  deletion-only risky files marked unanalysed; quoted rename and copy paths; header consistency
  in the diff reader; raw review minutes in file units; the scripted fake banned from production
  code; the lease as a merge gate for the queue lane.
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
- `apps/worker/src/analysis.ts`: `runAnalysis(deps, orgId, analysisId)` claims a queued row,
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
| briefing | review   | `pr_title`, `triage`, `findings`, `noise`, `unanalysed` (JSON) | `summary`, `verdict`, `reviewPath`, `checkedOk`               | analysis `briefing_failed`              |
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
  document can express it. `belowUnanalysedFloor` runs in the pipeline's final check (defence in
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
  for a retryable failure.
- **A row can stay `running`:** after a worker crash, or when `failAnalysis` or `requeueAnalysis`
  itself throws inside `runAnalysis`'s error path (a database outage). Nothing reclaims it today.
  **A lease that reclaims expired `running` rows is a merge gate for the change that wires
  `runAnalysis` into a queue lane** (R3). It is not built here because nothing enqueues analyses
  yet.
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
- **Queue:** `runAnalysis` is the unit of work for a queue lane. The lane (enqueue on a new
  revision, claim with a lease, retry with `retryAfterMs`, org concurrency cap) is a follow-up
  with P4-6, so nothing enqueues analyses yet.
- **Metering (P4-5)** wraps the `LlmRoles` handed to the pipeline. Every call goes through it,
  and results carry `provider`, `model`, `usage` and `attempts`.
- **Token limits (P4-6)** plug in before `analyzePullRequest`, and at its per-file
  `too-large` and graph-size checks.

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
  That is a draft for a human, never an action. P4-4 adds the injection corpus and the verdict
  invariants.
- **R3:** a crash between claim and finish, or a database error inside `runAnalysis`'s own
  failure path, leaves a row `running`. The lease is a **merge gate** for the change that wires
  `runAnalysis` into a queue lane (§7).
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
