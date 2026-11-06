# ADR 0038: Project memory decay, one org at a time

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-06
- **Task:** P8-4
- **Amends:** [ADR 0036](0036-project-memory-entries.md) (§4, the seam it left for P8-4; one
  column, `decayed_at`), [ADR 0005](0005-migrations-and-roles.md) (§5, three more periods in
  `app.retention_settings`), [ADR 0009](0009-installation-lifecycle.md) (one more worker
  function, `worker.live_orgs`)
- **Builds on:** [ADR 0003](0003-tenancy.md) (RLS, `withOrg`), [ADR 0037](0037-learning-and-applying-project-memory.md)
  (what learned entries are, `last_used_at` as "a review cited it", the learned supersede path)

## Context

Learned memory grows with every posted review and never shrinks: P8-2 writes up to 25 entries
per review, supersedes older ones but keeps them as history, and the only ceiling is the
per-repository cap of 5 000 (ADR 0036: "a ceiling, not a budget"). Two of its effects get worse
with age. A learned **dismissal** keeps findings out of later reviews near where it was taken,
on the strength of one reviewer's decision about one PR; the longer no review cites it, the less
it is worth that trust. Every current entry also costs prompt tokens and, through the unit key,
re-reviews when it appears or goes. The plan's acceptance criterion for P8-4 is tenancy: the RLS
isolation suite extended to memory and embeddings. There are no memory embeddings yet (P9-1
settles the dimension and index; `embeddings` holds fixture rows only), so the suite covers the
table's rows and the cascade from entries.

Every retention job so far (ADR 0005 §5, 0007, 0011) purges across tenants through a SECURITY
DEFINER function owned by `rocky_retention`. ADR 0036 §4 asked P8-4 for the opposite: run per
org inside `withOrg`, never cross-tenant SQL. This ADR follows that.

## Decision

### 1. Shape: a worker job, per org, inside `withOrg` (migration 0019)

`runMemoryDecay` (`packages/db/src/memory-decay.ts`) runs on the worker's timer like retention
(`memory_decay`, every 6 hours, no GitHub read, no app credentials). It reads the windows from
`app.retention_settings`, lists the orgs to visit through `worker.live_orgs` (a SECURITY DEFINER
function owned by `rocky_lifecycle`, callable by the worker role only: **ids only**, in id
order, paged by the last id, orgs being erased or scheduled for deletion left out), and runs
`decayOrgMemory` for each org **in that org's own `withOrg` transaction**. RLS on
`memory_entries` and `embeddings` bounds every statement; the explicit `org_id = $1` filters are
defence in depth. One org's failure is recorded by error code and the others still run. The
application login cannot list orgs, so a server bug cannot run the job (fail closed).

### 2. The rules (learned entries only)

The job never touches a **member-written** entry: not its confidence, not as a current entry,
not as history. A person wrote it; P8-3 is where people edit and delete. Three rules, in this
order per org, as of the injected clock clamped once to the database clock
(`least(as_of, now())`, the instant every rule and the audit row use). Each rule **locks its
candidates first and never waits** (`SELECT … FOR UPDATE SKIP LOCKED` with the rule's
predicate, which READ COMMITTED re-evaluates on the newest row version, so an entry cited or
superseded by a transaction that committed meanwhile drops out, and one a transaction still
holds is left for the next run) and then acts on exactly those ids with a fresh snapshot. The
chain behind a retiring head is locked the same way, and a chain with a row held elsewhere is
skipped whole. A concurrent supersede or citation that chooses to wait on a row the job holds
finds it gone or already stepped once the job commits. The job therefore never waits on a
`memory_entries` row, which is what keeps it out of a deadlock with the analysis commit
(`touchMemoryEntries`, whose ids are sorted since this round) or the learner: a deadlock victim
there could be a finished, paid-for review. Each rule takes at most 10 000 candidates per org
per run (`MAX_MEMORY_DECAY_BATCH`;
for retirement these are the chain heads, and the learned history behind them goes with them
whatever its size; the next run continues):

1. **History (180 days, `memory_superseded`).** A superseded learned entry is deleted 180 days
   after it was superseded (`updated_at`, which only the supersede stamps), **tail first**: never
   while another entry still points at it, so the self-referencing `ON DELETE SET NULL` never
   fires and no entry becomes current again. A learned tail behind a member-written entry goes
   like any other learned history; the member-written entry stays, however old.
2. **Retire (365 days, `memory_unused`).** A current learned entry that no review has cited for
   a year (since `last_used_at`, or `created_at` if never cited) is deleted together with the
   learned entries it superseded (the chain behind it; the `ON DELETE SET NULL` would otherwise
   make the previous decision current again) and, by cascade, its embeddings. A chain with a
   member-written entry anywhere in it is kept whole. Entries point at one successor each, so the
   entries that lead to a current head form a tree and the recursive walk ends; a loop a crafted
   update could plant (ADR 0036 nit 6) has no path to a head and is never reached (`UNION`
   rather than `UNION ALL` is belt and braces).
