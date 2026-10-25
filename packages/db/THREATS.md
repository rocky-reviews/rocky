# Threat model: data layer (P2-1, P2-2, P2-5, P2-6)

Companion to [ADR 0003 tenancy](../../docs/adr/0003-tenancy.md) and
[ADR 0005 migrations and roles](../../docs/adr/0005-migrations-and-roles.md). Each row names the
test that proves the control; the tests live next to the code in `src/*.test.ts` and run in CI
against a real Postgres (Testcontainers, same pgvector image digest as `docker-compose.dev.yml`).

## Assets

- Tenant data: PR metadata, analyses, review drafts, memory, embeddings, usage (`public.*`).
- Encrypted secrets: wrapped org data keys, user forge tokens, BYOK keys (`*_ciphertext`).
- The audit trail (`audit_events`): evidence that must survive a compromised application.
- Database credentials: `rocky_app` (application), the migrator/owner, `rocky_retention`.

## Attackers

- Another tenant driving the application through normal requests, or through a bug that
  forgets `WHERE org_id = …`, concatenates SQL, or passes an attacker-controlled org id.
- Malicious PR content (titles, file paths, comments) that ends up in SQL parameters or
  `jsonb` columns and later in prompts (handled in P4; here it is only data).
- An attacker holding the application's database credentials (server or worker compromise).
- An operator mistake: running ad-hoc SQL with the wrong role, or a migration that forgets
  RLS on a new table.

## What can go wrong, how it is prevented, how it is tested

