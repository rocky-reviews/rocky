# ADR 0005 — SQL migrations, database roles and the audit purge path

- **Status:** Accepted
- **Date:** 2026-10-25
- **Tasks:** P2-1, P2-2, P2-5, P2-6
- **Amended by:** [ADR 0007](0007-webhook-inbox.md) (the webhook inbox is a third non-tenant
  table in `app`; a fifth `SECURITY DEFINER` purge function), [ADR 0009](0009-installation-lifecycle.md)
  (roles `rocky_worker` and `rocky_lifecycle`; only the worker creates orgs and runs
  `retention.delete_org`; `app.org_deletions`)

## Context

ADR 0003 decided on `org_id` + row-level security on every tenant table and a `withOrg` client.
This ADR fixes how the schema is defined and changed, which database roles exist and what each
may do, and how the append-only audit log can still honour a retention period and an org
deletion. The schema holds encrypted secrets (wrapped keys, forge tokens) written by
`packages/crypto`, which is built in parallel.

## Decision

### 1. Plain SQL migrations, Drizzle as a typed mirror

- Migrations are hand-written SQL in `packages/db/migrations`, one `NNNN_name.up.sql` /
  `NNNN_name.down.sql` pair per version, applied by a small runner (`migrate`, `rollback`) that
  records version, name and a sha256 of the up and down scripts (line endings normalised) in `app.schema_migrations`, takes an advisory
  lock and runs each file in its own transaction. An applied migration whose content changed is
  refused (write a new migration instead). Both directions are exercised in CI (up → down to
  nothing → up, single steps, target version, concurrent migrators, checksum mismatch).
- RLS policies, triggers, grants and `SECURITY DEFINER` functions are expressed only in SQL. The
  Drizzle schema (`packages/db/src/schema.ts`) mirrors tables and columns for typed queries; a test
  compares it with `information_schema` so the two cannot drift. `drizzle-kit` is not used.
- Infrastructure objects live in schemas `app` (helper functions, the ledger, retention settings)
  and `retention` (purge and deletion functions). Everything in `public` is a tenant table, which
  lets the isolation suite enumerate `pg_class` and allow-list exactly two non-tenant tables.

### 2. Three roles, one owner

| Role                      | Logs in | Owns                           | May do                                                                                                                                                                                                                                        |
| ------------------------- | ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| migrator (e.g. `rocky`)   | yes     | database, schemas, tables      | run migrations; DDL; write `app.retention_settings`. Not superuser in production; `CREATEROLE` so it can create the two below; the only non-superuser with USAGE on `plpgsql` and `sql`.                                                      |
| `rocky_app` (group)       | no      | nothing                        | `SELECT/INSERT/UPDATE/DELETE` on tenant tables, except `SELECT/INSERT/UPDATE` on `orgs` and `SELECT/INSERT` on `audit_events`; `SELECT` on `app.retention_settings`; `EXECUTE` on the four retention functions. No language, no schema CREATE |
| `rocky_retention` (group) | no      | the 4 functions in `retention` | `SELECT/DELETE` on `analyses`, `jobs`, `orgs`, `audit_events`, `INSERT` on `audit_events` and `UPDATE` on `orgs` (only so `delete_org` can lock the row), through `USING (true)` policies; `SELECT` on the settings                           |

- The application connects as a LOGIN role that is a member of `rocky_app` and nothing else
  (`ensureLoginRole` creates it for dev/tests; platforms provision it in production). It is not
  the table owner, has `NOBYPASSRLS`, and every tenant table has `FORCE ROW LEVEL SECURITY`, so
  even the owner is filtered. Migration 0001 refuses to run if a pre-existing `rocky_app` or
  `rocky_retention` carries `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or
  `LOGIN`, or is a member of another role (a non-superuser migrator could not fix those, so it
  fails closed instead).
- `TEMPORARY` on the database is revoked from `PUBLIC` (migration 0003): `pg_temp` is searched
  before `public`, so a temp table on a pooled connection could otherwise shadow a tenant table.
- Roles and the `vector` extension are cluster-level and provisioned (`deploy/dev/init.sql` in
  development); down migrations therefore leave them in place.
- `ensureLoginRole` inspects an existing role's attributes and memberships before changing
  anything, and sends the password as a client-computed SCRAM-SHA-256 verifier (`node:crypto`), so
  the plaintext never reaches statement text or server logs. Passwords are printable ASCII (no
  SASLprep).
- The isolation suite also pins what else the app role can reach: views must be
  `security_invoker` or ungranted, the SECURITY DEFINER functions it may execute are exactly the
  four in `retention`, `pg_default_acl` is empty, and the privileges it holds on every relation
  match an explicit matrix (no column ACLs, nothing for PUBLIC).
- The application never deletes an `orgs` row: the cascade would erase a tenant in one statement,
  skipping the deletion grace period and the audit trail. It has no `DELETE` on `orgs` and a
  restrictive `FOR DELETE … USING (false)` policy on top; erasure is `retention.delete_org` only.

**Provisioning (superuser, once per cluster, before the first migration).** Tenant isolation
against crafted SQL rests on the application role being unable to run procedural code or reach
`set_config` indirectly (§3). Only a superuser can take these away, so they are not in a
migration; migration 0001 verifies them and refuses to run otherwise. `deploy/dev/init.sql` and
the Testcontainers harness run exactly this; a production DBA runs it by hand:

```sql
REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC;
REVOKE USAGE ON LANGUAGE sql FROM PUBLIC;
GRANT USAGE ON LANGUAGE plpgsql, sql TO <migrator>;   -- not needed when the migrator is a superuser
REVOKE UPDATE ON pg_catalog.pg_settings FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  pg_catalog.query_to_xml(text, boolean, boolean, text),
  pg_catalog.query_to_xmlschema(text, boolean, boolean, text),
  pg_catalog.query_to_xml_and_xmlschema(text, boolean, boolean, text),
  pg_catalog.ts_stat(text),
  pg_catalog.ts_stat(text, text),
  pg_catalog.ts_rewrite(tsquery, text)