3. **Decay (90 days, `memory_decay`).** A current learned entry idle for 90 days since its last
   citation, its creation or its last decay step, whichever is latest, loses 10 confidence
   points (`MEMORY_DECAY_STEP`), down to 0, and records the step in `decayed_at`. One step per
   idle period, so a run at the same instant changes nothing; a citation restarts the clock.

**Boundary:** an entry is idle iff its idle instant is strictly older than `as_of - window`
(the retention rule); one exactly `window` old is kept.

Why these and not others:

- **Dismissals decay like conventions.** Decaying a dismissal is safety-positive (it stops
  hiding findings); decaying a convention only saves tokens. One rule for both is simpler and
  the ADR 0037 role rule is unaffected (an owner's dismissal, uncited for a year, is retired too:
  time, not rank, is what expires it).
- **Confidence is a signal, not a gate.** Nothing in the pipeline gates suppression on
  confidence (`coversSeverity` compares severities); confidence orders entries when more than 12
  compete for a file and is shown to people (P8-3). Decay makes a fading entry visible before
  it is retired; with the defaults an uncited entry shows four steps (80 → 40, at 90, 180, 270
  and 360 days) before it goes at 365. Retirement is the control. An entry a review cites
  every few months never decays, and a frequently applied dismissal keeps suppressing for as
  long as it keeps being applied: time without use is the only input, and superseding it
  (P8-2's newer decision, P8-3's edit or delete) is the bound on an entry that keeps firing.
- **"Cited" means a review relied on it.** `last_used_at` moves only when a stored document
  cites the entry or applied it as a suppression (ADR 0037 §4), never when it was merely offered
  or when a restored finding carried it. An entry in a directory nobody reviews for a year is
  stale by that measure; GitHub still holds the review it came from.
