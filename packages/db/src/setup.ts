import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type pg from "pg";
import type { TenantTx } from "./client.js";
import * as schema from "./schema.js";

/**
 * What the setup wizard (P10-2, ADR 0044) asks the database, as the application login. Nothing
 * here needs more than `rocky_app` already has: the catalogue (`pg_extension`, `pg_class`,
 * `pg_attribute`) is readable by every role, and an org's progress is read inside `withOrg`
 * (RLS). Answers are names of Rocky's own tables and counts; never tenant text.
 */

/** Extensions the migrations need (0001 creates `vector` columns). */
export const REQUIRED_EXTENSIONS = ["vector"] as const;

export interface DatabaseSetupCheck {
  /** Required extensions that are not installed in this database. */
  readonly missingExtensions: readonly string[];
  /**
   * `table` or `table.column` for every table and column this release's schema declares that the
   * database does not have: migrations are pending (or ran from an older release).
   */
  readonly missingSchema: readonly string[];
}

const declaredTables = (): { name: string; columns: string[] }[] =>
  Object.values(schema as Record<string, unknown>)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((table) => {
      const config = getTableConfig(table);
      return { name: config.name, columns: config.columns.map((c) => c.name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Compares the database with the schema this release was built for (the Drizzle mirror, which
 * `schema-drift.test.ts` keeps equal to the migrations). Read-only catalogue queries.
 */
export const checkDatabaseSetup = async (
  client: Pick<pg.ClientBase, "query">,
): Promise<DatabaseSetupCheck> => {
  const extensions = await client.query<{ extname: string }>(
    "select extname from pg_catalog.pg_extension where extname = any($1::text[])",
    [[...REQUIRED_EXTENSIONS]],
  );
  const installed = new Set(extensions.rows.map((r) => r.extname));
  const columns = await client.query<{ table_name: string; column_name: string }>(
    `select c.relname as table_name, a.attname as column_name
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and a.attnum > 0 and not a.attisdropped`,
  );
  const present = new Map<string, Set<string>>();
  for (const row of columns.rows) {
    const set = present.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    present.set(row.table_name, set);
  }
  const missingSchema: string[] = [];
  for (const table of declaredTables()) {
    const have = present.get(table.name);
    if (have === undefined) {
      missingSchema.push(table.name);
      continue;
    }
    for (const column of table.columns) {
      if (!have.has(column)) missingSchema.push(`${table.name}.${column}`);
    }
  }
  return {
    missingExtensions: REQUIRED_EXTENSIONS.filter((name) => !installed.has(name)),
    missingSchema,
  };
};

export interface OrgSetupProgress {
  /** Enabled repositories in the mirror. */
  readonly repositories: number;
  readonly pullRequests: number;
  readonly analyses: {
    readonly queued: number;
    readonly running: number;
    readonly awaitingApproval: number;
    readonly done: number;
    readonly failed: number;
  };
  /**
   * The pull request of the most recent finished analysis, to open in Rocky. `fullName` is the
   * forge's `owner/name` (untrusted text: the page renders it as text).
   */
  readonly latestDone: { readonly fullName: string; readonly number: number } | null;
}

/**
 * How far one org has got towards its first analysed pull request. Runs inside the caller's
 * `withOrg`; the explicit org filters are defence in depth, as elsewhere.
 */
export const loadOrgSetupProgress = async (tx: TenantTx): Promise<OrgSetupProgress> => {
  const counts = await tx.query<{
    repositories: string;
    pull_requests: string;
    queued: string;
    running: string;
    awaiting_approval: string;
    done: string;
    failed: string;
  }>(
    `select
       (select count(*) from repos where org_id = $1 and enabled) as repositories,
       (select count(*) from pull_requests where org_id = $1) as pull_requests,
       count(*) filter (where a.status = 'queued') as queued,
       count(*) filter (where a.status = 'running') as running,
       count(*) filter (where a.status = 'awaiting_approval') as awaiting_approval,
       count(*) filter (where a.status = 'done') as done,
       count(*) filter (where a.status = 'failed') as failed
     from analyses a where a.org_id = $1`,
    [tx.orgId],
  );
  const latest = await tx.query<{ full_name: string; number: number }>(
    `select r.full_name, p.number
       from analyses a
       join pr_revisions v on v.id = a.revision_id and v.org_id = a.org_id
       join pull_requests p on p.id = v.pull_request_id and p.org_id = a.org_id
       join repos r on r.id = p.repo_id and r.org_id = a.org_id
      where a.org_id = $1 and a.status = 'done'
      order by a.completed_at desc nulls last, a.created_at desc
      limit 1`,
    [tx.orgId],
  );
  const row = counts.rows[0];
  const n = (value: string | undefined): number => Number(value ?? 0);
  const done = latest.rows[0];
  return {
    repositories: n(row?.repositories),
    pullRequests: n(row?.pull_requests),
    analyses: {
      queued: n(row?.queued),
      running: n(row?.running),
      awaitingApproval: n(row?.awaiting_approval),
      done: n(row?.done),
      failed: n(row?.failed),
    },
    latestDone: done === undefined ? null : { fullName: done.full_name, number: done.number },
  };
};
