# ADR 0009 — Installation lifecycle: orgs from installs, deletion after uninstall

- **Status:** Accepted
- **Date:** 2026-10-26
- **Task:** P3-3
- **Amends:** [ADR 0005](0005-migrations-and-roles.md) §2 (two more roles; `INSERT` on `orgs` and
  `retention.delete_org` move from `rocky_app` to `rocky_worker`), [ADR 0007](0007-webhook-inbox.md)
  §3–§5 (the inbox gets a processing state and the worker's claim path)

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

| Role                    | Logs in | Holds                                                                                                                                                                       |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rocky_app` (server)    | no      | As before, minus `INSERT` on `orgs` and minus `retention.delete_org`                                                                                                        |
| `rocky_worker` (new)    | no      | `INSERT` on `orgs`; `EXECUTE` on `worker.*` (claim, complete, fail, installation lookup), `retention.delete_org`, `retention.orgs_due_for_deletion`                         |
| `rocky_lifecycle` (new) | no      | Owns the four `worker.*` SECURITY DEFINER functions; `SELECT, UPDATE` on `app.webhook_deliveries`, `SELECT` on `orgs`, each through a `USING (true)` policy for itself only |
| `rocky_retention`       | no      | As before, plus `SELECT, INSERT` on `app.org_deletions` and ownership of `orgs_due_for_deletion`                                                                            |

The worker logs in as its own LOGIN role, a member of `rocky_app` **and** `rocky_worker`
(`WORKER_DATABASE_URL`; `ensureLoginRole(..., { worker: true })`). The server's login is a member
of `rocky_app` only and `ensureLoginRole` refuses to turn a worker login into a server login or
back. So the internet-facing process can neither create a tenant, nor claim, finish or park an
inbox row (a compromised server cannot mark an uninstall "processed" to suppress an erasure), nor
erase an org. The worker refuses to start on a login without `rocky_worker`.

Org creation stays inside `withOrg(newOrgId)`: `rocky_worker` has the privilege, the existing
tenant policy (`id = app.current_org_id()`) still checks the row, plus an explicit
`orgs_worker_insert` policy. No RLS was relaxed.

### 2. How an org is bound

- `orgs` gains `account_id` (the forge's immutable account id, `NOT NULL`), unique per forge, next
  to the existing unique `(forge, installation_id)`. `login` is display data and is refreshed from
  GitHub; nothing is ever looked up by login.
- A trigger (`orgs_guard_identity`) makes `id`, `forge` and `account_id` immutable for every role
  and lets only a `rocky_worker` member change `installation_id` (the rebind below).
- `installer_forge_user_id` records the webhook's sender as a **candidate** first admin. It is
  stored only when the event's account agrees with GitHub's answer, and is never a membership: no
  `members` row and no user account are created here. P7-1 owns users; it must verify the
  candidate on GitHub (org admin, or the account itself for a personal installation) before
  granting anything. `sender: null` (ghost user, app or staff action) leaves it `NULL`; P7-1 then
  falls back to the first user who signs in and is verified as an admin.

### 3. The inbox processing state and the claim path

New columns on `app.webhook_deliveries`: `attempts`, `available_at` (backoff), `lease_token` and
`lease_until`, `processed_at` + `outcome` (a fixed code), `parked_at`, `last_error` (a SQLSTATE or a
fixed reason code; CHECKs refuse anything else). The stamp trigger resets all of them on insert, so
the receiver cannot plant a row as processed, leased or parked.

- `worker.claim_webhook_deliveries(event_types, limit, lease_seconds)`: `FOR UPDATE SKIP LOCKED`
  over pending rows (not processed, not parked, available, lease absent or expired), oldest first;
  sets a fresh `lease_token` and `lease_until`, increments `attempts`. Bounds are clamped in SQL
  (1–100 rows, 5–3600 s). A row whose lease expired (its worker crashed) is claimable again and
  gets `last_error = 'lease_expired'`; a row already claimed `WEBHOOK_MAX_ATTEMPTS` (5) times is
  parked instead of handed out. Event types are a filter: pull request rows wait for P3-4.
- `worker.complete_webhook_delivery(forge, delivery_id, lease_token, outcome)`: only for the
  current lease holder. The worker calls it **inside the tenant transaction** that applied the
  effect (`completeInTenantTx`), so the effect, its audit events and the "processed" mark commit
  together; if the lease was lost to another worker it returns false, the worker throws
  `LeaseLostError` and the transaction rolls back. Outcomes with no tenant effect are completed on
  their own.
- `worker.fail_webhook_delivery(..., error_code, retry_after_seconds, permanent)`: releases the
  lease, records the code, sets the backoff (30 s doubling to 1 h), parks when `permanent` or when
  the attempts are used up. Returns `retry`, `parked` or `stale`.
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
for. **Only a 404 means "gone"**; 401/403/5xx, timeouts and malformed answers throw
`ForgeReadError` and the row is retried, then parked. An enterprise account is
`unsupported_account_type`.

Config (`apps/worker/src/config.ts`): `GITHUB_APP_ID` (positive integer) and
`GITHUB_APP_PRIVATE_KEY` (unencrypted PEM, RSA ≥ 2048 bits; literal `\n` accepted) are validated
before anything is opened. Both or neither; invalid → exit 1 everywhere; missing → exit 1 in
production (`NODE_ENV=production` or `FLY_APP_NAME`). Missing in development: the worker does not
claim installation events at all (they wait in the inbox, unverified events are never acted on).
The key and the JWT are never logged; errors name the variable only.

### 5. Semantics

Every decision is taken on GitHub's answer **now**, not on the event, so order, replays and
planted rows do not matter beyond a redundant read.

| Event                  | GitHub says                      | Existing org                                                             | Effect (outcome)                                                                                                                   |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `installation.created` | 404                              | any                                                                      | nothing (`installation_not_found`)                                                                                                 |
| `installation.created` | exists                           | none for this installation or account                                    | new org with a random id, identity from GitHub's answer (`org_created`)                                                            |
| `installation.created` | exists                           | same installation id, not scheduled                                      | nothing (`already_installed`)                                                                                                      |
| `installation.created` | exists                           | same installation id, deletion scheduled                                 | cancel the deletion (`org_reinstalled`). GitHub issues a new id on a real reinstall, so this is a redelivery after a transient 404 |
| `installation.created` | exists, account A                | same installation id bound to account B                                  | park (`account_mismatch`): identity never changes                                                                                  |
| `installation.created` | exists (new id), account A       | org of account A under an older installation id that GitHub says is gone | **reinstall**: rebind the org to the new id, cancel any scheduled deletion, refresh login (`org_rebound`); the data survives       |
| `installation.created` | exists (new id), account A       | org of account A whose old installation still exists                     | park (`account_has_live_installation`): one installation per app per account, something is off                                     |
| `installation.created` | exists                           | the account's org was already erased                                     | a new org; nothing of the old one comes back (`org_created`)                                                                       |
| `installation.deleted` | 404                              | bound to this installation, not scheduled                                | schedule deletion; the database clamps it to ≥ now + grace (`deletion_scheduled`)                                                  |
| `installation.deleted` | 404                              | already scheduled / none                                                 | nothing (`deletion_already_scheduled` / `no_org`)                                                                                  |
| `installation.deleted` | exists (active **or suspended**) | any                                                                      | nothing; audited as `org.uninstall_ignored` when an org exists (`installation_exists`)                                             |

**Suspended is not deleted.** A suspended installation still exists on GitHub; its org and data
stay and nothing is scheduled. `installation.suspend`/`unsuspend` are not decoded (ADR 0007);
reads on behalf of a suspended installation fail until it is unsuspended (P3-4 handles that).

### 6. Deletion sweep and erasure

`sweepOrgDeletions` (worker, every 15 min) lists due orgs with `retention.orgs_due_for_deletion`
(database clock) and erases each: first every external store through the `OrgErasers` port
(`packages/core/src/erasure.ts`: named slots `object_storage` for R2 (P5) and `embeddings` for
vectors outside Postgres (P8); today both hold `nothingStoredYet`, so a new store without an eraser
is a type error), then `retention.delete_org`. If a store fails, the org row stays and the next
sweep retries. `delete_org` (re-created) still locks the org row, deletes its audit events as
`rocky_retention`, then the org (cascading through every tenant table), and now also the org's
**finished** inbox rows (by installation id or account id; pending rows stay, a reinstall's
`created` among them) and writes a tombstone to `app.org_deletions` (org id, forge, installation
id, due date, counts; no login, no account id). The tombstone is append-only (trigger), invisible
to the application, and kept as evidence the erasure ran. Two workers sweeping at once are safe:
the row lock serialises them and the loser gets `22023`, counted as skipped.

`runRetention` (worker, every 6 h) now includes the inbox. All jobs are idempotent, never overlap
themselves within a worker, and are safe across workers.

### 7. Audit trail

Within the org's transaction, ids only (actor `forge:<delivery id>`): `org.installed`
(installation id, account id and kind, installer candidate, suspended), `org.uninstalled`,
`org.reinstalled` (new and previous installation id, whether a deletion was cancelled),
`org.uninstall_ignored`; the 0005 triggers add `org.deletion_scheduled` / `org.deletion_cancelled`.
"Executed" is the tombstone in `app.org_deletions` plus the worker's `org erased` log line (the
org's own audit events are erased with it).

## Threat model

Assets: tenant boundaries (who owns which data), tenant data and its erasure (GDPR), the app's
private key, the integrity of the job stream, the audit trail, log hygiene.
Attackers: anyone on the internet (forged or replayed webhooks); PR authors and installers
(content inside genuine payloads, chosen logins); other tenants (another account's installation);
whoever holds the server's database credential (planted inbox rows, direct SQL as `rocky_app`);
a crashed or concurrent worker; a GitHub outage or a misconfigured key.

| #   | What can go wrong                                                                            | Prevention                                                                                                                                                          | Test                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Forged or replayed delivery creates or erases a tenant                                       | HMAC at the receiver (ADR 0007); the worker acts only on GitHub's answer                                                                                            | `lifecycle.e2e.test.ts` "a forged delivery is refused at the door; a planted row … creates nothing"                                                                                                            |
| L2  | Planted inbox row (server credential) creates an org or binds an installation to an attacker | Re-verify `GET /app/installations/{id}`; identity from GitHub's answer; sender kept only if the event's account matches GitHub's                                    | e2e "a planted row for an installation GitHub does not know creates nothing", "handles … an installer whose event disagrees with GitHub"                                                                       |
| L3  | Planted or stale `installation.deleted` erases a live tenant                                 | Deletion scheduled only on a 404; suspended counts as existing; grace period enforced by the database                                                               | e2e "an installation.deleted while GitHub still has the installation (active or suspended) deletes nothing"; `installations.test.ts` "returns null only on a 404"                                              |
| L4  | A GitHub outage or a bad key is read as "uninstalled"                                        | `ForgeReadError` for everything but 404; retried, then parked; never `null`                                                                                         | e2e "a GitHub outage or a rejected app key is never read as an uninstall"; `installations.test.ts` "fails closed …" suite                                                                                      |
| L5  | Binding by login: a renamed/reused login takes over another tenant                           | Bind by `(forge, installation_id)` and immutable `account_id` (unique); login is display only; identity columns immutable (trigger)                                 | `deletion.test.ts` "binds one org per (forge, installation) and one per (forge, account)", "the server login cannot rebind an installation or change an org's identity"; e2e "account_mismatch" park           |
| L6  | The server (or a stray grant) creates tenants or rebinds installations                       | `INSERT` on `orgs` only for `rocky_worker`; rebind only for its members; worker logins are separate                                                                 | `deletion.test.ts` "only the worker login creates orgs; the server login is refused"; `isolation.test.ts` privilege matrices; `roles.test.ts` "makes a worker login …"                                         |
| L7  | A compromised server suppresses an uninstall (marks it processed) or erases orgs             | Claim/complete/fail and `delete_org` executable only by `rocky_worker`; the app keeps `INSERT` on the inbox only                                                    | `inbox.test.ts` "the server's login cannot claim, finish or look up anything"; `deletion.test.ts` "the server login can neither list due orgs nor erase one"; `isolation.test.ts` SECURITY DEFINER allow-lists |
| L8  | Double processing by concurrent workers                                                      | `FOR UPDATE SKIP LOCKED` + lease token; completion inside the effect's transaction; unique constraints                                                              | `inbox.test.ts` "never hands one row to two concurrent workers, and loses none"; e2e "concurrent workers process every row exactly once …", "two workers sweeping at once erase each org once"                 |
| L9  | A crash loses a row, or a late worker applies an effect twice                                | Lease expiry makes the row claimable; a lost lease cannot complete; effect + mark commit together                                                                   | `inbox.test.ts` "retries a row after a crash …", "rolls the tenant effect back when the lease was lost"; e2e "a worker that crashes mid-processing loses nothing"                                              |
| L10 | Poison rows loop forever                                                                     | 5 attempts then parked (also when the lease keeps expiring); undecodable or contradictory rows parked at once                                                       | `inbox.test.ts` "parks a poison row …", "parks a row that crashes its worker every time"; e2e "parks poison rows …"                                                                                            |
| L11 | Tampered stored rows trusted                                                                 | `decodeClaimedDelivery`: `minimalEvent` again + columns cross-check                                                                                                 | `inbox.test.ts` "accepts a stored row only if it passes minimalEvent …"; e2e "tampered" row                                                                                                                    |
| L12 | Retention deletes an unprocessed uninstall                                                   | Purge only `processed_at IS NOT NULL`                                                                                                                               | `inbox.test.ts` "purges old processed rows only; pending, leased and parked rows stay"                                                                                                                         |
| L13 | Erasure misses data (a new table, a non-public table, external stores)                       | FK cascade from `orgs`; a structural test enumerates every `org_id` column and FK to `orgs` in every schema; `OrgErasers` slots are a type, run before the row goes | `deletion.test.ts` "is structural: every column that holds an org id, in any schema, is emptied …"; e2e "schedules with a 7-day grace, then empties every tenant table …"; `erasure.test.ts`                   |
| L14 | Erasure before the grace period                                                              | Database clamps `delete_after` (0005); `delete_org` refuses early; due list by the database clock                                                                   | `deletion.test.ts` "refuses an org still inside its grace period …", "lists only orgs past their grace period …"; e2e sweep at 6 days deletes nothing                                                          |
| L15 | Reinstall within grace loses data, or after erasure resurrects it                            | Rebind by account id cancels the deletion; after erasure a new org id is created                                                                                    | e2e "within the grace period, with a new installation id …", "with the same installation id …", "after the deletion ran, creates a new org …"                                                                  |
| L16 | Private key or JWT leaks; weak or wrong key used                                             | Key parsed once into a `KeyObject`; RSA ≥ 2048 at boot; errors name the variable only; never logged                                                                 | `app-auth.test.ts`; `config.test.ts` (unit and spawned boot); e2e "logs never contain the key, the app JWT, logins …"                                                                                          |
| L17 | Worker acts on unverified events when credentials are missing                                | No app credentials → no inbox job (development only); production refuses to boot                                                                                    | `jobs.test.ts` "never touches installation events without app credentials (fail closed)…"; `config.test.ts` "refuses to start in production without app credentials"                                           |
| L18 | Server login used as the worker (privileges silently missing, or widened)                    | Worker checks `rocky_worker` membership at boot; `ensureLoginRole` keeps the two shapes apart                                                                       | `roles.test.ts`; `isolation.test.ts` "a worker login is a member of rocky_app and rocky_worker only …"                                                                                                         |
| L19 | Cross-tenant leakage through the new lookup                                                  | `worker.installation_orgs` returns ids and the deadline only, worker only; tenant reads stay under RLS                                                              | e2e "keeps tenants apart …"; `inbox.test.ts` "finds orgs by installation id or by account id, ids only"                                                                                                        |
| L20 | Logs carry content, logins or secrets                                                        | Logs carry delivery/org/installation ids, outcomes and codes; error codes only                                                                                      | e2e "logs never contain …"; `jobs.test.ts` "logs a failing run by code only"                                                                                                                                   |

## Consequences

- Two database logins per deployment (server and worker). Development: `WORKER_DATABASE_URL`;
  new volumes get the login from `deploy/dev/init.sql`, existing ones from `pnpm seed`.
- Org rows exist only through the lifecycle. Tests seed orgs as the worker (`asWorker`).
- Adding an external store means adding a slot to `EXTERNAL_TENANT_STORES` and an eraser.
- `docs/architecture.md` describes the worker's jobs; ADR 0007 points here for the inbox state.

## Residual risks

- **Worker credential compromise** gives tenant creation, inbox control and erasure of due orgs.
  The grace period still applies (the clamp is in the database), and erasure needs a scheduled org.
- **The server can still cancel a scheduled deletion** of an org it can name (it keeps `UPDATE` on
  `orgs` for future settings); the cancellation is audited by the 0005 trigger. Moving
  `delete_after` behind the worker role is a follow-up.
- **A transient 404 from GitHub** would schedule a deletion; the 7-day grace and the
  `org_reinstalled` path cover it, and nothing is erased before the grace ends.
- **External erasure then cancellation:** a reinstall racing the sweep can cancel after the
  external stores were erased. Today those stores hold nothing; when P5 adds R2 (derived, rebuildable
  renders and exports), the order is acceptable, but P5 must keep R2 content rebuildable.
- **Parked rows need a human**: no tooling yet beyond SQL as the migrator (runbook follow-up).
- **Pull request rows** accumulate unprocessed until P3-4 consumes them (they are not purged).
- **Installer candidate** may be wrong or absent; P7-1 must verify before granting admin.
- **Tombstones are kept indefinitely**: they hold no personal data (no login or account id).