FROM PUBLIC;
```

Why each: a `DO` block (or any function the role could create, in `sql` as much as `plpgsql`)
can call `set_config('app.org_id', …)` twice around a write, out of sight of the statement guard
and of the commit-time recheck; `UPDATE pg_settings` is `set_config` by another name; the six
functions execute SQL passed as a string literal, which the guard blanks. Language USAGE is
checked when a function is created and when `DO` runs, not when an existing function is called,
so triggers, `app.current_org_id()` and the retention functions keep working. `rocky_retention`
needs no language either: migration 0005 creates its functions as the migrator and transfers
them with `ALTER FUNCTION … OWNER TO`. A dev volume provisioned before this rule must be
recreated (`pnpm dev:down -v`).

### 3. Tenant context

`withOrg(orgId, fn)` validates the uuid, checks out a connection, clears any session-level
`app.org_id`, opens a transaction, runs `set_config('app.org_id', orgId, true)` (transaction-
local, pool-safe), runs `fn`, waits for any nested work, re-reads the setting and refuses to
commit if it changed, then commits or rolls back.

- Three layers keep code inside `withOrg(A)` from acting as another tenant, in this order:
  1. **The database (the layer isolation rests on).** The application role cannot run
     procedural code or arbitrary `set_config`: no USAGE on any trusted language, no CREATE on
     any schema, no `UPDATE` on `pg_settings`, no EXECUTE on the catalog functions that run SQL
     text, no rights to create triggers, rules, casts, operators or extensions (§2,
     "Provisioning"). Every statement it can send is therefore a plain statement the guard can
     read; `SET app.org_id` / `set_config` themselves cannot be revoked from a role, which is
     what the next two layers are for.
  2. **The statement guard (second layer).** The `tx` handle (raw `query` and the Drizzle `db`)
     talks to the connection through a proxy that exposes exactly one member, `query`; every
     other property of the pg client (`release`, `connection`, `end`, …) throws, so nothing
     inside `fn` can return a mid-transaction connection to the pool. `query` refuses every
     statement once the transaction has ended, and (after normalising comments, literals
     including `E'…'` escapes and `$tag$` quotes, quoting and case; `u&` escape syntax is
     refused outright) statements that would alter the transaction or the tenant context:
     `BEGIN`, `COMMIT`, `ROLLBACK`, `END`, `ABORT`, `SAVEPOINT`, `RELEASE`, `PREPARE`,
     `DISCARD`, `RESET`, `DO`, `CALL`, `CREATE`, `ALTER ROLE|USER|SYSTEM`,
     `UPDATE pg_settings`, `SET [LOCAL|SESSION] ROLE`, `SET SESSION AUTHORIZATION`,
     `SET TRANSACTION`, `SET app.*`, any `set_config(`, `ts_stat`, `ts_rewrite` and
     `query_to_xml*` by name, and real multi-statement text (`;` inside a literal or one
     trailing `;` is fine). Drizzle's `db.transaction()` is therefore refused as well.
  3. **The commit-time recheck.** `withOrg` re-reads `app.org_id` before `COMMIT` and rolls
     back if it differs: it detects a change that persists to commit. It cannot see a switch
     that was switched back inside the transaction, which is why layer 1 exists.
- Nested calls for the same org **join the open transaction** (REQUIRED propagation): the
  nested `fn` runs with the same guarded handle; there are no savepoints, no queues and no
  serialisation of nested calls (node-pg already serialises concurrent queries on one client, so
  `Promise.all` is safe at any depth). The library issues nothing but `begin`, `set_config`,
  `commit` and `rollback` on the connection. **Trade-off:** a failing nested call is not rolled
  back on its own. The error propagates and the whole transaction rolls back unless the caller
  catches it; if the caller catches it, the outer work commits together with whatever the nested
  call had already written. Code that needs an all-or-nothing sub-unit must run it in its own
  `withOrg` from outside the enclosing one. Partial rollback (savepoints) was built twice and
  produced a new tenant-isolation edge case each time; nothing in Phase 2 needs it. A nested
  call for a different org throws.
- A `withOrg` call made from work that outlived its enclosing transaction (a timer, an event
  listener created inside `fn`) finds a _closed_ scope and throws `TenantContextError` rather than
  starting a new transaction. The scope closes the moment the root `fn` settles, before commit, so
  no orphaned query at any depth reaches the connection: that scope's connection now belongs to someone else, and detached
  work should be scheduled from outside `withOrg` on purpose.
- The raw pool is never exported: outside `withOrg` the package offers only `purgeExpired`,
  `deleteOrg` and `retentionSettings`.

Policies compare `org_id` with `app.current_org_id()`, which returns `NULL` for a missing or
empty setting (no row matches) and raises for anything that is not a uuid.

### 4. Tenant-consistent foreign keys

Foreign-key checks ignore RLS, so a row could otherwise reference another tenant's parent.
Every child table references its parent with a composite key `(org_id, parent_id) REFERENCES
parent (org_id, id)`; parents carry `UNIQUE (org_id, id)`. Nullable references use
`ON DELETE SET NULL (column)` (Postgres 15+) so `org_id` is never nulled.

### 5. Append-only audit log, retention and org deletion

- `audit_events` has `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers that raise
  `insufficient_privilege` for every role, with one exception: `DELETE` when `current_user` is
  `rocky_retention`. The application role additionally lacks the privileges.
- Retention periods live in `app.retention_settings` (`analyses` 90 d, `logs` = finished `jobs`
  30 d, `audit` 365 d, `org_deletion_grace` 7 d by default). The migrator writes it
  (`pnpm db:migrate` applies `RETENTION_*_DAYS` / `ORG_DELETION_GRACE_DAYS` from the environment
  through `setRetentionSettings`); the application can only read it. A CHECK keeps the audit period
  at 30 days or more.
- `rocky_retention` cannot log in and owns only four `SECURITY DEFINER` functions in the
  migrator-owned `retention` schema. `purge_analyses(as_of)`, `purge_jobs(as_of)` and
  `purge_audit_events(as_of)` compute `before = least(as_of, now()) - period` from the settings
  table, delete rows strictly older than `before`, and insert one `retention.purged` audit event
  per affected org in the same statement. The caller can only move `as_of` into the past; the
  configured period is therefore also the floor. **Boundary:** a row created exactly `period`
  ago is kept.
- `delete_org(org)` erases one org once `delete_after <= now()`: it locks the `orgs` row with
  `SELECT … FOR UPDATE` (a tenant transaction inserting a child row holds KEY SHARE on it
  through the foreign key, so the lock waits for that write to finish instead of racing it),
  deletes the org's `audit_events` as `rocky_retention` (foreign-key cascades run as the table
  owner, which the trigger blocks) and then the `orgs` row, which cascades through every other
  tenant table. The lock is why `rocky_retention` holds `UPDATE` on `orgs` and an UPDATE
  policy; without the policy the lock would silently match no row. A BEFORE trigger on `orgs`
  pushes any `delete_after` the application sets to at least `now() + grace`, so scheduling and
  executing a deletion can never happen in one go; an AFTER trigger writes the
  `org.deletion_scheduled` / `org.deletion_cancelled` audit row with the application's own
  INSERT right (no extra privilege), after the org row exists.
