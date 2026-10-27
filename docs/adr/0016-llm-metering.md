# ADR 0016: LLM metering and the versioned cost table

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P4-5
- **Builds on:** [ADR 0012](0012-llm-roles-and-provider-port.md) (the port, usage fields, the
  `provider` stamp), [ADR 0013](0013-llm-provider-adapters.md) (adapters, `attempts`),
  [ADR 0014](0014-analysis-pipeline.md) (§8: metering wraps the roles handed to the pipeline),
  [ADR 0003](0003-tenancy.md) and [ADR 0005](0005-migrations-and-roles.md) (tenancy, roles,
  retention)

## Context

Every model call costs money. Rocky must record, per tenant, what each call used and what it
costs at the provider's list price, so later tasks can bill (P11), cap a PR's spend (P4-6) and
reconcile against the provider. The record must be complete (failed calls, retries, repair
rounds, refusals and fallback attempts included), exact (it adds up to what the provider
reported), honest (no invented counts or prices) and free of tenant content.

## Decision

### 1. Where it sits

```text
apps/worker runAnalysis
  └─ meterRoles(configured roles, { sink, targets, analysisId })   packages/llm/src/metering.ts
       ├─ prices: PRICE_TABLES (versioned)                         packages/llm/src/prices.ts
       └─ sink.record(records) → withOrg(org) → recordLlmUsage     packages/db/src/usage.ts
  └─ analyzePullRequest(…, { llm: metered roles })                 unchanged
```

- `packages/core/src/metering.ts` holds the record type (`LlmUsageRecord`), its enums and the
  `LlmUsageSink` port. Core stays free of I/O.
- `meterRoles` wraps any `LlmRoles` (completions and embeddings). The pipeline cannot tell it is
  there, and `runAnalysis` never hands it the unwrapped roles. `AnalysisRunnerDeps.usageTargets`
  (from `usageTargetsFor(config)`) is required, and `runAnalysis` refuses to run without it.
- The only port change: `LlmCallError` may carry `partialUsage` (numbers only, a frozen copy of the
  five counts). The Claude adapter fills it from the stream's `message_start` and `message_delta`
  events when a stream fails part-way. Nothing else in `packages/core/src/analysis/*` or the
  adapters' prompt layout changes.

### 2. What is recorded

One row per attempt the provider reported:

- **A plain call** is one row with `result.usage`.
- **A server-side fallback chain** (`result.attempts`) is one row per attempt, each with its own
  model and usage, under one `call_id` and an increasing `attempt`. Attempts before the last are
  declines (`outcome = refused`); the last carries the result's status. The top-level `usage`
  equals the last attempt and is not added again. Tokens of different models are never summed
  into one row, because the provider bills each attempt at its own model's rates.
- **A failed call** is one row with `outcome = error` and the `error_kind`:
  - `usage_status = partial` with the counts the adapter saw, when the stream failed after it
    began;
  - otherwise `unreported`, with **null** token columns.
- **Retries and repair rounds** are ordinary calls and get their own rows. Two runs of the same
  analysis (a requeue) are two sets of rows.
- **SDK-internal HTTP retries** (a 5xx retried by the Anthropic SDK before an answer) report no
  usage and are not billed. They are invisible, as they should be.
- **Embeddings** are metered the same way, with `role = embed` and input tokens only.

**When usage is unknown, Rocky records that it is unknown.** Token columns are null and
`cost_status = no_usage`. A guessed zero would read as "free" to billing, and a guessed estimate
would be an invented number. Counts outside int4, or a non-integer, are treated the same way and
logged with the fixed code `llm_usage_out_of_range`.

**The adapters never turn missing or malformed usage into zero.** A result's `usage` is
`undefined` unless the provider sent a block Rocky can trust, and metering then writes
`unreported` / `no_usage`. The policy for a block that is only partly valid is
**all-or-nothing**:

- Input and output counts are required non-negative integers. If either is absent, null,
  negative, fractional or not a number, the whole block is discarded.
- Cache counts are optional. Absent or null means no cache use (0), because providers omit them
  when nothing was cached. Any other value that is not a count discards the whole block.
- On an OpenAI-compatible endpoint, `cached_tokens` larger than `prompt_tokens` discards the block,
  since the two are inconsistent.
- Embeddings need a valid `prompt_tokens`, or they record no usage.

A block is never half-trusted. Keeping its "good" fields would yield a row that looks reported
with numbers Rocky knows are wrong.

