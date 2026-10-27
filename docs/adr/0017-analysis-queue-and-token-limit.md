# ADR 0017: The analysis queue lane, its lease and fairness, and the per-PR token limit

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P4-6
- **Builds on:** [ADR 0014](0014-analysis-pipeline.md) (`runAnalysis`, §7 storage, R3: the lease is
  a merge gate for the queue lane), [ADR 0009](0009-installation-lifecycle.md) (`rocky_worker`,
  `rocky_lifecycle`, the inbox claim with leases and `FOR UPDATE SKIP LOCKED`),
  [ADR 0010](0010-pull-request-mirror.md) (the mirror that records head revisions),
  [ADR 0003](0003-tenancy.md) (`withOrg`, RLS)

## Context

P4-3 built `runAnalysis`, the unit of work that turns one revision into one stored analysis, but
nothing ran it: nothing enqueued analyses and no lane claimed them. P4-6 adds that lane with two
limits:

- **A per-PR token limit.** A very large pull request must not be sent to models without someone
  deciding to pay for it. It waits for a person ("Analyze anyway").
- **An org concurrency cap.** One org with a backlog of 50 pull requests must not starve another
  org's first one.

ADR 0014 R3 makes a lease on `running` rows a merge gate for this change. Without one, a worker
crash, or a database error inside `runAnalysis`'s own failure path, leaves a row `running`
forever.

## Decision

### 1. Who enqueues

The mirror enqueues. When a `pull_request` inbox row (or the rebuild) records a head revision
whose diff it has just read, and the pull request is open, the same `withOrg` transaction queues
an analysis of that revision (`enqueueHeadAnalysis`). The inbox row is completed in that
transaction too, so a lost inbox lease rolls the enqueue back with the rest.

Each revision is queued at most once:

- a revision with any analysis is skipped;
- a diff GitHub could not give (`unavailable`) is not queued until a later reading repairs it;
- a partial unique index allows one live analysis per revision (`queued`, `running` or
  `awaiting_approval`). So the mirror, the rebuild and `enqueueAnalysis` can race without paying
  twice, and `enqueueAnalysis` is idempotent (it returns the live row).

Revisions mirrored before P4-6 are not analysed until their next push. A first rebuild never
queues a backlog of old pull requests.

### 2. The queue lives on `analyses`

Migration 0012 adds the queue columns to `analyses` rather than adding a queue table. The
analysis row already is the job record (state, failure code, tenant policy, retention,
cascades).

| Column             | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `attempts`         | Claims so far.                                                                              |
| `available_at`     | Not claimable before this time: the retry backoff.                                          |
| `claimed_at`       | The last claim.                                                                             |
| `lease_id`         | Held while `running`. A random uuid the claim hands out: only its holder can write the row. |
| `lease_until`      | When the lease runs out (database clock).                                                   |
| `estimated_tokens` | The token estimate when the row was held.                                                   |
| `limit_tokens`     | The limit it exceeded.                                                                      |
| `approved_tokens`  | "Analyze anyway" for this row: the estimate a person approved.                              |
| `approved_by`      | The member who approved it (composite FK to `members`, `ON DELETE SET NULL`).               |
| `approved_at`      | When it was approved.                                                                       |

- A new state, `awaiting_approval`, joins `queued`, `running`, `done` and `failed`.
- CHECKs tie the columns together:
  - a lease exists exactly while the row is `running`;
  - a held row has its estimate and its limit;
  - an approval is a size and a time.
- Names avoid `token` as a whole word, so the existing check that no secret-looking column holds
  text keeps passing: `lease_id` is a capability within the tenant, not a credential, and the
  counts end in `_tokens`.

### 3. The claim, the lease and the retries

`worker.claim_analyses(limit, lease_seconds, org_cap)` is a `SECURITY DEFINER` function, owned by
`rocky_lifecycle` and executable by `rocky_worker` only. The claim has to see every org's queue,
which RLS hides from `rocky_app`, so it runs as `rocky_lifecycle`.

`rocky_lifecycle` gets:

- `SELECT` on `analyses`;
- `UPDATE` on the queue columns only (`status`, `attempts`, `available_at`, `claimed_at`,
  `lease_id`, `lease_until`, `error_code`, `completed_at`). It can never touch a document, the
  units, an estimate or an approval;
- two policies scoped to itself.

The server's login cannot claim (insufficient privilege), and `checkServerLogin` is unchanged.

In one call, the claim:

1. **Locks.** It takes a transaction advisory lock, so claims never overlap and the per-org cap
   cannot race across workers. The caller bounds the wait with a 5 s statement timeout, as the
   inbox does.
2. **Reclaims expired leases.** A `running` row whose `lease_until` has passed goes back to
   `queued`, claimable now. After `ANALYSIS_MAX_ATTEMPTS` (5) claims it goes to `failed` with the
   code `lease_expired`. This is ADR 0014 R3: a crash, or a failure inside the error path, ends
   in a retry or a recorded failure, never a stuck row.