- `audit_events.created_at` is set by a `BEFORE INSERT` trigger to `now()` for every role: the
  retention purge keys on it, so a caller-supplied value could date a row straight into the next
  purge. Tests that need old rows disable the trigger as the superuser for one transaction.
- `runRetention(db, { clock })` runs the three purges as of the injected clock and returns a
  report; it writes no audit rows itself. Application (Pino) logs are not in the database; their
  retention is a hosting concern.

## Consequences

- Schema review is SQL review: policies, triggers and grants are visible in one diff.
- Adding a table means: SQL with `org_id` + cascade FK + composite FKs, RLS + FORCE + policy +
  grants, a Drizzle mirror, and a fixture row; the isolation and drift suites fail until all are
  present. Adding a SECURITY DEFINER function means extending the allow-list in the suite.
- Cross-tenant operations need their own `SECURITY DEFINER` function owned by a dedicated role,
  with the authority (periods, grace) held in owner-written settings rather than in arguments,
  reviewed as RISKY. The retention functions are the template.
- Code that wants to do work after a tenant transaction returns a value from `withOrg` and acts
  on it outside; it cannot fire-and-forget from inside.
- Operators hold two credentials: the migrator (root-like, deployment only) and the application
  login. Local development mirrors this with `DATABASE_ADMIN_URL` and `DATABASE_URL`.
- Threats, mitigations and the test that proves each are listed in `packages/db/THREATS.md`.