| #   | Threat                                                                                     | Prevention                                                                                                                                                                                                                                                         | Test                                                                                                |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| T1  | Query without `WHERE org_id` returns every tenant's rows                                   | RLS policy `org_id = app.current_org_id()` on every tenant table, `FORCE ROW LEVEL SECURITY` so the owner is covered too                                                                                                                                           | `isolation.test.ts` "no WHERE clause"                                                               |
| T2  | Query with an explicit foreign `org_id` reads, updates or deletes another tenant's rows    | Same policy: rows of other orgs do not exist for the session; `UPDATE`/`DELETE` affect 0 rows                                                                                                                                                                      | `isolation.test.ts` "explicit org_id", "update", "delete"                                           |
| T3  | `UPDATE … SET org_id = <other>` or `INSERT` with a foreign `org_id` moves data across orgs | Policy `WITH CHECK (org_id = app.current_org_id())`; Postgres evaluates it before constraints, so no existence leak either                                                                                                                                         | `isolation.test.ts` "move row", "insert foreign org_id"                                             |
| T4  | Child row references another tenant's parent (`repo_id` of org B under org A)              | Composite foreign keys `(org_id, parent_id) REFERENCES parent (org_id, id)` on every child table                                                                                                                                                                   | `isolation.test.ts` "cross-tenant parent reference"                                                 |
| T5  | Missing, empty or garbage `app.org_id` falls back to "all rows"                            | `app.current_org_id()` returns NULL for missing/empty (no row matches); a non-uuid value raises an error (fail closed)                                                                                                                                             | `isolation.test.ts` "no context", "empty", "garbage"                                                |
| T6  | A stale session-level `SET app.org_id` on a pooled connection leaks into later queries     | `withOrg` resets the session value before `BEGIN`, then uses `set_config(…, true)` (transaction-local); the raw pool is never exported, so no code outside `withOrg` can query tenant tables through this package                                                  | `client.test.ts` "stale session value", `isolation.test.ts` "SET outside withOrg"                   |
| T7  | Code inside `withOrg(A)` switches tenant with `set_config('app.org_id', B, true)`          | Before `COMMIT`, `withOrg` re-reads `app.org_id`; a mismatch rolls the transaction back and throws `TenantContextError`                                                                                                                                            | `client.test.ts` "tenant switch inside the transaction"                                             |
| T8  | Nested `withOrg(B)` inside `withOrg(A)` mixes contexts on one connection                   | Nesting with a different org throws before touching the database; same org reuses the transaction via a savepoint                                                                                                                                                  | `client.test.ts` "nested"                                                                           |
| T9  | The application role bypasses RLS (owner, `BYPASSRLS`, superuser, `SET ROLE`)              | `rocky_app` is `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, owns nothing, is not a member of any privileged role; tables are owned by the migrator; `FORCE` on every table                                                                           | `isolation.test.ts` "app role attributes", "cannot SET ROLE", "cannot disable RLS or drop policies" |
| T10 | A new table lands without RLS, `org_id`, or the cascade FK                                 | The isolation suite enumerates `pg_class`, allow-lists exactly `app.schema_migrations`, and asserts RLS + FORCE + policy + `org_id NOT NULL` + FK `ON DELETE CASCADE` for everything else; a fixture entry is required per table, so an undescribed table fails    | `isolation.test.ts` "every table"                                                                   |
| T11 | Plaintext secrets stored in the database                                                   | Only `bytea *_ciphertext` + `integer *_key_version` columns exist; a check constraint keeps them paired; a schema test rejects any column whose name suggests a token/key/password that is not a ciphertext or version column                                      | `isolation.test.ts` "no plaintext secret columns"                                                   |
| T12 | Audit rows altered or removed by the application, or by the owner by mistake               | `BEFORE UPDATE OR DELETE` row trigger and `BEFORE TRUNCATE` statement trigger raise `insufficient_privilege` unless `current_user = rocky_retention`; `rocky_app` has no `UPDATE/DELETE/TRUNCATE` privilege on top of that                                         | `audit.test.ts` "update/delete/truncate blocked (app and owner)"                                    |
| T13 | The retention path becomes a general bypass for deleting audit evidence                    | Purge is a `SECURITY DEFINER` function owned by `rocky_retention`, a `NOLOGIN` role that owns only the `retention` schema; the function deletes only rows older than a cutoff, and refuses cutoffs newer than `AUDIT_MIN_RETENTION_DAYS` (30) regardless of config | `audit.test.ts` "purge floor", `retention.test.ts`                                                  |
| T14 | Retention deletes the wrong rows (boundary, clock)                                         | Cutoff computed from an injected `Clock`; a row is expired iff `created_at < cutoff` (strictly older); the SQL and the TypeScript agree on `<`                                                                                                                     | `retention.test.ts` time-travel test with rows just inside and outside the boundary                 |
| T15 | Retention purge is invisible                                                               | Every purge writes one `retention.purged` audit event per affected org with the table, count and cutoff                                                                                                                                                            | `retention.test.ts` "audits the purge"                                                              |
| T16 | Audit metadata used to smuggle code, diffs or secrets into the audit trail                 | `audit()` caps metadata at 4 KiB of JSON and validates `action` against a strict pattern; callers pass identifiers only (documented)                                                                                                                               | `audit.test.ts` "rejects oversized metadata"                                                        |
| T17 | A migration applied twice, half-applied, or concurrently by two deployers                  | Each migration runs in its own transaction with an advisory lock; the ledger `app.schema_migrations` records versions; down migrations exist and are exercised                                                                                                     | `migrate.test.ts` up → down → up, idempotent re-run                                                 |
| T18 | Drizzle schema drifts from the SQL migrations                                              | A test compares every Drizzle table/column (name, nullability) with `information_schema`                                                                                                                                                                           | `schema-drift.test.ts`                                                                              |
| T19 | Invalid `orgId` (not a uuid) reaches `set_config`                                          | `withOrg` validates the uuid shape before opening a transaction                                                                                                                                                                                                    | `client.test.ts` "rejects non-uuid"                                                                 |

## Residual risks (accepted, documented)

- The migrator/owner role can disable triggers and policies; it is a deployment credential,
  never given to the application (ADR 0005). Operators must treat it like a root credential.
- Code running inside `withOrg(A)` holds a transaction and could read B's rows between a crafted
  `set_config` and the commit-time check (T7). The check still prevents committed writes. The
  defence is that all SQL in this repository is parameterised (`pg` rejects multi-statement
  parameterised queries) and reviewed; the tenant id never comes from request input without
  authorisation (P3-6).
- `orgs (forge, installation_id)` is globally unique, so a tenant could learn whether an
  installation id exists by attempting an insert. Installation ids are not secret.
- Application logs are not in the database; "logs" retention here means finished `jobs` rows.
  Pino log retention is a hosting concern (P2-4, infra).