| Column                                   | Meaning                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `org_id`, `analysis_id`                  | tenant (FORCE RLS) and the analysis the call served (nulled when the analysis is purged)              |
| `call_id`, `attempt`                     | one per role call; position in a fallback chain (unique per org: idempotent writes)                   |
| `role`, `provider`, `model`              | role; provider kind as the registry stamped it; canonical model id that ran the attempt               |
| `outcome`, `error_kind`                  | `ok`, `refused`, `truncated`, `invalid_output`, `error` (+ the `LlmErrorKind`)                        |
| `usage_status`                           | `reported`, `partial`, `unreported`                                                                   |
| `input_tokens` … `cache_write_1h_tokens` | the five provider counts (cache writes split 5 minutes / 1 hour); all null or all set                 |
| `cost_micro_usd`, `cost_status`          | integer µUSD at list price when `priced`; else null with `no_price`, `billing_unverified`, `no_usage` |
| `price_version`                          | the cost table version consulted (`none` if none was in effect)                                       |
| `created_at`                             | database clock (trigger)                                                                              |

### 3. Cost at list price

- **Integer micro-USD, no floats.** Rates are written as exact decimal strings and parsed to µUSD
  per million tokens (`usd("0.125")` = 125 000). A row's cost is
  `Σ tokens × rate / 1 000 000`, summed exactly as a bigint and rounded half up once per row, so
  it is at most 0.5 µUSD off.
- **Cache reads and writes** are priced separately, with 5-minute and 1-hour writes at their own
  rates.