3. **Picks candidates fairly.** See §4.
4. **Leases each row.** It takes the candidate row with `FOR UPDATE SKIP LOCKED`: exactly that
   row, or nothing. It sets `running`, `attempts + 1`, a fresh `lease_id`, and `lease_until` =
   the claim time plus the lease (30 to 3600 s, default 600).

Everything after the claim runs under `withOrg(claim.orgId)` as `rocky_app`, and every write is
guarded by `status = 'running' and lease_id = $lease`:

- `loadAnalysisTarget` also requires a live lease;
- `completeAnalysis`, `failAnalysis`, `requeueAnalysis`, `holdAnalysis` and `renewAnalysisLease`
  return false when the lease is no longer held.

A run whose lease expired and was handed to another worker therefore writes nothing
(`lease_lost`).

The lane renews the lease every third of its length while a run lasts. A renewal that finds the
lease gone aborts the run through its `AbortSignal`.

**Retries.** A retryable error (an LLM outage, cancellation, a forge outage) requeues the row:

- the delay is `max(30 s × 2^(attempt − 1), the provider's hint)`;
- the backoff part stops at 1 h, and the total is capped at 6 h;
- the delay is enforced by `available_at`;
- on the fifth attempt the error's code is stored as the failure instead.

Stopping the worker aborts runs in progress, and they are requeued. A row claimed while the lane
is stopping is handed back at once.

### 4. Fairness

For each org with waiting rows, the claim takes:

- the org's oldest claimable rows, as many as its free slots (`org_cap − running`);
- excluding orgs being erased or scheduled for deletion.

Each candidate gets a **round**: the org's running count plus the row's rank within the org.
Rows are handed out by round, then by age.

- Every org's next row comes before any org's row after it. An org with nothing running goes
  before a busy one, whatever the ages.
- **The bound:** with `k` orgs waiting, an org's next analysis is among the next `k` rows handed
  out, whatever another org's backlog. With two orgs and `s` slots, each gets
  `min(cap, ⌊s/2⌋)` slots per round until one runs out.
- The per-org cap is global across workers. It counts `running` rows in the database. The lane
  sets it (`ROCKY_ANALYSIS_ORG_CONCURRENCY`, default 2); a worker's own slots are
  `ROCKY_ANALYSIS_CONCURRENCY` (default 4).

**Cost per claim.** Bounded by the orgs with work times the cap, never by the backlog:

- a skip scan over the partial index `analyses_queued_idx (org_id, available_at, created_at, id)
WHERE status = 'queued'` finds the orgs with waiting rows, one index probe per org;
- a lateral read takes each org's first rows from the same index;
- `analyses_running_org_idx` serves the cap, and `analyses_lease_until_idx` the reclaim.

### 5. The per-PR token limit and "Analyze anyway"

`estimateAnalysisTokens` (`packages/core/src/analysis/estimate.ts`) is a pure, deterministic
function of the diff and the previous analysis. It runs in `runAnalysis` after the diff is read
and before any model call. It counts:

- the patch characters of every file the pipeline would send, divided by 3 (conservative for
  code). Noise from rules pre-triage, binary and too-large files, and files whose unit the
  previous analysis covers (same path and unit key) are left out;
- a fixed overhead of 2 000 tokens per file call;
- a fixed overhead of 4 000 tokens for each of the 4 stages.

It is a size, not a bill: review and the change map read parts of the diff again. P4-5's usage
totals can be logged next to it through the `meter` seam (§8) to calibrate it.

When the estimate is above `max(limit, approved_tokens)`:

- the row goes to `awaiting_approval` with the estimate and the limit;
- the lease is released;
- nothing is sent to a model.

The limit is `ROCKY_ANALYSIS_TOKEN_LIMIT`, default 150 000. That is about 450 KB of code sent:
far beyond a reviewable pull request, and below a 200k-token one. A diff the pipeline refuses
anyway is not held: a truncated diff, one that does not parse, or one with no files. Those fail
without a model call.

**"Analyze anyway"** is `approveAnalysisOverLimit(tx, analysisId, { memberId })`, under `withOrg`.
It is the database half of the action P6/P7 will expose. In one transaction it:

- checks that the approver is a member of the org;
- moves the row from `awaiting_approval` to `queued`;
- sets `approved_tokens` to the estimate, with `approved_by`, `approved_at` and `attempts = 0`
  (the hold was not a failure);
- writes the audit event `analysis.limit_overridden`: actor = the member; target = the analysis;
  metadata = revision id, estimate and limit.

The approval covers this row only, so this revision only. A push is a new revision and a new row,
estimated again. It is held again unless enough of its files are unchanged.

**The seam for roles:** P7-2 must check the member's role (who may spend over the limit) before
calling this function. The function itself only requires membership.

### 6. Logging

Log lines carry only ids, counts and codes:

- `analysisId`, `attempt`, `code`, `retryAfterMs`;
- `estimate`, `tokenLimit`, `files`, `sent`;
- the lane's `started` and `inFlight`.

