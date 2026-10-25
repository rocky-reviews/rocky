# ADR 0003 — Multi-tenancy with org_id and Postgres row-level security

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Rocky Cloud stores data from many customers (organisations) in one deployment: PR metadata,
analyses, review drafts, project memory, embeddings, usage and audit events. A leak between
tenants is the worst failure a code-review SaaS can have. Self-hosted installs usually have one
org but use the same code.

## Decision

1. **Tenant = one GitHub App installation** (an org or personal account), stored as `orgs`.
2. **Every tenant-owned table has `org_id uuid NOT NULL`** with `REFERENCES orgs(id) ON DELETE
CASCADE`, so deleting an org removes everything it owns (GDPR erasure, P3-3/L-1).
3. **Postgres row-level security on every tenant table**, policy
   `org_id = current_setting('app.org_id')::uuid`. The application connects as a role that
   cannot bypass RLS (not the table owner, no `BYPASSRLS`).
4. **One tenant-scoped client**: `withOrg(orgId, fn)` opens a transaction, runs
   `set_config('app.org_id', orgId, true)` and passes the transaction to `fn`. Code outside it
   cannot query tenant tables.
5. **Jobs carry `org_id`**; workers enter `withOrg` before touching data and use a GitHub
   installation token scoped to that org.
6. **Isolation is tested in CI**: for every tenant table, org A cannot read, update or delete
   org B's rows (P2-2), including embeddings and memory (P8-4).
7. **Shared infrastructure by default**; Enterprise "cells" (a separate deployment of the same
   code, own database) are a deployment option, not a code path.

## Consequences

- A forgotten `WHERE org_id = …` cannot leak data; the database refuses it.
- Cross-tenant admin tasks (billing reconciliation, ops) need an explicit, audited privileged
  role and path; they are rare and reviewed as RISKY.
- Small overhead per transaction (`set_config`), acceptable for this workload.