- **The long-context tier (Claude Haiku 5.5):** a prompt over 100 000 tokens pays the higher card
  for the whole request. The prompt is input plus cache reads plus cache writes ("Long context
  pricing" on the pricing page). Every other catalogued model has one card across its window.
- **Versioned and immutable.** `PRICE_TABLES` lists published versions, oldest first, each with
  an effective date. The call is priced by the version in effect at the call's clock, and the row
  stores that version. Published versions are deep-frozen, and `prices.test.ts` pins each one by a
  sha256 of its canonical JSON. Editing a published price fails CI; a change is a new version.
- **Sources** (read 2026-10-27; each verified platform entry records its URL and date):
  - **Claude API:** the full catalogue, from `platform.claude.com/docs/en/about-claude/pricing`.
  - **Microsoft Foundry:** Claude API rates, which the same page states Foundry uses.
  - **Bedrock and Vertex AI:** partner-priced. Their pages gave no per-model Claude rates when
    read, and regional endpoints add a premium. They are **explicit unverified placeholders**:
    rows on them record tokens with `no_price` (needs-human).
  - **OpenAI-compatible:** a local server has no list price, so `no_price`.
- **Unknown model:** tokens are recorded, the cost is null, and `cost_status = no_price`. The
  model id is never mapped to a "similar" model.
- **Refusal billing** ("How refusals are billed", refusals-and-fallback page, read 2026-10-27):
  - A mid-stream refusal, and any attempt that produced output, bills at normal rates, so it is
    priced.
  - A refusal **before any output** is billed only in some categories (`bio`, `frontier_llm`,
    `reasoning_extraction` as of September 2026). Rocky does not carry the category, so such a
    row records its tokens with `billing_unverified` and no cost.
  - The fallback attempt bills at the fallback model's rates. The provider applies credit-style
    cache repricing in the counts it reports per attempt (`usage.iterations` is "the per-attempt
    record of what you're billed"), so pricing the reported counts is the billed amount.
- **Partial usage of a failed call** has no published billing rule, so it records its tokens with
  `billing_unverified` and no cost.

### 4. When the write happens, and when it fails

The write is **synchronous and in its own short tenant transaction, per call**. `complete()`
awaits the provider, then awaits `withOrg(org, recordLlmUsage)`, and only then returns the result
(or rethrows the call's error). The alternatives were rejected:

- **Inside the analysis transaction:** a run spans minutes of model calls, so this would hold a
  transaction open for the whole run, and a failed or requeued analysis would roll back the usage
  of calls that were really made and billed.
- **Buffered and flushed at the end:** a crash would lose the usage.

A write that fails is retried (three tries, 100 ms and 200 ms apart). Each record carries a
`call_id` and `attempt`, `UNIQUE (org_id, call_id, attempt)` holds them, and the insert is
`ON CONFLICT DO NOTHING`, so a retry after a commit whose acknowledgement was lost stores nothing
twice. If every try fails:

1. Each record is logged at error level as ids, enums and numbers (`errorCode:
llm_usage_unrecorded`, the SQLSTATE, the five counts, the cost, the price version). The log is
   the durable fallback, so the usage is not silently lost.
2. The call fails with `LlmMeteringError`, replacing the call's own error so it cannot be
   swallowed.
3. The wrapper is marked failed. **Every later call through it is refused before it reaches a
   provider**, so there is no unmetered spend.
4. `runAnalysis` stores `metering_failed`, with no document. It does not retry automatically:
   a persistent ledger fault must not turn into a loop that keeps spending. In-flight sibling calls
   finish, and their writes are tried (and logged if they fail).

### 5. Tenancy, roles and lifecycle (migration 0011)

- **Tenancy:** `llm_usage` keeps its 0003 tenant policy (FORCE RLS, `org_id = current tenant` on
  read and write) and its cascading FK to `orgs`. The writer runs inside `withOrg`; `org_id`
  defaults to the transaction's tenant.
- **Grants:**
  - `rocky_worker`: INSERT (it makes the calls).
  - `rocky_app`: SELECT only (usage display and limits later).
  - Nobody: UPDATE or DELETE.
  - `rocky_retention`: SELECT and DELETE, with `USING (true)` policies, for its two functions.
- **Append-only** (the audit-log pattern, 0004):
  - A trigger refuses UPDATE, DELETE and TRUNCATE for every role, the owner included.
  - It makes two exceptions.
    - DELETE as `rocky_retention` is allowed only when the session's login (`session_user`) is not
      the table owner or one of its members. Inside the two SECURITY DEFINER functions, the login
      is the server (the purge) or the worker (the erasure). The owner can `SET ROLE
rocky_retention`, since it is a member of that role in order to hand functions over to it.
      Its session is still the owner's, though, so its DELETE is refused.
    - The update the analyses FK makes when an analysis is purged (`analysis_id → NULL` and nothing
      else) is allowed, because usage outlives its analysis for billing.
  - The owner can still drop or disable the trigger, as owners can for every table. That is
    schema change, made by a reviewed migration; it is not a data path.
  - `created_at` is stamped by the database.
- **CHECKs mirror the record rules**, so a writer that skips `recordLlmUsage` still cannot store a
  bad row:
  - enums, plus shapes for provider, model and price version;
  - attempt range;
  - all-or-none token counts;
  - cost present exactly when `priced`, and `priced` only against a price table (`price_version
<> 'none'`);
  - `no_usage` exactly when `unreported`;
  - partial only on errors.
- **Retention:** category `llm_usage`, default 730 days, with a CHECK floor of 400 days
  (`RETENTION_LLM_USAGE_DAYS`). `retention.purge_llm_usage` follows the 0005 contract: its period
  comes from settings, `as_of` is clamped to the past, and the purge is audited per org.
- **Erasure:** `retention.delete_org` deletes the org's usage rows as `rocky_retention` right
  after its audit events (an FK cascade would run as the owner, which the trigger refuses). The
  count goes in `app.org_deletions.llm_usage_deleted`. Because the ledger goes with the org, the
  tombstone keeps `llm_usage_totals`: one entry per `price_version` with the row count, the five
  token sums, the priced µUSD, the number of unpriced rows and the number of unreported rows.
  Billing for an erased org's last period reconciles from those totals (P11). They hold numbers
  and price-version ids only.
- **Migration 0011 and FORCE RLS:** the migrator is a non-superuser owner, and FORCE RLS hides
  every row from it.
  - The up lifts FORCE, inside its transaction, around the `call_id` backfill so that the backfill
    sees existing rows.
  - The down lifts FORCE for its whole transaction and restores it at the end. While any row has no
    reported tokens or no list price, it refuses with `object_not_in_prerequisite_state`, because
    the 0002 shape cannot hold such rows and deleting them would destroy billing evidence. The
    down folds 1-hour cache writes into the single 0002 cache-write column (5m + 1h).

### 6. Seams for later tasks

- **P4-6 (per-PR token limit):** `MeteredRoles.totals()` gives running counts and cost for the
  run, and `llm_usage` is indexed on `(org_id, analysis_id)` for a per-PR sum across runs.
- **P11 (billing):** bill from `priced` rows by `price_version`. Rows without a price stay visible
  (`no_price`, `billing_unverified`, `no_usage`) and need a policy decision rather than a silent
  zero. `call_id` and `attempt` give reconciliation an idempotent key.
- **Prices:** `PRICE_TABLES` is exported from `@rocky-reviews/llm`, so any later cost estimate reads
  the same versioned list prices as metering.

## Threat model

**Assets:**

- the completeness and correctness of usage (billing and limits depend on it);
- tenant isolation of usage;
- tenant content (code, diffs, prompts, model output), which must never reach usage rows or logs;
- the integrity of the price table.

**Attackers:**

- a PR author steering a model (output size, refusals, hostile text);
- a hostile or broken provider endpoint (forged counts or model ids);
- another tenant;
- a compromised server credential;
- an insider with database access trying to rewrite history;
- a developer changing a published price.

| #   | What can go wrong                                                                                                      | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | A call is not recorded (failed, retried, repaired, refused, fallback attempt, cancelled sibling)                       | The wrapper records on both the result and the error path, one row per reported attempt; it is the only roles object the pipeline gets; `usageTargets` is required                                                                                                                                                                                                                                                                                                     | `metering.test.ts` "over a multi-call analysis…", "records every call of a repair loop and of retried runs…", "records a failed call…"; `analysis.e2e.test.ts` "every call writes llm_usage rows whose sum equals the provider-reported usage…", "refuses to run without usage targets"                                                                                                                                                                                                                                                                                                                                           |
| M2  | Usage is double-counted (fallback `usage` and `attempts` summed; a retried write stored twice)                         | `attempts` replaces `usage` when present; `UNIQUE (org_id, call_id, attempt)` with `ON CONFLICT DO NOTHING`                                                                                                                                                                                                                                                                                                                                                            | `metering.test.ts` "over a multi-call analysis…" (14 rows for 13 calls, sums equal); `usage.test.ts` "stores a retried write once…"; `metering.test.ts` "is retried; the call's result is handed on only once its usage is stored"                                                                                                                                                                                                                                                                                                                                                                                                |
| M3  | A metering failure silently loses usage, or the run keeps spending unmetered                                           | Retried writes; then an error log of the records (numbers only); `LlmMeteringError`; the wrapper refuses every later call; the analysis fails `metering_failed` and is not auto-retried                                                                                                                                                                                                                                                                                | `metering.test.ts` "is never silent…", "replaces the call's own error…"; `analysis.e2e.test.ts` "a usage write that fails stops the run…" (grant revoked mid-test: no row, error logs, no further model call)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M4  | An invented number: a zero for unknown or malformed usage, a guessed price for an unknown model or unverified platform | Adapters return no usage (never zeros) for a missing or malformed block, all-or-nothing (§2); null tokens with `unreported`/`no_usage`; `no_price` for anything without a verified entry; `billing_unverified` where billing depends on what Rocky cannot see; DB CHECKs enforce all-or-none counts, cost only when priced, priced only against a price table                                                                                                          | `claude.contract.test.ts` "reports no usage, never a zero, when the usage block is missing or malformed…"; `openai-compatible.contract.test.ts` "reports no usage for a malformed usage block…", "returns no usage when the server sends none"; `metering.test.ts` "records a result whose provider reported no (valid) usage as unreported…", "records tokens with no price for an unknown model or an unverified platform…", "records no price when no price table is in effect"; `usage.test.ts` "enforces the record's invariants in the database too…"; `prices.test.ts` "covers the default role models on every platform…" |
| M5  | Wrong cost (floats, rounding drift, wrong cache rate, wrong tier)                                                      | Exact decimal strings → bigint µUSD, one half-up rounding per row; separate 5m/1h write and read rates; Haiku 5.5 long-context rule counts cached tokens                                                                                                                                                                                                                                                                                                               | `prices.test.ts` "prices each kind of token at its own rate…", "puts a Haiku 5.5 prompt over 100 000 tokens… on the long-context card", "sums exactly and rounds half up once per row", "uses the published rates of the default models"                                                                                                                                                                                                                                                                                                                                                                                          |
| M6  | A published price is edited after rows were priced with it                                                             | Versions are append-only and deep-frozen; each published version is pinned by sha256 in a test; rows store `price_version`                                                                                                                                                                                                                                                                                                                                             | `prices.test.ts` "pins every published version by digest…", "is frozen at runtime…", "is versioned…"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| M7  | Cross-tenant read or write of usage                                                                                    | FORCE RLS tenant policy; writes inside `withOrg`; composite FK to `analyses`; `org_id` defaults to the tenant                                                                                                                                                                                                                                                                                                                                                          | `usage.test.ts` "lets the server read its own tenant's rows and nobody else's", "refuses a worker insert for another tenant (RLS WITH CHECK)"; `isolation.test.ts` (every table, incl. `llm_usage`)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M8  | Usage rows are rewritten or deleted to hide spend (compromised server, worker or an owner session)                     | No UPDATE/DELETE grants for app or worker; the server cannot even insert; append-only trigger for every role incl. the owner; DB-clock `created_at`; only `rocky_retention` deletes, and only when the login is not the owner (so the owner's `SET ROLE rocky_retention` is refused): in practice only `purge_llm_usage` (period-bounded) and `delete_org` (totals kept in the tombstone). An owner can still drop or disable the trigger (schema change, residual R6) | `usage.test.ts` "is append-only for the server, the worker and the owner", "refuses the owner's delete as rocky_retention…", "stamps created_at with the database clock…", "keeps only the SQLSTATE… (the server login cannot insert)"; `isolation.test.ts` privilege matrix; `audit.test.ts` retention-role grants                                                                                                                                                                                                                                                                                                               |
| M9  | Tenant content in usage rows or logs (prompt, code, diff, model output, driver text)                                   | Records are ids, enums and numbers; model and provider shape-checked (else `unrecognised`); the store rejects bad records with fixed messages and keeps only SQLSTATE from driver errors; log fields chosen so the scrubber keeps them and nothing else is logged                                                                                                                                                                                                      | `metering.test.ts` "holds ids, enums and numbers only…", "does not trust a hostile model id or token counts"; `usage.test.ts` "refuses a malformed record before any SQL…"; `analysis.e2e.test.ts` (no title, path or code in logs); `llm.test.ts` "carries partial usage as a frozen copy of the five counts only"                                                                                                                                                                                                                                                                                                               |
| M10 | A hostile endpoint reports absurd or malformed counts to overflow columns, break the write or read as free             | Adapters discard a block with any negative, fractional, non-numeric or missing required count (no usage, so `unreported`); counts outside int4 become `unreported` with a fixed log code; cost math is bigint                                                                                                                                                                                                                                                          | `metering.test.ts` "does not trust a hostile model id or token counts"; the adapter contract tests named under M4; `prices.test.ts` "sums exactly…" (int4 maximum at the highest rate)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| M11 | Usage is lost with its analysis, kept after erasure, kept forever, or lost by a migration revert                       | FK `ON DELETE SET NULL (analysis_id)` allowed by the trigger; `purge_llm_usage` (730 days, floor 400) audited; `delete_org` deletes usage and records the count and per-price-version totals; the 0011 down refuses while unrepresentable rows exist and folds 1h cache writes                                                                                                                                                                                         | `usage.test.ts` "keeps usage when its analysis is purged…", "purges rows past the llm_usage period…", "cannot be pushed forward…", "erases an org's usage with the org…" (totals equal the erased rows' sums), "refuses to go down while rows the 0010 shape cannot hold exist…"; `deletion.test.ts` "deletes every row of a due org from every tenant table…"; `migrate.test.ts` (down restores 0007's function exactly)                                                                                                                                                                                                         |
| M12 | Partial usage of a failed stream is dropped                                                                            | The Claude adapter accumulates `message_start`/`message_delta` usage and attaches it to the thrown `LlmCallError`, including when reading a finished stream's answer fails                                                                                                                                                                                                                                                                                             | `claude.contract.test.ts` "keeps the usage a stream reported before it failed, for metering (P4-5)", "merges message_delta usage into what a failed stream reports…", "keeps a finished stream's usage when reading the answer fails afterwards…" (every Claude platform)                                                                                                                                                                                                                                                                                                                                                         |

### Residual risks

- **R1: unpriced rows.** Bedrock and Vertex rows, pre-output refusals and partial usage carry no
  cost until a human verifies the prices (Bedrock, Vertex) or the adapter carries the refusal
  category. They are visible, not hidden, and billing must choose a policy for them.
- **R2: the log as a fallback.** If the database is down for longer than the write retries, the
  usage exists only in the error log until someone replays it. The run stops, which bounds the
  gap to the calls already in flight. A replay tool is a follow-up.
- **R3: data residency and endpoint premiums are not modelled.** Foundry US Data Zone deployments
  (1.1x) and the regional premiums on partner platforms are not modelled. Rocky sends no
  `inference_geo` and cannot see a Foundry deployment type. If an operator uses one, list price
  under-states cost by 10%.
- **R4: list price is not the bill.** Negotiated discounts, credits and fallback-credit
  redemptions that Rocky does not perform are out of scope. Reconciliation against the provider's
  invoices is P11.
- **R5: identity ids.** `llm_usage.id` is a global sequence, so a tenant reading its own rows can
  infer global call volume (as already noted for `audit_events` in `packages/db/THREATS.md`).
- **R6: the owner is trusted with the schema.** The table owner cannot delete usage rows through
  any data path, but it can drop or disable the trigger, as for every table. Migrations are
  reviewed. `audit_events` (0004) has the same `SET ROLE rocky_retention` gap, which is a
  follow-up in `docs/progress.md`.

## Consequences

- Every call costs one extra short transaction. That is milliseconds against calls that take
  seconds.
- A price change is a code change: append a version, pin its digest, cite the source and date.
- A new model needs a price entry, or it records `no_price` until it gets one.
