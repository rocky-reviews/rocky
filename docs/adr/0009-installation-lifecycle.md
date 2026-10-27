# ADR 0009 — Installation lifecycle: orgs from installs, deletion after uninstall

- **Status:** Accepted
- **Date:** 2026-10-26
- **Task:** P3-3
- **Amends:** [ADR 0005](0005-migrations-and-roles.md) §2 (two more roles; `INSERT` on `orgs`,
  `UPDATE` on its identity and deletion columns, and `retention.delete_org` move from `rocky_app`
  to `rocky_worker`), [ADR 0007](0007-webhook-inbox.md) §3–§5 (the inbox gets a processing state
  and the worker's claim path)
- **Revised:** review round 1 (H1, M2, M3, S1–S6, L4–L6, N1–N6): column-level grants on `orgs`,
  a bounded deletion window, per-installation ordering, transient vs. strike failures, the app
  check, re-verification in the sweep, the erasing state. Review round 2 (A, B, C, SF2–SF4):
  claim-time superseding removed, a shape CHECK on installation rows, a shape-guarded and
  installation-scoped erasure of inbox rows, the contradiction window counted in strikes, the
  lease budget on the worker's own clock. Review round 3: a claim whose cost does not grow with the
  backlog (a ready queue, index probes, a statement timeout), leases from `clock_timestamp()`,
  same-type duplicates collapsed when a verified row completes, a numeric `installationId` CHECK.
  Review round 4: the server refuses a login that is a member of `rocky_worker` (L28);
  `delete_org` requires the sweep's erasing mark (L29).

## Context

A tenant is one GitHub App installation (ADR 0003). Installing the app must create the tenant;
uninstalling it must erase the tenant, but not at once: an accidental uninstall should be
undoable for a grace period (7 days, `org_deletion_grace`, ADR 0005 §5). The signal is a webhook
row in `app.webhook_deliveries` (ADR 0007), which is a hint, not a fact: GitHub signs no
timestamp, the dedup window ends, and whoever holds the server's database credential can insert
rows. Erasure is irreversible and creating a tenant decides who owns data, so both run in the
worker, after GitHub confirms them.

## Decision

### 1. Who may do what (database roles)

| Role                    | Logs in | Holds                                                                                                                                                                                                                                                                 |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rocky_app` (server)    | no      | As before, minus `INSERT` on `orgs`, minus `retention.delete_org`, and `UPDATE` on `orgs` only for `settings`, the two encrypted key columns with their versions, and `updated_at`                                                                                    |
| `rocky_worker` (new)    | no      | `INSERT` on `orgs`; `UPDATE` on `orgs (installation_id, login, kind, delete_after, installer_forge_user_id, erasing_at, updated_at)`; `EXECUTE` on `worker.*` (claim, complete, fail, installation lookup), `retention.delete_org`, `retention.orgs_due_for_deletion` |
| `rocky_lifecycle` (new) | no      | Owns the four `worker.*` SECURITY DEFINER functions; `SELECT, UPDATE` on `app.webhook_deliveries`, `SELECT` on `orgs`, each through a `USING (true)` policy for itself only                                                                                           |
| `rocky_retention`       | no      | As before, plus `SELECT, INSERT` on `app.org_deletions`, `UPDATE` on `app.webhook_deliveries` (the erasure's scrub) and ownership of `orgs_due_for_deletion`                                                                                                          |

The worker logs in as its own LOGIN role, a member of `rocky_app` **and** `rocky_worker`
(`WORKER_DATABASE_URL`; `ensureLoginRole(..., { worker: true })`). The server's login is a member
of `rocky_app` only and `ensureLoginRole` refuses to turn a worker login into a server login or
back. So the internet-facing process can neither create a tenant, nor claim, finish or park an
inbox row (a compromised server cannot mark an uninstall "processed" to suppress an erasure), nor
erase an org. The worker refuses to start on a login without `rocky_worker`. The reverse holds
too (review round 4, L28): the server refuses to start when its login is a member of
`rocky_worker` (an operator reusing `WORKER_DATABASE_URL`, or a superuser URL, which is a member of
every role), and its pool checks every new connection the same way (`onConnect`), so a database
unreachable at boot or a grant made later still gives the server no worker connection.

Org creation stays inside `withOrg(newOrgId)`: `rocky_worker` has the privilege, the existing
tenant policy (`id = app.current_org_id()`) still checks the row, plus an explicit
`orgs_worker_insert` policy. No RLS was relaxed.

### 2. How an org is bound

- `orgs` gains `account_id` (the forge's immutable account id, `NOT NULL`), unique per forge, next
  to the existing unique `(forge, installation_id)`. `login` is display data and is refreshed from
  GitHub; nothing is ever looked up by login.
- A trigger (`orgs_guard_identity`) makes `id`, `forge` and `account_id` immutable for every role
  and lets only a `rocky_worker` member change `installation_id` (the rebind below),
  `delete_after`, `erasing_at`, `installer_forge_user_id`, `login` or `kind`. Column-level grants
  say the same first (review round 1, H1): the server may update only `settings`, its encrypted
  keys and `updated_at`, so it can neither schedule, push out, clear nor cancel a deletion.
- **The deletion window is bounded on both ends.** `delete_after` is `NULL` or between
  `now() + grace` and `now() + grace + 1 h` when written (the 0005 clamp raises the lower end; the
  upper end and `infinity` raise `check_violation` for every role, superuser included; a CHECK
  forbids non-finite values). A deadline written before this bound existed is replaced when the
  worker processes the next uninstall, never kept as "already scheduled".
- **Erasing is final.** `erasing_at` is set by the sweep under the row lock once the org is due
  (the trigger refuses it earlier). From then on nothing changes `delete_after`, `erasing_at` or
  `installation_id`, the installation lookup no longer returns the org, and the unique indexes on
  `(forge, installation_id)` and `(forge, account_id)` are partial (`WHERE erasing_at IS NULL`), so
  a reinstall during an erasure creates a fresh org instead of binding to the dying one.
- `installer_forge_user_id` records the webhook's sender as a **candidate** first admin. It is
  stored only when the event's account agrees with GitHub's answer, and is never a membership: no
  `members` row and no user account are created here. P7-1 owns users; it must verify the
  candidate on GitHub (org admin, or the account itself for a personal installation) before
  granting anything. `sender: null` (ghost user, app or staff action) leaves it `NULL`; P7-1 then
  falls back to the first user who signs in and is verified as an admin.

### 3. The inbox processing state and the claim path

New columns on `app.webhook_deliveries`: `attempts` (claims), `strikes` (failures that say
something about the row), `available_at` (backoff), `lease_token` and `lease_until`,
`processed_at` + `outcome` (a fixed code), `parked_at`, `last_error` (a SQLSTATE or a fixed reason
code; CHECKs refuse anything else). The stamp trigger resets all of them on insert, so the
receiver cannot plant a row as processed, leased or parked. A CHECK
(`webhook_deliveries_installation_shape`, review round 2) refuses any installation row without the
shape `minimalEvent` produces (`account` object with a positive safe-integer id, a login and a
kind; `sender` null or an object with an id and an actor login; `installationId` a JSON number,
review round 3), for every role, so a planted row cannot be undecodable or trip the erasure's
scrub.

- `worker.claim_webhook_deliveries(forge, event_types, limit, lease_seconds)`, serialised by a
  transaction-level advisory lock:
  1. **Nothing is finished here.** Round 1 superseded older pending duplicates at claim time;
     a planted newer row (the receiver's credential suffices) then swallowed a genuine uninstall
     and parked itself (review round 2, A). The claim and the failure path finish no row but the
     one they hold; only a verified completion collapses duplicates (below).
  2. **Expired leases** (the worker crashed) are released with a strike and
     `last_error = 'lease_expired'`; the fifth strike parks the row.
  3. **One live lease per installation** (S2): only the oldest pending row of each installation is
     a candidate, and only if no row of that installation is leased. Events of one installation
     are therefore processed strictly in order, one at a time, across all workers; a head waiting
     on its backoff holds back the later ones.
  4. Candidates of the worker's **forge** only (M3), available now, oldest first,
     `FOR UPDATE SKIP LOCKED`; each gets a fresh `lease_token` and `lease_until`, `attempts + 1`.
     Bounds are clamped in SQL (1–100 rows, 5–3600 s). Event types are a filter: pull request rows
     wait for P3-4.
  5. **Bounded cost** (review round 3). Round 2 ranked every pending row on each claim, behind the
     global lock, so a planted backlog for one installation slowed (and with enough rows, stopped)
     every claim. Now a hint table `app.webhook_queue` keeps one row per (forge, installation,
     lane) with the earliest moment its head can be claimed; statement-level triggers on the inbox
     maintain it (the receiver's insert only lowers `ready_at`; leases, failures and completions
     recompute it). A claim reads at most `3 × limit + 10` ready queue rows per lane through
     `webhook_queue_ready_idx`, and for each probes the lane's head through the partial
     `webhook_deliveries_pending_idx` and its live lease through the partial
     `webhook_deliveries_leased_idx`: a constant number of index probes per candidate, whatever
     the backlog. A stale queue row is corrected or deleted under a sequence guard (a concurrent
     insert is never lost) and the claim moves on. Measured on a laptop: 0.4–5 ms per claim with
     2k, 20k and 200k pending rows for one installation, 2–4 ms with 200k distinct ready
     installations, before and after `ANALYZE`; round 2's claim exceeded 5 s at 20k.
  6. **A statement timeout** (5 s, `CLAIM_STATEMENT_TIMEOUT_MS`, `SET LOCAL` in the claim's
     transaction) bounds how long a claim holds or waits for the lock; it fails with `57014`
     (transient) and the next tick retries.
  7. **Leases start at the claim**: `lease_until` and `leased_at` come from `clock_timestamp()`
     after the lock is taken, not from the transaction's start, so time spent waiting on the lock
     does not eat the lease.
- `worker.complete_webhook_delivery(forge, delivery_id, lease_token, outcome)`: only for the
  current lease holder. The worker calls it **inside the tenant transaction** that applied the
  effect (`completeInTenantTx`), so the effect, its audit events and the "processed" mark commit
  together; if the lease was lost to another worker it returns false, the worker throws
  `LeaseLostError` and the transaction rolls back. Outcomes with no tenant effect are completed on
  their own.
- **Collapse on completion** (review round 3). When an `installation.*` row of type T completes
  for installation I, every other row of the same forge, I and **exactly T** that is pending, not
  leased, not parked and received no later than the completed row's claim (`leased_at`) is marked
  processed with outcome `superseded`. Why this is safe:
  - Every completion follows a GitHub read of I (`reconcileInstallation` calls `verify` before any
    outcome; failures, parks and undecodable rows go through `fail`, which collapses nothing), and
    the decision depends on GitHub's answer, not on the row (§5). A same-type row received before
    that claim asks the same question and would get an answer no fresher than one already acted on.
  - Only the **lease holder's** completion collapses (a stale holder's returns false first), only
    within one installation and one type (a `created` never hides a `deleted` or the reverse), and
    never pull request rows, whose content differs per event.
  - Rows received after the claim are kept: they may report a change GitHub made since.
  - A planted row cannot use this to swallow a genuine one: it has to be claimed, verified and
    completed first, and then the genuine rows it collapses would have reached the same decision.
    The cost of a planted backlog is therefore one decision per type and installation, not one
    per row; the contradiction retries of the completing row are its only extra reads.
  - Residual: a collapsed `created` row's `sender` is not considered as an installer candidate
    (see residual risks).
- `worker.fail_webhook_delivery(..., error_code, retry_after_seconds, kind)`: releases the lease,
  records the code, sets the backoff (the worker asks for 30 s doubling to 1 h), and by `kind`
  (S3): `transient` (an outage: no strike; parked only once the row is 72 h old), `strike` (the
  row is suspect: parked at 5 strikes), `permanent` (parked now). An unknown kind parks (fail
  closed). Returns `retry`, `parked` or `stale`.
- **Lease sizing** (S4, SF3): the worker leases a batch for `(batch + 1) × (2 × 10 s + 10 s)`, the
  worst case of two GitHub reads per row at the reader's timeout plus one row of slack, and
  releases a row unstarted (transient, `lease_budget`, retried after one row budget) when less
  than one row's budget of its lease is left. "Left" is measured on the worker's own clock from
  just before the claim (never against the database's `lease_until`, so clock skew cannot
  release every row), and the inbox job only loops at once after a full batch that all went
  through.
- Each inbox row is therefore processed **at most once in effect** (the commit of the effect is
  tied to the lease) and **at least once in delivery** (a crash only delays it until the lease
  expires). Handlers are also idempotent, because they decide on GitHub's current state.
- Consumers re-validate every claimed row with `minimalEvent` plus a column cross-check
  (`decodeClaimedDelivery`); a row that does not decode is parked as `invalid_event`.
- `retention.purge_webhook_deliveries` now deletes only **processed** rows past the period.
  Pending, leased and parked rows stay however old: an unprocessed uninstall must not age out.
  Parked rows need a human (requeue or delete as the migrator); see the runbook follow-up.

### 4. Re-verification with GitHub

The worker authenticates as the app: an RS256 JWT (`iat` = now − 60 s, `exp` = now + 9 min, `iss` =
`GITHUB_APP_ID`) built with `node:crypto` `sign("sha256", …)` and the `GITHUB_APP_PRIVATE_KEY`
`KeyObject`; no JWT dependency. `GET /app/installations/{id}` (`packages/forge-github`,
`createGitHubInstallationReader`): https API base only (GHES supported), no redirects, 10 s timeout,
256 KiB cap, schema-checked, the returned `id` (and `app_id`, when present) must be the one asked
for. **Only GitHub's own 404 means "gone"**: status 404, a JSON media type, and the body
`{"message": "Not Found"}` (M2). Any other 404 (a proxy's HTML page, an empty body, another
message) is `invalid_response`. 401/403/5xx, timeouts and malformed answers throw `ForgeReadError`.
An enterprise account (`slug` and `name`, no `login`) is `unsupported_account_type`.

**The app check** (M2): GitHub answers 404 for installations of _another_ app, so a key for the
wrong app would make every installation look uninstalled. Before the worker claims an inbox row
or sweeps, `GET /app` with the JWT must answer the configured `GITHUB_APP_ID`; otherwise it claims
nothing, erases nothing and logs `forge app check failed` at error level with the code
(`forge_app_mismatch`, `forge_http_401`, …), retrying on every tick. A pass is trusted for an hour.

**Transient vs. strike** (S3): timeouts, network errors, 5xx, 429, 401, 403 and `app_mismatch` are
`ForgeReadError.transient`, as are database errors of SQLSTATE classes 08, 40, 53, 57 and 58; they
are retried with backoff up to an hour and never count against the row. Malformed answers,
contradictions, concurrent changes and other errors are strikes.

Config (`apps/worker/src/config.ts`): `GITHUB_APP_ID` (positive integer) and
`GITHUB_APP_PRIVATE_KEY` (unencrypted PEM, RSA ≥ 2048 bits; literal `\n` accepted) are validated
before anything is opened. Both or neither; invalid → exit 1 everywhere; missing → exit 1 in
production (`NODE_ENV=production` or `FLY_APP_NAME`). Missing in development: the worker does not
claim installation events at all (they wait in the inbox, unverified events are never acted on).
The key and the JWT are never logged; errors name the variable only.

### 5. Semantics

Every decision is taken on GitHub's answer **now**, not on the event, so order, replays and
planted rows do not matter beyond a redundant read. Events of one installation are still
processed one at a time and in order of receipt (§3), so two answers about one installation never
race each other.

**Contradictions are retried before they are believed** (S1). GitHub's API can lag its webhooks: a
`created` it still answers 404 for, a `deleted` it still answers 200 for, or a reinstall whose
previous installation still exists is a strike and retried with backoff; the third
contradiction is believed (the rows below marked "after 3 attempts"). The window counts strikes,
not attempts, so outages and released rows before it do not shorten it (review round 2, SF2).
Lease expiries are strikes too, so a row whose worker crashed after a contradiction has fewer
contradiction retries left; at worst it is believed on its first contradiction after two lost
leases, which still takes a GitHub answer (and a deletion still has the grace period and the
sweep's re-check).

| Event                  | GitHub says                      | Existing org                                                              | Effect (outcome)                                                                                                                   |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `installation.created` | 404                              | any                                                                       | retried; after 3 attempts nothing (`installation_not_found`)                                                                       |
| `installation.created` | exists                           | none for this installation or account                                     | new org with a random id, identity from GitHub's answer (`org_created`)                                                            |
| `installation.created` | exists                           | same installation id, not scheduled                                       | nothing (`already_installed`)                                                                                                      |
| `installation.created` | exists                           | same installation id, deletion scheduled                                  | cancel the deletion (`org_reinstalled`). GitHub issues a new id on a real reinstall, so this is a redelivery after a transient 404 |
| `installation.created` | exists, account A                | same installation id bound to account B                                   | park (`account_mismatch`): identity never changes                                                                                  |
| `installation.created` | exists (new id), account A       | org of account A under an older installation id that GitHub says is gone  | **reinstall**: rebind the org to the new id, cancel any scheduled deletion, refresh login (`org_rebound`); the data survives       |
| `installation.created` | exists (new id), account A       | org of account A whose old installation still exists                      | retried; after 3 attempts park (`account_has_live_installation`): one installation per app per account                             |
| `installation.created` | exists, account A                | org of account A being erased                                             | a new org (`org_created`); the erasure of the old one continues (S6)                                                               |
| `installation.created` | exists                           | the account's org was already erased                                      | a new org; nothing of the old one comes back (`org_created`)                                                                       |
| `installation.deleted` | 404                              | bound to this installation, not scheduled, or scheduled beyond the window | schedule deletion; the database clamps it to now + grace (`deletion_scheduled`)                                                    |
| `installation.deleted` | 404                              | scheduled within the window / none / being erased                         | nothing (`deletion_already_scheduled` / `no_org`)                                                                                  |
| `installation.deleted` | exists (active **or suspended**) | any                                                                       | retried; after 3 attempts nothing, audited as `org.uninstall_ignored` when an org exists (`installation_exists`)                   |

**Suspended is not deleted.** A suspended installation still exists on GitHub; its org and data
stay and nothing is scheduled. `installation.suspend`/`unsuspend` are not decoded (ADR 0007);
reads on behalf of a suspended installation fail until it is unsuspended (P3-4 handles that).

### 6. Deletion sweep and erasure

`sweepOrgDeletions` (worker, every 15 min, after the app check) lists due orgs with
`retention.orgs_due_for_deletion` (database clock; with forge, installation id and whether an
erasure already started) and, for each org of its forge:

1. **Re-verifies with GitHub** (S1c), unless the erasure already started. The installation exists
   (active, suspended, or on an unmodelled account): the deletion is cancelled through the worker's
   path and audited as `org.erasure_cancelled` (reason `installation_exists`; the 0005 trigger adds
   `org.deletion_cancelled`). No answer: the org is left for the next sweep (`deferred`). Only a
   genuine 404 proceeds. This also stops a deadline that reached the database by any other route.
2. **Marks it erasing** (`erasing_at`, under the row lock, audited `org.erasure_started`): the
   point of no return (§2). If it is no longer due (a reinstall cancelled it a moment ago), it is
   skipped.
3. **Erases** every external store through the `OrgErasers` port (`packages/core/src/erasure.ts`:
   named slots `object_storage` for R2 (P5) and `embeddings` for vectors outside Postgres (P8)),
   then calls `retention.delete_org`. The type forces each slot to exist, so adding a store to
   `EXTERNAL_TENANT_STORES` without an eraser is a type error; it does not force a real eraser:
   both slots hold the `nothingStoredYet` placeholder today, and a placeholder can stay after the
   store exists (the P5/P8 follow-ups replace them).

If a store fails, the org stays erasing and the next sweep resumes at step 3 without asking GitHub
again; external erasure is idempotent. `delete_org` (re-created) locks the org row, refuses
(`22023`) an org that is not due or not marked erasing (review round 4, L29: no caller can reach
the database erasure without the sweep's GitHub re-check and the external erasers), deletes its
audit events as `rocky_retention`, then the org (cascading through every tenant table), and the
inbox rows tied to it:

- of **its installation**: finished rows, rows that are not `installation.*` events (pull
  requests nobody will process for an erased org, L4) and rows whose stored shape is unexpected
  (review round 2, B: they cannot be scrubbed safely; the CHECK keeps new ones out) are deleted;
  its remaining, well-formed pending rows keep ids only: `sender` becomes `null` and
  `account.login` becomes `"erased"` (still a valid login, so the row decodes; the login is
  re-read from GitHub anyway). The scrub only touches rows whose `account` is an object and whose
  `sender` is null or an object, so no row can make it raise;
- of **its account under other installations**: only finished rows of installations no live org
  holds (the org's own history before a rebind). A reinstall's rows (another installation,
  pending or already bound to a live org, e.g. one created while this org was erasing) are not
  this org's and are left alone, installer candidate included (review round 2, C).

It then writes a tombstone to `app.org_deletions` (org id, forge, installation id, due date,
counts deleted and scrubbed; no login, no account id). The tombstone is append-only (trigger),
invisible to the application, and kept as evidence the erasure ran. The tail: rows received for
the installation _after_ the erasure are ordinary new rows (a fresh install, or noise answered
by GitHub's 404). Two workers sweeping at once are safe: the row lock serialises them and the
loser gets `22023`, counted as skipped.

`runRetention` (worker, every 6 h) now includes the inbox. All jobs are idempotent, never overlap
themselves within a worker, and are safe across workers.

### 7. Audit trail

Within the org's transaction, ids only (actor `forge:<delivery id>`): `org.installed`
(installation id, account id and kind, installer candidate, suspended), `org.uninstalled`
(including whether an out-of-window deadline was rescheduled), `org.reinstalled` (new and previous
installation id, whether a deletion was cancelled), `org.uninstall_ignored`; from the sweep (actor
`system:org_deletion_sweep`): `org.erasure_cancelled` (reason, suspended) and
`org.erasure_started`; the 0005 triggers add `org.deletion_scheduled` / `org.deletion_cancelled`.
"Executed" is the tombstone in `app.org_deletions` plus the worker's `org erased` log line (the
org's own audit events are erased with it).

## Threat model

Assets: tenant boundaries (who owns which data), tenant data and its erasure (GDPR), the app's
private key, the integrity of the job stream, the audit trail, log hygiene.
Attackers: anyone on the internet (forged or replayed webhooks); PR authors and installers
(content inside genuine payloads, chosen logins); other tenants (another account's installation);
whoever holds the server's database credential (planted inbox rows, direct SQL as `rocky_app`);
a crashed or concurrent worker; a GitHub outage or a misconfigured key.

| #   | What can go wrong                                                                                                                                                      | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Forged or replayed delivery creates or erases a tenant                                                                                                                 | HMAC at the receiver (ADR 0007); the worker acts only on GitHub's answer                                                                                                                                                                                                                                                                                                                                                                                                                          | `lifecycle.e2e.test.ts` "a forged delivery is refused at the door; a planted row … creates nothing"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| L2  | Planted inbox row (server credential) creates an org or binds an installation to an attacker                                                                           | Re-verify `GET /app/installations/{id}`; identity from GitHub's answer; sender kept only if the event's account matches GitHub's                                                                                                                                                                                                                                                                                                                                                                  | e2e "a planted row for an installation GitHub does not know creates nothing", "handles … an installer whose event disagrees with GitHub"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| L3  | Planted or stale `installation.deleted` erases a live tenant                                                                                                           | Deletion scheduled only on a genuine 404 (JSON `Not Found`); suspended counts as existing; contradictions retried first; the sweep asks GitHub again before erasing and cancels if it still exists; grace enforced by the database; only the worker can write `delete_after` (column grants + trigger), bounded to a 1 h window, never `infinity`                                                                                                                                                 | e2e "an installation.deleted while GitHub still has the installation …", "S1c: the sweep re-verifies …", "S1c/H1: a deadline that reached the database without an uninstall …"; `deletion.test.ts` "the deletion schedule belongs to the worker (review round 1, H1)" suite; `installations.test.ts` "believes a 404 only when it is GitHub's own JSON Not Found"                                                                                                                                                                                                                                                                                                          |
| L4  | A GitHub outage, a proxy's 404 or a key for the wrong app is read as "uninstalled"                                                                                     | `ForgeReadError` for everything but GitHub's JSON 404; the app check (`GET /app` = `GITHUB_APP_ID`) gates every claim and sweep; outages are transient (retried, never parked before 72 h)                                                                                                                                                                                                                                                                                                        | e2e "a GitHub outage or a rejected app key is never read as an uninstall", "M2: a key for another app claims nothing and erases nothing …", "S3: a long GitHub outage never parks a row …"; `installations.test.ts` "fails closed …", "verifyApp …" suites; `jobs.test.ts` "the app check gate"                                                                                                                                                                                                                                                                                                                                                                            |
| L5  | Binding by login: a renamed/reused login takes over another tenant                                                                                                     | Bind by `(forge, installation_id)` and immutable `account_id` (unique); login is display only; identity columns immutable (trigger)                                                                                                                                                                                                                                                                                                                                                               | `deletion.test.ts` "binds one org per (forge, installation) and one per (forge, account)", "the server login cannot rebind an installation or change an org's identity"; e2e "account_mismatch" park                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| L6  | The server (or a stray grant) creates tenants or rebinds installations                                                                                                 | `INSERT` on `orgs` only for `rocky_worker`; rebind only for its members; worker logins are separate                                                                                                                                                                                                                                                                                                                                                                                               | `deletion.test.ts` "only the worker login creates orgs; the server login is refused"; `isolation.test.ts` privilege matrices; `roles.test.ts` "makes a worker login …"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| L7  | A compromised server (or anyone with its credential) suppresses an uninstall, erases orgs, moves/cancels a deletion, or plants rows that swallow or wedge genuine ones | Claim/complete/fail and `delete_org` executable only by `rocky_worker`; the app keeps `INSERT` on the inbox only and `UPDATE` on `orgs` only for settings and its keys (column grants); the trigger refuses schedule, installer and identity changes from non-workers even with a column grant; no row is ever finished except by its own lease holder (no superseding); installation rows must have the decodable shape (CHECK); the erasure's scrub is shape-guarded and deletes malformed rows | `inbox.test.ts` "the server's login cannot claim, finish or look up anything", "never marks a row processed on another row's account …", "installation rows must have minimalEvent's shape" suite; `deletion.test.ts` "the server login can neither list due orgs nor erase one", "the server login cannot set, push out, clear or re-target a deletion …", "the server holds UPDATE on exactly the columns it writes", "N-a: the trigger alone refuses …", "B: a malformed pending row … cannot wedge the erasure"; e2e "A: a newer undecodable duplicate cannot swallow a genuine uninstall or install"; `isolation.test.ts` privilege matrices and `orgs` column grants |
| L8  | Double or interleaved processing by concurrent workers                                                                                                                 | Claims serialised by an advisory lock; one live lease per installation, oldest first; `FOR UPDATE SKIP LOCKED` + lease token; completion inside the effect's transaction; collapse only by the lease holder's completion; unique constraints                                                                                                                                                                                                                                                      | `inbox.test.ts` "never hands one row to two concurrent workers …", "hands out one row per installation at a time …", "a stale lease holder's completion collapses nothing …"; e2e "concurrent workers process every row exactly once …", "S2/N6: created and deleted for one installation …", "two workers sweeping at once erase each org once"                                                                                                                                                                                                                                                                                                                           |
| L9  | A crash loses a row, or a late worker applies an effect twice                                                                                                          | Lease expiry makes the row claimable; a lost lease cannot complete; effect + mark commit together                                                                                                                                                                                                                                                                                                                                                                                                 | `inbox.test.ts` "retries a row after a crash …", "rolls the tenant effect back when the lease was lost"; e2e "a worker that crashes mid-processing loses nothing"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| L10 | Poison rows loop forever, or an outage parks good rows                                                                                                                 | Strikes (lost leases, contradictions, bad answers) park at 5; transient failures back off to 1 h and park only at 72 h; undecodable rows parked at once                                                                                                                                                                                                                                                                                                                                           | `inbox.test.ts` "parks a poison row after WEBHOOK_MAX_STRIKES …", "never parks a row for transient failures …", "parks a row that crashes its worker every time", "parks on an unknown failure kind"; e2e "parks poison rows …", "S3 …"                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L11 | Tampered stored rows trusted                                                                                                                                           | `decodeClaimedDelivery`: `minimalEvent` again + columns cross-check                                                                                                                                                                                                                                                                                                                                                                                                                               | `inbox.test.ts` "accepts a stored row only if it passes minimalEvent …"; e2e "tampered" row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| L12 | Retention deletes an unprocessed uninstall                                                                                                                             | Purge only `processed_at IS NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `inbox.test.ts` "purges old processed rows only; pending, leased and parked rows stay"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| L13 | Erasure misses data (a new table, a non-public table, external stores, inbox rows naming the account)                                                                  | FK cascade from `orgs`; a structural test enumerates every `org_id` column and FK to `orgs` in every schema (each with rows before) and pins the non-public tables keyed by installation or account id; `OrgErasers` slots are a type, run before the row goes; `delete_org` deletes or scrubs the inbox rows of the installation and account                                                                                                                                                     | `deletion.test.ts` "is structural: every column that holds an org id, in any schema, is emptied …"; e2e "schedules with a 7-day grace, then empties every tenant table …"; `erasure.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| L14 | Erasure before the grace period                                                                                                                                        | Database clamps `delete_after` (0005); `delete_org` refuses early; due list by the database clock                                                                                                                                                                                                                                                                                                                                                                                                 | `deletion.test.ts` "refuses an org still inside its grace period …", "lists only orgs past their grace period …"; e2e sweep at 6 days deletes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L15 | Reinstall within grace loses data, after erasure resurrects it, or during erasure binds to the dying org                                                               | Rebind by account id cancels the deletion; erasing is final and frees the unique binding, so a reinstall then gets a new org; after erasure a new org id is created                                                                                                                                                                                                                                                                                                                               | e2e "within the grace period, with a new installation id …", "with the same installation id …", "after the deletion ran, creates a new org …", "S6: a reinstall after erasing started gets a fresh org …"; `deletion.test.ts` "marks an org erasing only once it is due; erasing is final …"                                                                                                                                                                                                                                                                                                                                                                               |
| L16 | Private key or JWT leaks; weak or wrong key used                                                                                                                       | Key parsed once into a `KeyObject`; RSA ≥ 2048 at boot; errors name the variable only; never logged                                                                                                                                                                                                                                                                                                                                                                                               | `app-auth.test.ts`; `config.test.ts` (unit and spawned boot); e2e "logs never contain the key, the app JWT, logins …"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L17 | Worker acts on unverified events, or erases, when credentials are missing                                                                                              | No app credentials → no inbox job and no sweep (development only); production refuses to boot                                                                                                                                                                                                                                                                                                                                                                                                     | `jobs.test.ts` "never touches installation events or erases orgs without app credentials (fail closed) …"; `config.test.ts` "refuses to start in production without app credentials"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| L18 | Server login used as the worker (privileges silently missing, or widened)                                                                                              | Worker checks `rocky_worker` membership at boot; `ensureLoginRole` keeps the two shapes apart                                                                                                                                                                                                                                                                                                                                                                                                     | `roles.test.ts`; `isolation.test.ts` "a worker login is a member of rocky_app and rocky_worker only …"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| L19 | Cross-tenant leakage through the new lookup                                                                                                                            | `worker.installation_orgs` returns ids and the deadline only, worker only; tenant reads stay under RLS                                                                                                                                                                                                                                                                                                                                                                                            | e2e "keeps tenants apart …"; `inbox.test.ts` "finds orgs by installation id or by account id, ids only"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L20 | Logs carry content, logins or secrets                                                                                                                                  | Logs carry delivery/org/installation ids, outcomes and codes; error codes only                                                                                                                                                                                                                                                                                                                                                                                                                    | e2e "logs never contain …"; `jobs.test.ts` "logs a failing run by code only"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| L21 | A row's lease runs out mid-batch and two workers act on it                                                                                                             | Lease = batch × worst-case row time; a row whose lease has less than one row's budget left is released unstarted; completion is tied to the lease (L9)                                                                                                                                                                                                                                                                                                                                            | e2e "S4: the lease covers a batch's worst case …"; `jobs.test.ts` "lease sizing"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| L22 | A row of another forge is handled by this forge's adapter                                                                                                              | Claim filtered by the worker's forge; the worker parks a foreign row before any forge call; the sweep handles only its forge's orgs                                                                                                                                                                                                                                                                                                                                                               | `inbox.test.ts` "claims only rows of the worker's forge …"; e2e "M3: a worker claims only its forge's rows …"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| L23 | A redelivery flood multiplies GitHub reads and work                                                                                                                    | A verified completion collapses the earlier pending, unleased same-type rows of its installation (`superseded`), so a flood costs one decision per type, not one per row; claim and failure collapse nothing, parked rows and pull request rows never collapse anything (L7)                                                                                                                                                                                                                      | `inbox.test.ts` "never marks a row processed on another row's account at claim or failure; only a completed, verified row collapses …", "a stale lease holder's completion collapses nothing; pull request rows never collapse"; e2e "N planted created rows ahead of a genuine uninstall cost O(1) GitHub decisions, not N", "A: a newer undecodable duplicate cannot swallow a genuine uninstall or install"                                                                                                                                                                                                                                                             |
| L24 | The private key lingers in the process environment (child processes, dumps)                                                                                            | `GITHUB_APP_PRIVATE_KEY` is deleted from `process.env` once parsed into a `KeyObject`                                                                                                                                                                                                                                                                                                                                                                                                             | `config.test.ts` "loadWorkerConfig (review round 1, L6)"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| L25 | Erasing an org destroys a reinstall's data (rows, installer candidate)                                                                                                 | `delete_org` matches inbox rows by the erased installation; by account only finished rows of installations no live org holds                                                                                                                                                                                                                                                                                                                                                                      | `deletion.test.ts` "is structural …" (live org e during the erasure; pending row of another installation untouched); e2e "C: erasing the old org leaves a reinstall's rows and its installer candidate alone"                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| L26 | Contradiction window used up by outages; lease budget broken by clock skew or a batch of one (hot loop)                                                                | Contradictions counted in strikes; local deadline from just before the claim; lease `(batch + 1) × budget` from `clock_timestamp()`; released rows delayed; no immediate re-loop after a full batch with releases or retries                                                                                                                                                                                                                                                                      | e2e "SF2: transient failures do not use up the contradiction window", "SF3: a skewed worker clock or a batch of one still processes rows", "S4/SF3: … without a hot loop"; `jobs.test.ts` "lease sizing", "a full batch with released or retried rows waits for the next tick (no hot loop)"; `inbox.test.ts` "leases from the moment of the claim (clock_timestamp) …"                                                                                                                                                                                                                                                                                                    |
| L27 | A planted backlog (server credential) makes every claim slow behind the global lock, stalling all tenants' lifecycle events                                            | Ready queue `app.webhook_queue` + partial indexes: a constant number of index probes per candidate, at most `3 × limit + 10` candidates per lane; `SET LOCAL statement_timeout` (5 s) on the claim; collapse on completion drains the backlog                                                                                                                                                                                                                                                     | `inbox.test.ts` "a 20k-row backlog for one installation does not slow a claim for another", "a claim waiting on the claim lock gives up after its statement timeout"; EXPLAIN evidence in the round 3 PR notes                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| L28 | The worker's login (or a superuser) used as the internet-facing server's, handing it org creation, inbox control and erasure                                           | `startServer` refuses to start when `pg_has_role(current_user, 'rocky_worker', 'USAGE')` (`WorkerLoginError`, a `ConfigError`: exit 1, message names roles and variables only); the pool's `onConnect` hook runs the same check on every new connection and discards a worker one, so a database unreachable at boot or a later grant gives no worker connection                                                                                                                                  | `apps/server/src/server.db.test.ts` "the server's database login (review round 4)": worker login and superuser refused before listening, `main.ts` exits 1 without the credential, app login starts, a grant after boot gets no connection (healthz 503); `server.test.ts` "boots without the database …"                                                                                                                                                                                                                                                                                                                                                                  |
| L29 | A caller other than the sweep (a future job or script) runs `retention.delete_org` on a due org and skips GitHub's re-check and the external erasers                   | `delete_org` refuses (`22023`) an org without `erasing_at`, which only `beginOrgErasure` sets, and the sweep calls it only after GitHub's JSON 404 and before the erasers                                                                                                                                                                                                                                                                                                                         | `deletion.test.ts` "refuses a due org that is not marked erasing …"; every other erasure test marks the org first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Consequences

- Two database logins per deployment (server and worker). Development: `WORKER_DATABASE_URL`;
  new volumes get the login from `deploy/dev/init.sql`. **Upgrading a dev database from `main`**
  (no 0007 yet): add the `WORKER_DATABASE_URL` line from `.env.example` to `.env`, then run
  `pnpm seed`, which applies the migrations and creates `rocky_worker_dev`. **A dev database that
  ran an earlier version of this branch's 0007** cannot go `down 1` (the ledger checksum no longer
  matches the edited file): drop the dev volume (`docker compose -f docker-compose.dev.yml down -v`; this deletes the dev data) and
  run `pnpm dev` / `pnpm seed` again.
- Org rows exist only through the lifecycle. Tests seed orgs as the worker (`asWorker`).
- Adding an external store means adding a slot to `EXTERNAL_TENANT_STORES` and an eraser.
- `docs/architecture.md` describes the worker's jobs; ADR 0007 points here for the inbox state.

## Residual risks

- **Worker credential compromise** gives tenant creation, inbox control and erasure of due orgs.
  The grace period still applies (the clamp is in the database, and the window bounds it from
  above), erasure needs a scheduled org, and the sweep still asks GitHub before erasing; a
  compromised worker can of course skip that check.
- **The server can no longer schedule, move or cancel a deletion** (H1). It can still change an
  org's `settings` and keys; those are tenant data, not lifecycle.
- **A genuine but wrong 404 from GitHub** (a GitHub-side bug) for an `installation.deleted` row
  schedules a deletion at once: there a 404 agrees with the event, so it is not a contradiction
  and is not retried. The 7-day grace, the `org_reinstalled` path and the sweep's re-verification
  at the end of the grace cover it, and nothing is erased before the grace ends and GitHub
  answers 404 again. (For a `created` row a 404 is a contradiction, retried three times; then the
  install is not acted on.)
- **A deadline set while the bound did not yet exist** stays until the next uninstall event for
  that installation reschedules it, or until the sweep reaches it and asks GitHub. A periodic
  reconciler that re-verifies live orgs against GitHub is a follow-up.
- **Lost or believed-away uninstalls.** Webhooks GitHub could not deliver while the server was
  down are not redelivered automatically, and an `installation.deleted` that GitHub's API still
  answers 200 for throughout the contradiction window (three strikes) is ignored
  (`installation_exists`). In both cases the org stays live until another event. Follow-up: a
  periodic installation reconciler (`GET /app/installations`, or a re-check of each live org)
  that schedules a deletion on GitHub's JSON 404, and possibly a longer contradiction window for
  `deleted` only.
- **A write between the external erase and `delete_org`.** The erasers run after the org is
  marked erasing, and `delete_org` after them; a store write that lands in between (an R2 object,
  P5) is not covered by either and is orphaned. Follow-up for P5: writers refuse orgs with
  `erasing_at` set, and/or the erasers run again after `delete_org`, driven by
  `app.org_deletions`.
- **Eraser placeholders.** `OrgErasers` forces each slot to exist, not to be real: a deployment
  that stores objects in R2 while `object_storage` is still `nothingStoredYet` would leave them
  behind. Follow-up for P5: refuse to start when R2 is configured and the slot is the placeholder.
- **Sweep starvation.** The due list is capped at 20 per sweep and ordered by `delete_after`, so
  20 orgs whose eraser keeps failing hold back every later one. Follow-up: deprioritise repeated
  failures or raise the cap.
- **Future `installation.*` types stop a lane.** The claim skips a lane head whose type is not in
  the worker's `p_event_types`, so storing a new installation event type before the worker
  handles it stops that installation's lane (follow-up for P3-4, which adds types).
- **The server's login check runs per connection, not per statement.** A grant of `rocky_worker`
  to the server's login while connections are open takes effect on those connections until they
  are recycled; new connections are refused. A server pointed at the owner (migrator) login is
  not refused by this check (the owner is not a `rocky_worker` member); that remains a
  deployment-docs item (Phase 10).
- **Erasure is final once marked.** A reinstall after the mark gets a fresh, empty org; the data
  of the old one is gone even if GitHub then shows the account installed again. The mark is only
  set after GitHub confirmed the uninstall at the end of the grace period.
- **The app check is cached for an hour**: a key rotated to the wrong app is noticed within the
  hour. Until then GitHub answers 401 for the new key (transient, no row parks) or, for a key of
  another app, 404s. For an `installation.deleted` row such a 404 is acted on at once (a deletion
  is scheduled, not retried); it is bounded by the 7-day grace period and by the sweep's
  re-check, which needs a fresh app check (an hour at most) and GitHub's 404 again before
  anything is erased. For a `created` row the 404s are contradictions, retried three times, and
  the install may then be dropped (the reconciler follow-up recovers it).
- **Lease budget uses the worker's clock against the database's `lease_until`**: skew larger than
  one row's budget (30 s) could still let a lease expire mid-row; completion is lease-checked, so
  the effect is then rolled back, never applied twice.
- **Parked rows need a human**: no tooling yet beyond SQL as the migrator (runbook follow-up).
  Inbox depth and parked-row alerting is a follow-up too. Parked rows are never purged and keep
  the sender and account login; scrubbing them on park, or purging them after a longer period, is
  part of the runbook follow-up.
- **Per-installation delay.** Processing is serial per installation, so a target-specific flood
  still delays that one installation: rows of other types interleaved in the backlog (a planted
  `created`, `deleted`, `created`, … sequence) each still need their own decision, and a head on
  backoff holds the later rows. Other installations are not slowed (the claim's cost is bounded),
  and the planted rows need the server's credential. Inbox depth and oldest-pending-age alerting,
  per installation, is the follow-up control.
- **Collapse uses the completing row's claim time**, so a duplicate delivered while the decision
  was in flight is processed on its own (one more read), never collapsed on an older answer.
- **The webhook's `installation.app_id`** is not stored or compared; the reader's answer is
  checked against `GITHUB_APP_ID` instead (`app_id` of `GET /app/installations/{id}` and the app
  check), which is the fact the worker acts on. Storing and comparing it is a follow-up.
- **A pending row of the erased installation** keeps its ids and type after the erasure (a
  redelivery GitHub will answer 404 for); a pending row of the account under another
  installation keeps its login and sender: it belongs to a reinstall, not to the erased org.
  This includes pending rows of an **older** installation of the account, which carry its login
  and sender too: they are not scrubbed, because the erasure cannot tell them apart from a
  pending reinstall's rows without asking GitHub, and scrubbing a reinstall's `created` row would
  lose its installer candidate (review round 2, C). They are finished (404) by the next claims and
  purged after the retention period like any processed row.
- **A collapsed `created` row's sender** is not offered as an installer candidate; the completed
  row's sender (if its account matched GitHub's) is. The installer candidate is a hint that P7-1
  verifies anyway.
- **Pull request rows** accumulate unprocessed until P3-4 consumes them (the purge skips
  unprocessed rows). Either P3-4 is scheduled next, or pending `pull_request.*` rows older than
  the retention period are purged.
- **Installer candidate** may be wrong or absent; P7-1 must verify before granting admin.
- **Tombstones are kept indefinitely**: they hold no personal data (no login or account id).
