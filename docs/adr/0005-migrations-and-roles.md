# ADR 0005 — SQL migrations, database roles and the audit purge path

- **Status:** Accepted
- **Date:** 2026-10-25
- **Tasks:** P2-1, P2-2, P2-5, P2-6

## Context

ADR 0003 decided on `org_id` + row-level security on every tenant table and a `withOrg` client.
This ADR fixes how the schema is defined and changed, which database roles exist and what each
may do, and how the append-only audit log can still honour a retention period. The schema holds
encrypted secrets (wrapped keys, forge tokens) written by `packages/crypto`, which is built in
parallel.

## Decision

### 1. Plain SQL migrations, Drizzle as a typed mirror

- Migrations are hand-written SQL in `packages/db/migrations`, one `NNNN_name.up.sql` /
  `NNNN_name.down.sql` pair per version, applied by a small runner (`migrate`, `rollback`) that
  records versions in `app.schema_migrations`, takes an advisory lock and runs each file in its own
  transaction. Both directions are exercised in CI (up → down to nothing → up, single steps,
  target version, concurrent migrators).
- RLS policies, triggers, grants and `SECURITY DEFINER` functions are expressed only in SQL. The
  Drizzle schema (`packages/db/src/schema.ts`) mirrors tables and columns for typed queries; a test
  compares it with `information_schema` so the two cannot drift. `drizzle-kit` is not used.
- Infrastructure objects live in schemas `app` (helper functions, the ledger) and `retention`
  (purge functions). Everything in `public` is a tenant table, which lets the isolation suite
  enumerate `pg_class` and allow-list exactly one non-tenant table.

### 2. Three roles, one owner

| Role                      | Logs in | Owns                             | May do                                                                                                                    |
| ------------------------- | ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| migrator (e.g. `rocky`)   | yes     | database, schemas, tables        | run migrations; DDL. Not superuser in production; `CREATEROLE` so it can create the two below.                            |
| `rocky_app` (group)       | no      | nothing                          | `SELECT/INSERT/UPDATE/DELETE` on tenant tables (only `SELECT/INSERT` on `audit_events`), `EXECUTE` on the purge functions |
| `rocky_retention` (group) | no      | schema `retention` + 3 functions | `SELECT/DELETE` on `analyses`, `jobs`, `audit_events` through `USING (true)` policies                                     |

- The application connects as a LOGIN role that is a member of `rocky_app` and nothing else
  (`ensureLoginRole` creates it for dev/tests; platforms provision it in production). It is not
  the table owner, has `NOBYPASSRLS`, and every tenant table has `FORCE ROW LEVEL SECURITY`, so
  even the owner is filtered. Migration 0001 refuses to run if a pre-existing `rocky_app` or
  `rocky_retention` carries `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or
  `LOGIN`, or is a member of another role (a non-superuser migrator could not fix those, so it
  fails closed instead).
- Roles and the `vector` extension are cluster-level and provisioned (`deploy/dev/init.sql` in
  development); down migrations therefore leave them in place.
- Postgres has no parameter binding for `CREATE/ALTER ROLE`; `ensureLoginRole` escapes the
  password with the driver's literal escaper. Keep `log_statement` below `all` on servers where it
  runs.

### 3. Tenant context

`withOrg(orgId, fn)` validates the uuid, checks out a connection, clears any session-level
`app.org_id`, opens a transaction, runs `set_config('app.org_id', orgId, true)` (transaction-
local, pool-safe), runs `fn`, re-reads the setting and refuses to commit if it changed, then
commits or rolls back. Nested calls for the same org join the transaction through a savepoint;
a different org throws before any SQL. The raw pool is never exported: outside `withOrg` the
package offers only `purgeExpired`.

Policies compare `org_id` with `app.current_org_id()`, which returns `NULL` for a missing or
empty setting (no row matches) and raises for anything that is not a uuid.

### 4. Tenant-consistent foreign keys

Foreign-key checks ignore RLS, so a row could otherwise reference another tenant's parent.
Every child table references its parent with a composite key `(org_id, parent_id) REFERENCES
parent (org_id, id)`; parents carry `UNIQUE (org_id, id)`. Nullable references use
`ON DELETE SET NULL (column)` (Postgres 15+) so `org_id` is never nulled.

### 5. Append-only audit log with a narrow purge path

- `audit_events` has `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers that raise
  `insufficient_privilege` for every role, with one exception: `DELETE` when `current_user` is
  `rocky_retention`. The application role additionally lacks the privileges.
- `rocky_retention` cannot log in and owns only the `retention` schema and three
  `SECURITY DEFINER` functions: `purge_analyses(before)`, `purge_jobs(before)`,
  `purge_audit_events(before)`. Each deletes rows strictly older than `before` and returns
  `(org_id, deleted)` per org. `purge_audit_events` refuses any cutoff newer than 30 days
  (`AUDIT_MIN_RETENTION_DAYS`), a floor that is deliberately not configurable: it bounds what a
  compromised application credential can erase.
- `runRetention(db, { clock, config })` computes `before = clock.now() - days` per category
  (`analyses` 90 d, `logs` = finished `jobs` 30 d, `audit` 365 d by default, overridable through
  `RETENTION_*_DAYS`), calls the purge, and writes one `retention.purged` audit event per affected
  org and table. **Boundary:** a row is expired iff `created_at < before`; a row created exactly
  `period` ago is kept. Application (Pino) logs are not in the database; their retention is a
  hosting concern.

## Consequences

- Schema review is SQL review: policies, triggers and grants are visible in one diff.
- Adding a table means: SQL with `org_id` + cascade FK + composite FKs, RLS + FORCE + policy +
  grants, a Drizzle mirror, and a fixture row; the isolation and drift suites fail until all are
  present.
- Cross-tenant operations need their own `SECURITY DEFINER` function owned by a dedicated role,
  reviewed as RISKY. The retention functions are the template.
- Operators hold two credentials: the migrator (root-like, deployment only) and the application
  login. Local development mirrors this with `DATABASE_ADMIN_URL` and `DATABASE_URL`.
- Threats, mitigations and the test that proves each are listed in `packages/db/THREATS.md`.
