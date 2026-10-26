# ADR 0005 — SQL migrations, database roles and the audit purge path

- **Status:** Accepted
- **Date:** 2026-10-25
- **Tasks:** P2-1, P2-2, P2-5, P2-6

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

| Role                      | Logs in | Owns                             | May do                                                                                                                                                                   |
| ------------------------- | ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| migrator (e.g. `rocky`)   | yes     | database, schemas, tables        | run migrations; DDL; write `app.retention_settings`. Not superuser in production; `CREATEROLE` so it can create the two below.                                           |
| `rocky_app` (group)       | no      | nothing                          | `SELECT/INSERT/UPDATE/DELETE` on tenant tables (only `SELECT/INSERT` on `audit_events`), `SELECT` on `app.retention_settings`, `EXECUTE` on the four retention functions |
| `rocky_retention` (group) | no      | schema `retention` + 4 functions | `SELECT/DELETE` on `analyses`, `jobs`, `orgs`, `audit_events` and `INSERT` on `audit_events`, through `USING (true)` policies; `SELECT` on the settings                  |

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
  four in `retention`, and `pg_default_acl` is empty.

### 3. Tenant context

`withOrg(orgId, fn)` validates the uuid, checks out a connection, clears any session-level
`app.org_id`, opens a transaction, runs `set_config('app.org_id', orgId, true)` (transaction-
local, pool-safe), runs `fn`, waits for any nested work, re-reads the setting and refuses to
commit if it changed, then commits or rolls back.

- The `tx` handle (raw `query` and the Drizzle `db`) talks to the connection through a proxy
  that exposes exactly one member, `query`; every other property of the pg client (`release`,
  `connection`, `end`, …) throws, so nothing inside `fn` can return a mid-transaction connection
  to the pool. `query` refuses every statement once the transaction has ended, and (best effort,
  after normalising comments, literals including `E'…'` escapes and `$tag$` quotes, quoting and
  case; `u&` escape syntax is refused outright) statements that would alter the
  transaction or the tenant context: `BEGIN/COMMIT/ROLLBACK/END/ABORT/SAVEPOINT/RELEASE/PREPARE/
DISCARD/RESET`, `SET [LOCAL|SESSION] ROLE | SESSION AUTHORIZATION | TRANSACTION | app.*`, any
  `set_config(` and real multi-statement text (`;` inside a literal or one trailing `;` is fine).
  Drizzle's `db.transaction()` is therefore refused as well. The commit-time recheck of
  `app.org_id` remains the actual guarantee.
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
- `rocky_retention` cannot log in and owns only the `retention` schema and four
  `SECURITY DEFINER` functions. `purge_analyses(as_of)`, `purge_jobs(as_of)` and
  `purge_audit_events(as_of)` compute `before = least(as_of, now()) - period` from the settings
  table, delete rows strictly older than `before`, and insert one `retention.purged` audit event
  per affected org in the same statement. The caller can only move `as_of` into the past; the
  configured period is therefore also the floor. **Boundary:** a row created exactly `period`
  ago is kept.
- `delete_org(org)` erases one org once `delete_after <= now()`: it deletes the org's
  `audit_events` as `rocky_retention` (foreign-key cascades run as the table owner, which the
  trigger blocks) and then the `orgs` row, which cascades through every other tenant table. A
  BEFORE trigger on `orgs` pushes any `delete_after` the application sets to at least
  `now() + grace`, so scheduling and executing a deletion can never happen in one go; an AFTER
  trigger writes the `org.deletion_scheduled` / `org.deletion_cancelled` audit row with the
  application's own INSERT right (no extra privilege), after the org row exists.
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