The estimate is logged under `estimate`, not `estimatedTokens`, because the logger's safety net
redacts unknown `*tokens` keys. Never titles, paths, diffs or model text.

### 7. Configuration

`ROCKY_ANALYSIS_TOKEN_LIMIT` (1 000 to 10 000 000), `ROCKY_ANALYSIS_CONCURRENCY` (1 to 32) and
`ROCKY_ANALYSIS_ORG_CONCURRENCY` (1 to 32) are validated at boot. A bad value stops the worker,
and the message names the variable, never the value. Per-org limits are a follow-up (C-5/P10).

### 8. Metering seam (P4-5)

`AnalysisRunnerDeps.meter?` wraps a run's roles and reports `{ inputTokens, outputTokens }`, which
`runAnalysis` logs next to the estimate. P4-5's metered roles and totals plug in here. This task
does not depend on P4-5's code.

## Threat model

| #   | What can go wrong                                                                   | Prevention                                                                                       | Test                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | A crash or a failure in the error path leaves a row `running` forever (ADR 0014 R3) | Lease with deadline; the claim reclaims expired leases; after 5 claims `failed`/`lease_expired`  | `analysis-queue.test.ts` "reclaims an expired lease…", "fails a row as lease_expired…"; `analysis-lane.e2e.test.ts` "a worker that dies mid-run…"                              |
| Q2  | Two workers run and write the same row (a slow worker after its lease expired)      | Every write matches the lease id; renewal aborts a run whose lease is gone                       | `analysis.e2e.test.ts` "a run whose lease expired and was handed to another worker writes nothing"; `analysis-lane.e2e.test.ts` "renews the lease … aborts the run…"           |
| Q3  | One org's backlog starves another                                                   | Per-org cap, global across workers (advisory lock); round-robin by round then age                | `analysis-queue.test.ts` "hands rows out round-robin…"; `analysis-lane.e2e.test.ts` load test (50 vs 3, three slot/cap settings)                                               |
| Q4  | Unbounded spend on a huge PR                                                        | Estimate before any model call; held as `awaiting_approval`; approval explicit, audited, one row | `analysis-lane.e2e.test.ts` "a 200k-token pull request waits for user action"; `analysis-queue.test.ts` "Analyze anyway…"                                                      |
| Q5  | Approval by someone outside the org, for another org's row, or twice                | `withOrg` + RLS; member check; only from `awaiting_approval`                                     | `analysis-queue.test.ts` "is refused for another org's row, a non-member, or a row that is not waiting"                                                                        |
| Q6  | The server (or a compromised server) claims across tenants or bypasses the cap      | The claim is `rocky_worker`-only; `rocky_lifecycle` updates only queue columns                   | `analysis-queue.test.ts` "only the worker login may claim"; `isolation.test.ts` (definer allow-list, lifecycle privileges, pinned column grants)                               |
| Q7  | Retry storms (an outage requeues everything at once, forever)                       | Exponential backoff honouring the provider hint, enforced by `available_at`; 5 attempts          | `analyses.test.ts` "a retryable failure puts the row back in the queue, after its delay…"; `analysis.e2e.test.ts` "retries are bounded…"                                       |
| Q8  | The same revision is analysed (and paid for) twice                                  | Partial unique index on live analyses per revision; the mirror enqueues a revision only once     | `analysis-queue.test.ts` "a held row … blocks a second analysis…", `enqueueHeadAnalysis`; `mirror.e2e.test.ts` "P4-6: a new head of an open pull request queues one analysis…" |
| Q9  | PR content in logs                                                                  | Ids, counts and codes only                                                                       | `analysis-lane.e2e.test.ts` (no title or path marker in the logs)                                                                                                              |

### Residual risks

- **R1:** the estimate can be beaten on purpose. A PR author can keep the estimate under the limit
  and still cost several times it, because review and graph re-read parts of the diff, and each
  file is capped at `MAX_FILE_PATCH_CHARS`. The limit bounds size, not spend exactly. P4-5's totals
  through the `meter` seam make the gap visible. A hard spend guard on actual usage is a follow-up.
- **R2:** reused units lower the estimate. A file whose unit is reused is not counted, but the
  pipeline may still re-analyse it, for example when reuse fails a check (a leak, changed facts).
  The overrun is bounded by the files that changed between two analyses of the same PR.
- **R3:** stopping costs attempts. A run aborted by a shutdown, or a run whose renewal failed
  during a database outage, uses one of its 5 attempts.
- **R4:** the claim reads the orgs with work. Fine at expected scale; a very large number of orgs
  with work would need sharding of the claim.

## Consequences

- The worker now analyses every new head revision of an open pull request automatically, within
  the token limit and the org cap.
- P6/P7 get the state they need to show "waiting for approval" and to offer "Analyze anyway".
- A migration (0012) touches `analyses` only. No new grants for `rocky_app`; one function and
  queue-column grants for `rocky_lifecycle`.