- **Deletion is permanent.** Learned entries are derived data (a finding title and a
  reviewer's decision, re-learnable from a later post). Nothing is kept in a tombstone; the audit
  row holds counts. The alternative, a `retired_at` flag that hides instead of deleting, was not
  adopted: it would add a third state next to `superseded_by` and P8-3's coming "disabled"
  switch, and it would keep the rows the per-repository cap counts.
- **Evidence, repository and org are not checked.** The repository and the org cascade through
  foreign keys (`repos`, `orgs`; tested in P8-1 and `deletion.test.ts`); the evidence is a path,
  a sha and a PR number by design, not a foreign key (ADR 0036), and whether the lines still
  exist cannot be known without GitHub. "Cleaning entries whose evidence is gone" is therefore
  not a rule here.
- **Retiring an entry retires its rank too.** ADR 0037 §3 keeps a lower role from overturning a
  higher role's learned decision while that decision is current. Once it is retired for a year
  without a citation, a member's opposite decision about the pattern can be learned again. That
  is intended: the protection guards a decision in use, not one nobody relied on for a year.

### 3. Configuration

Three more rows in `app.retention_settings` (`memory_decay` 90, `memory_unused` 365,
`memory_superseded` 180), set like the others from the environment by `pnpm db:migrate`
(`RETENTION_MEMORY_DECAY_DAYS`, `RETENTION_MEMORY_UNUSED_DAYS`,
`RETENTION_MEMORY_SUPERSEDED_DAYS`). CHECK floors: `memory_unused` ≥ 30 days (a one-day window
would erase every repository's learned memory on the first run), `memory_superseded` ≥ 7,
`memory_decay` ≥ 1. The application role reads the table and cannot write it, and the job
clamps `as_of` to the database clock, so a compromised application credential can only move
the cutoffs into the past, as with every purge (THREATS T13).

### 4. What P8-3 should know

- A per-repository **disabled** switch, if P8-3 stores one, is not known to this job: a disabled
  entry is never cited, so it will be retired a year after its last citation like any other
  learned entry. If disabled entries should be kept (or removed sooner), the rules need the flag.
- `decayed_at` is not exposed through `MemoryEntry`; P8-3 can read it to show "fading since …".
- An admin who supersedes a learned entry with a member-written one protects the chain from
  retirement (the member-written entry is current); the learned history behind it still ages out.

## Threat model

**Assets:** tenant memory entries and their embeddings (prompt input; dismissals suppress
findings); what people wrote; tenant boundaries; the audit trail; the pipeline's availability.
**Attackers:** another tenant, through the job or a bug in it; a compromised application
credential using the job as a wiper or a cross-tenant reader; an operator misconfiguring the
windows; a crafted `superseded_by` loop; PR content already stored as entries steering what is
deleted (it cannot: the rules read timestamps and origins only).

| #   | What can go wrong                                                                                                                                                                                                                                                                                                | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The job reads, decays or deletes another org's entries or embeddings                                                                                                                                                                                                                                             | Per-org `withOrg` (RLS on both tables, FORCE), explicit `org_id` filters, composite FKs; the org list is ids only, worker-only                                                                                                                                                                                                                                                                                                                                                                                                                           | `isolation.test.ts` "memory decay (P8-4)": the job run as A changes nothing of B's planted idle chain, history and embedding; crafted `or true` deletes and decays reach A's rows only; B's own run retires B's chain and A keeps its rows; `worker.live_orgs` refused for the app login, one column; every per-table check already covers both tables                                                                                                        |
| D2  | Permanent deletion of what a person wrote                                                                                                                                                                                                                                                                        | `origin = 'learned'` in every rule; a chain with a member-written entry anywhere is kept whole; member history is never purged                                                                                                                                                                                                                                                                                                                                                                                                                           | `memory-decay.test.ts` "lowers … and nothing else" (member entries untouched), "keeps a chain whole when a member-written entry is anywhere in it", "never removes a superseded member-written entry, however old"                                                                                                                                                                                                                                            |
| D3  | Deleting a chain head or a history row makes an older entry current again (`ON DELETE SET NULL`)                                                                                                                                                                                                                 | Retire deletes the whole learned chain; history is purged tail first (never a referenced row)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | "deletes the head, the learned entries it superseded and their embeddings", "removes the unreferenced tail first, then the next one on a later run" (the current entry stays current)                                                                                                                                                                                                                                                                         |
| D4  | A crafted `superseded_by` loop hangs or confuses the recursive walk                                                                                                                                                                                                                                              | Loops have no path to a current head; `UNION` ends recursion on a repeat anyway; the history rule never deletes a referenced row                                                                                                                                                                                                                                                                                                                                                                                                                         | "neither hangs on nor deletes a crafted superseded_by loop"                                                                                                                                                                                                                                                                                                                                                                                                   |
| D5  | The job becomes a wiper: a compromised credential, a bad setting or a direct caller of `decayOrgMemory` moves the cutoffs towards now                                                                                                                                                                            | Windows in the migrator-owned settings table with CHECK floors (`memory_unused` ≥ 30, `memory_superseded` ≥ 7, `memory_decay` ≥ 1 days), read-only for the app; **`checkWindows` repeats the same floors (`MEMORY_DECAY_MIN_DAYS`) for every caller of `decayOrgMemory` and `runMemoryDecay`**, so a window the table would refuse is refused before any SQL; `retentionFromEnv` refuses values under the floors; `as_of` is clamped to `now()` once and the clamped instant is what every rule and the audit row use                                    | `memory-decay.test.ts` "refuses windows under the settings table's floors…" (29, 6 and 0 days refused; the floor itself accepted and a 29-day-old entry kept), "cannot be pushed forward…" (the audit row holds the clamped instant); `retention.test.ts` "rejects memory windows under their floors", "the database itself holds the memory windows' floors"; `memory-decay.run.test.ts` "refuses settings one day under each floor before visiting any org" |
| D10 | A concurrent supersede makes a retiring head the successor of a member-written entry, so deleting the head revives that entry (`ON DELETE SET NULL`); a concurrent citation loses a decay step; the job's row locks deadlock with the analysis commit or the learner and a finished review is the victim (40P01) | Lock first, never wait: heads, decay candidates, history victims and the rows of each chain are selected `FOR UPDATE SKIP LOCKED` with the rule's predicate; a row (or a chain with a row) held by another transaction is left for the next run; the chain is computed after the heads are locked, so a supersede that committed before is visible (the chain is skipped) and one that waits on the head then finds it gone (`not_found`); a citation that committed before the lock drops the entry out of the step; `touchMemoryEntries` sorts its ids | `memory-decay.test.ts` "concurrent tenant transactions: the job never waits": a supersede holding the head (skipped, chain whole after commit), the job holding the head (supersede answers `not_found`, the member-written entry stays current), a citation holding the entry (no step), a held chain row (whole chain left for the next run); all with a second connection holding the transaction open, no timing                                          |
| D6  | Logs or audit rows carry entry text, ids of other tenants or an org's error text                                                                                                                                                                                                                                 | The audit row (`memory.decayed`, actor `memory_decay`) holds counts and `as_of`; the worker logs counts and distinct error codes (`failures`); results are counts                                                                                                                                                                                                                                                                                                                                                                                        | "audits counts only, once per run that changed something, and nothing on an idle run"; `jobs.test.ts` "P8-4: logs the memory decay's per-org failures as counts and codes, never an org's error text"                                                                                                                                                                                                                                                         |
| D7  | An org mid-erasure or in its grace period is visited; one org's failure stops the run; the loop misses a page                                                                                                                                                                                                    | `worker.live_orgs` skips `erasing_at` and `delete_after` orgs; per-org try/catch records a code; the cursor is the last id of a full page                                                                                                                                                                                                                                                                                                                                                                                                                | "lists live org ids only … leaving out scheduled and erasing orgs"; `memory-decay.run.test.ts` "pages through the org list …", "records one org's failure by code only and still visits the others"                                                                                                                                                                                                                                                           |
| D8  | The job runs as the server (the application login) and reaches orgs it should not                                                                                                                                                                                                                                | `worker.live_orgs` is granted to `rocky_worker` only; the SECURITY DEFINER allow-lists pin it                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `runMemoryDecay` "fails closed as the application login"; `isolation.test.ts` allow-lists (`ALLOWED_SECURITY_DEFINER` unchanged, `ALLOWED_WORKER_SECURITY_DEFINER` + `worker.live_orgs`)                                                                                                                                                                                                                                                                      |
| D9  | A run repeats a step or deletes the boundary row                                                                                                                                                                                                                                                                 | `decayed_at`; strictly-older comparisons                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | "is idempotent at the same instant, takes one step per period since the last step, and stops at 0"; boundary rows in every rule's test                                                                                                                                                                                                                                                                                                                        |

## Consequences

- Migration 0019: `memory_entries.decayed_at`, two partial indexes for the candidate scans, three
  settings rows with CHECK floors, `worker.live_orgs`. The Drizzle schema mirrors the column.
- `RetentionConfig` gains `memoryDecayDays`, `memoryUnusedDays`, `memorySupersededDays`;
  `Db` gains `liveOrgs`; the worker gains the `memory_decay` job (`memoryDecayMs`).
- A retired or decayed entry changes nothing in stored documents; a retired entry re-reviews
  the files it was offered to on the next push (ADR 0037's unit key), which is the intended
  effect of memory changing.
- THREATS.md gains T43–T46.

## Residual risks

- **One rule for every learned entry.** A valuable convention in a quiet directory is retired
  after a year without a citation, and a corroborated dismissal (confidence 95) ages like any
  other. The windows are per deployment, not per org or repository; a per-repository window is
  a P8-3 setting if usage shows the need.
- **`updated_at` stands for "superseded at".** Only the supersede writes it today; a future
  writer that touches a superseded row's `updated_at` would delay its purge (the safe
  direction), never hasten it.
- **The per-repository cap is still a ceiling.** The job keeps memory from growing without
  bound over time, not within a day: a repository can still fill its 5 000 slots between runs.
- **Member-written history accumulates** until P8-3 deletes it: every edit through supersede
  keeps the previous version forever. Bounded by the cap, visible in P8-3's history view.
- **Deletion is permanent and the audit row holds counts.** Which entries went is not
  recorded; a team that wants to know what Rocky forgot can read P8-3's export before and after.
- **P8-3's disabled switch** (§4) is not known to the job.
- **A citation racing a retirement, the other way round.** Lock-first (D10) keeps a citation
  that committed before the lock from losing the entry or a step, and one still in flight keeps
  the entry out of this run. A citation that starts after the job holds the lock waits, then
  touches a row the job deleted (`touchMemoryEntries` answers 0 for it) or stepped. The stored
  document is unaffected either way: its `MemoryRef`s are copies built from the entry, never
  joins, and the entry was a year stale by then.
- **Where the job can still wait.** Not on `memory_entries` rows. The `ON DELETE CASCADE` into
  `embeddings` runs as the owner and would wait on an embeddings row another transaction holds
  (nothing writes embeddings today; P9-1 should keep its writers short), and the audit insert
  takes a `KEY SHARE` on the org row (`delete_org` locks it `FOR UPDATE`, so in practice
  erasure waits for the job's commit and not the reverse: `worker.live_orgs` leaves out every
  org with a `delete_after`, so the job and `delete_org` can only meet on an org that was
  scheduled for deletion, at least seven days before, during one run of the job over it; and
  either way the victim of such a deadlock would be the job or the erasure, both retried, never
  a review). A deadlock through those paths would need the other side to then wait on a row
  the job holds; the job's locks are only released at its commit.
- **A row held by a transaction that never ends delays its chain indefinitely.** `SKIP LOCKED`
  leaves a held row, and the whole chain behind a retiring head, for the next run; a
  transaction that holds a memory row and never commits or rolls back (a hung client) keeps
  that entry, chain or step alive until the connection is cleaned up. Postgres's
  `idle_in_transaction_session_timeout` is the operational bound.
