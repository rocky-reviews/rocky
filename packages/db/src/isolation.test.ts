import type { OrgId } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { APP_ROLE, LIFECYCLE_ROLE, RETENTION_ROLE, WORKER_ROLE } from "./roles.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  TEST_ROLES,
  type SeededOrg,
  ignoreIdleError,
} from "./testing/index.js";

/**
 * P2-2 isolation suite. Tables are enumerated from pg_catalog, not from a list in this file, so a
 * new table that lacks RLS, org_id, the cascade FK or a fixture row fails here.
 */

/**
 * The only non-tenant tables allowed to exist (migrator-owned, in `app`). Everything else is a
 * tenant table. The webhook inbox precedes orgs (ADR 0007); webhooks.test.ts covers it. The
 * erasure record outlives its org by design (ADR 0009); deletion.test.ts covers it.
 */
const ALLOWED_NON_TENANT_TABLES = [
  "app.org_deletions",
  "app.retention_settings",
  "app.schema_migrations",
  "app.webhook_deliveries",
  // The claim queue (review round 3): one row per installation lane with pending work; ids only.
  "app.webhook_queue",
];

/**
 * SECURITY DEFINER functions the application role may execute (ADR 0005 §5): the period-bounded
 * purges. Erasure moved to the worker in P3-3 (ADR 0009).
 */
const ALLOWED_SECURITY_DEFINER = [
  "retention.purge_analyses",
  "retention.purge_audit_events",
  "retention.purge_jobs",
  "retention.purge_llm_usage",
  "retention.purge_webhook_deliveries",
];

/** What a worker login (rocky_app + rocky_worker) may execute on top (ADR 0009). */
const ALLOWED_WORKER_SECURITY_DEFINER = [
  ...ALLOWED_SECURITY_DEFINER,
  "retention.delete_org",
  "retention.orgs_due_for_deletion",
  // The analysis queue's claim (P4-6, migration 0012, ADR 0017): cross-tenant, worker only.
  "worker.claim_analyses",
  "worker.claim_webhook_deliveries",
  "worker.complete_webhook_delivery",
  "worker.fail_webhook_delivery",
  "worker.installation_orgs",
].sort();

/**
 * Every privilege `rocky_app` holds, per relation (final review #2). A stray grant anywhere,
 * or a new relation without an entry here, fails the matrix test.
 */
const DML = ["DELETE", "INSERT", "SELECT", "UPDATE"];
const APP_TABLE_PRIVILEGES: Record<string, string[]> = {
  // The erasure record is not the application's: only retention.delete_org writes it.
  "app.org_deletions": [],
  "app.retention_settings": ["SELECT"],
  "app.schema_migrations": [],
  // Insert-only: the receiver records deliveries; it can neither read nor remove them (ADR 0007).
  "app.webhook_deliveries": ["INSERT"],
  // The claim queue is the worker functions' alone (its triggers run as rocky_lifecycle).
  "app.webhook_queue": [],
  "public.analyses": DML,
  "public.audit_events": ["INSERT", "SELECT"],
  "public.audit_events_id_seq": [],
  "public.comments_pending": DML,
  "public.embeddings": DML,
  "public.findings_state": DML,
  "public.jobs": DML,
  // Append-only and written by the worker (P4-5, migration 0011): the server only reads it.
  "public.llm_usage": ["SELECT"],
  "public.llm_usage_id_seq": [],
  "public.members": DML,
  "public.memory_entries": DML,
  // The tenant root is never deleted by the application; only retention.delete_org removes it.
  // Only the worker creates it (rocky_worker, below; ADR 0009). Since review round 1 (H1) the
  // app updates only the columns in ORGS_COLUMN_PRIVILEGES, never the identity or the schedule.
  "public.orgs": ["SELECT"],
  "public.pr_revisions": DML,
  "public.pull_requests": DML,
  "public.repos": DML,
};

/**
 * The only column-level grants in the database (review round 1, H1): who may UPDATE which
 * columns of `orgs`. The server writes settings and its encrypted keys; the deletion schedule,
 * the installation binding, the installer and the display fields are the worker's.
 */
const ORGS_COLUMN_PRIVILEGES = [
  "rocky_app:UPDATE:data_key_ciphertext",
  "rocky_app:UPDATE:data_key_version",
  "rocky_app:UPDATE:llm_api_key_ciphertext",
  "rocky_app:UPDATE:llm_api_key_version",
  "rocky_app:UPDATE:settings",
  "rocky_app:UPDATE:updated_at",
  "rocky_worker:UPDATE:delete_after",
  "rocky_worker:UPDATE:erasing_at",
  "rocky_worker:UPDATE:installation_id",
  "rocky_worker:UPDATE:installer_forge_user_id",
  "rocky_worker:UPDATE:kind",
  "rocky_worker:UPDATE:login",
  "rocky_worker:UPDATE:updated_at",
];

/**
 * The analysis claim (P4-6, migration 0012) reads and updates exactly the queue columns of
 * `analyses`, as rocky_lifecycle; never a document, the units, the estimate or an approval
 * (review round 1, N1: no table-level SELECT).
 */
const ANALYSES_COLUMN_PRIVILEGES = [
  "rocky_lifecycle:SELECT:attempts",
  "rocky_lifecycle:SELECT:available_at",
  "rocky_lifecycle:SELECT:claimed_at",
  "rocky_lifecycle:SELECT:created_at",
  "rocky_lifecycle:SELECT:error_code",
  "rocky_lifecycle:SELECT:id",
  "rocky_lifecycle:SELECT:lease_id",
  "rocky_lifecycle:SELECT:lease_until",
  "rocky_lifecycle:SELECT:org_id",
  "rocky_lifecycle:SELECT:status",
  "rocky_lifecycle:UPDATE:attempts",
  "rocky_lifecycle:UPDATE:available_at",
  "rocky_lifecycle:UPDATE:claimed_at",
  "rocky_lifecycle:UPDATE:completed_at",
  "rocky_lifecycle:UPDATE:error_code",
  "rocky_lifecycle:UPDATE:lease_id",
  "rocky_lifecycle:UPDATE:lease_until",
  "rocky_lifecycle:UPDATE:status",
];

/**
 * Privileges held directly by the two P3-3 roles (ADR 0009); every relation not listed holds
 * none. rocky_worker adds exactly one table privilege to what a worker login inherits from
 * rocky_app; rocky_lifecycle owns the worker functions and reads/updates exactly what they need.
 */
const ROLE_TABLE_PRIVILEGES: Record<string, Record<string, string[]>> = {
  [WORKER_ROLE]: { "public.llm_usage": ["INSERT"], "public.orgs": ["INSERT"] },
  [LIFECYCLE_ROLE]: {
    "app.webhook_deliveries": ["SELECT", "UPDATE"],
    "app.webhook_queue": ["DELETE", "INSERT", "SELECT", "UPDATE"],
    "public.orgs": ["SELECT"],
  },
};

/**
 * pg_catalog functions that execute caller-supplied SQL text through SPI. A `set_config` hidden
 * inside their string argument is invisible to the statement guard and would switch tenant for
 * the rest of the transaction, so provisioning revokes EXECUTE from PUBLIC (final review #1).
 */
const SPI_FUNCTIONS = [
  "pg_catalog.query_to_xml(text, boolean, boolean, text)",
  "pg_catalog.query_to_xmlschema(text, boolean, boolean, text)",
  "pg_catalog.query_to_xml_and_xmlschema(text, boolean, boolean, text)",
  "pg_catalog.ts_stat(text)",
  "pg_catalog.ts_stat(text, text)",
  "pg_catalog.ts_rewrite(tsquery, text)",
];

const INSUFFICIENT_PRIVILEGE = "42501";
const FOREIGN_KEY_VIOLATION = "23503";
const INVALID_TEXT_REPRESENTATION = "22P02";

interface TenantTable {
  schema: string;
  name: string;
  /** `org_id`, or `id` for `orgs` itself. */
  tenantColumn: string;
  hasIdentity: boolean;
  qualified: string;
}

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let appPool: pg.Pool;
let workerPool: pg.Pool;
let db: Db;
let tables: TenantTable[];
let a: SeededOrg;
let b: SeededOrg;

const pgError = async (promise: Promise<unknown>): Promise<pg.DatabaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error("expected the query to fail");
};

beforeAll(async () => {
  pgs = await startPostgres();
  appPool = new pg.Pool({ connectionString: pgs.appUrl, max: 2 }).on("error", ignoreIdleError);
  workerPool = new pg.Pool({ connectionString: pgs.workerUrl, max: 1 }).on(
    "error",
    ignoreIdleError,
  );
  db = createDb({ pool: appPool });

  const { rows } = await pgs.migrator.query<{
    schema: string;
    name: string;
    columns: string[];
    has_identity: boolean;
  }>(
    `select n.nspname as schema, c.relname as name,
            array(select a.attname::text from pg_attribute a
                   where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
            exists(select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attidentity <> '') as has_identity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
      order by n.nspname, c.relname`,
  );
  tables = rows
    .filter((r) => !ALLOWED_NON_TENANT_TABLES.includes(`${r.schema}.${r.name}`))
    .map((r) => ({
      schema: r.schema,
      name: r.name,
      tenantColumn: r.name === "orgs" ? "id" : "org_id",
      hasIdentity: r.has_identity,
      qualified: `"${r.schema}"."${r.name}"`,
    }));

  [a, b] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 1 }),
    await seedOrg(w, newOrgId(), { installationId: 2 }),
  ]);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await workerPool?.end();
  await pgs?.stop();
});

const table = (name: string): TenantTable => {
  const found = tables.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tenant table ${name}`);
  return found;
};

const countAs = async (orgId: OrgId, table: TenantTable, where = ""): Promise<number> =>
  db.withOrg(orgId, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(
      `select count(*)::text as n from ${table.qualified} ${where}`,
    );
    return Number(rows[0]?.n);
  });

describe("every table in the database", () => {
  it("is a tenant table in public (only the ledger, retention settings, webhook inbox and erasure record are exempt)", () => {
    expect(tables.length).toBeGreaterThanOrEqual(13);
    for (const t of tables) expect(t.schema).toBe("public");
    const names = tables.map((t) => t.name);
    for (const required of [
      "orgs",
      "members",
      "repos",
      "pull_requests",
      "pr_revisions",
      "analyses",
      "findings_state",
      "comments_pending",
      "memory_entries",
      "embeddings",
      "audit_events",
      "llm_usage",
      "jobs",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("has RLS enabled and forced, and a policy for the app role", async () => {
    for (const t of tables) {
      const { rows } = await pgs.migrator.query<{ rls: boolean; forced: boolean; owner: string }>(
        `select relrowsecurity as rls, relforcerowsecurity as forced, relowner::regrole::text as owner
           from pg_class where oid = $1::regclass`,
        [t.qualified],
      );
      expect(rows[0], t.name).toEqual({ rls: true, forced: true, owner: TEST_ROLES.migrator });
      const policies = await pgs.migrator.query<{
        roles: string[];
        cmd: string;
        permissive: string;
      }>(
        "select roles::text[] as roles, cmd, permissive from pg_policies where schemaname = $1 and tablename = $2",
        [t.schema, t.name],
      );
      const forApp = policies.rows.filter((p) => p.roles.includes(APP_ROLE));
      expect(
        forApp.filter((p) => p.permissive === "PERMISSIVE").map((p) => p.cmd),
        t.name,
      ).toEqual(["ALL"]);
      // orgs additionally carries a restrictive "never" DELETE policy for the app role (final
      // review #2): the tenant root is only removed through retention.delete_org.
      expect(
        forApp.filter((p) => p.permissive === "RESTRICTIVE").map((p) => p.cmd),
        t.name,
      ).toEqual(t.name === "orgs" ? ["DELETE"] : []);
      // No policy grants the app role anything beyond the tenant policy, and PUBLIC gets none.
      for (const p of policies.rows) expect(p.roles, t.name).not.toContain("public");
    }
  });

  it("has a NOT NULL uuid tenant column with a cascading FK to orgs", async () => {
    for (const t of tables) {
      const col = await pgs.migrator.query<{ data_type: string; is_nullable: string }>(
        `select data_type, is_nullable from information_schema.columns
          where table_schema = $1 and table_name = $2 and column_name = $3`,
        [t.schema, t.name, t.tenantColumn],
      );
      expect(col.rows[0], `${t.name}.${t.tenantColumn}`).toEqual({
        data_type: "uuid",
        is_nullable: "NO",
      });
      if (t.name === "orgs") continue;
      const fk = await pgs.migrator.query<{ confdeltype: string }>(
        `select confdeltype from pg_constraint
          where conrelid = $1::regclass and contype = 'f' and confrelid = 'public.orgs'::regclass
            and conkey = array[(select attnum from pg_attribute where attrelid = $1::regclass and attname = 'org_id')]`,
        [t.qualified],
      );
      expect(
        fk.rows.map((r) => r.confdeltype),
        `${t.name} FK to orgs`,
      ).toEqual(["c"]);
    }
  });

  it("references parents only through composite (org_id, id) foreign keys", async () => {
    const { rows } = await pgs.migrator.query<{ table: string; cols: string[] }>(
      `select conrelid::regclass::text as "table",
              array(select attname::text from pg_attribute where attrelid = conrelid and attnum = any(conkey)) as cols
         from pg_constraint
        where contype = 'f' and connamespace = 'public'::regnamespace and confrelid <> 'public.orgs'::regclass`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const fk of rows) expect(fk.cols, fk.table).toContain("org_id");
  });

  it("received exactly one fixture row per org (so every table is exercised below)", async () => {
    for (const t of tables) {
      expect(await countAs(a.orgId, t), t.name).toBe(1);
      expect(await countAs(b.orgId, t), t.name).toBe(1);
    }
  });

  it("has no plaintext secret columns", async () => {
    const { rows } = await pgs.migrator.query<{ table: string; column: string; type: string }>(
      `select table_name as "table", column_name as "column", data_type as type
         from information_schema.columns where table_schema = 'public'
          and column_name ~* '(token|secret|api_key|password|credential)'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const c of rows) {
      // Ciphertext, a key version, or a numeric count (input_tokens): nothing that holds text.
      const ok =
        (c.column.endsWith("_ciphertext") && c.type === "bytea") ||
        (c.column.endsWith("_key_version") && c.type === "integer") ||
        (c.column.endsWith("_tokens") && c.type === "integer");
      expect(ok, `${c.table}.${c.column} (${c.type})`).toBe(true);
    }
  });
});

describe("org A against org B's rows, per table", () => {
  it("select without WHERE sees only its own row", async () => {
    for (const t of tables) {
      const rows = await db.withOrg(
        a.orgId,
        async (tx) =>
          (await tx.query<Record<string, unknown>>(`select * from ${t.qualified}`)).rows,
      );
      expect(
        rows.map((r) => r[t.tenantColumn]),
        t.name,
      ).toEqual([a.orgId]);
    }
  });

  it("select with an explicit foreign org_id returns nothing", async () => {
    for (const t of tables) {
      expect(await countAs(a.orgId, t, `where "${t.tenantColumn}" = '${b.orgId}'`), t.name).toBe(0);
      expect(await countAs(a.orgId, t, `where "${t.tenantColumn}" <> '${a.orgId}'`), t.name).toBe(
        0,
      );
    }
  });

  it("update of foreign rows affects nothing and leaves them unchanged", async () => {
    for (const t of tables) {
      // Append-only: covered in audit.test.ts and usage.test.ts.
      if (t.name === "audit_events" || t.name === "llm_usage") continue;
      // The app may not update orgs.id at all (column grants, review round 1 H1): touch a column
      // it may write instead, so this still proves RLS hides the foreign row.
      const set = t.name === "orgs" ? "settings" : t.tenantColumn;
      const affected = await db.withOrg(a.orgId, async (tx) => {
        const r = await tx.query(
          `update ${t.qualified} set "${set}" = "${set}" where "${t.tenantColumn}" = $1`,
          [b.orgId],
        );
        return r.rowCount;
      });
      expect(affected, t.name).toBe(0);
      const unconditional = await db.withOrg(a.orgId, async (tx) => {
        const r = await tx.query(`update ${t.qualified} set "${set}" = "${set}"`);
        return r.rowCount;
      });
      expect(unconditional, t.name).toBe(1);
      expect(await countAs(b.orgId, t), t.name).toBe(1);
    }
  });

  it("update that moves an own row to another org is refused", async () => {
    for (const t of tables) {
      if (t.name === "audit_events") continue;
      const error = await pgError(
        db.withOrg(a.orgId, (tx) =>
          tx.query(`update ${t.qualified} set "${t.tenantColumn}" = $1`, [b.orgId]),
        ),
      );
      expect(error.code, t.name).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await countAs(a.orgId, t), t.name).toBe(1);
      expect(await countAs(b.orgId, t), t.name).toBe(1);
    }
  });

  it("insert of a row with a foreign org_id is refused", async () => {
    for (const t of tables) {
      // Copy the own row with the tenant column replaced; RLS WITH CHECK runs before any
      // constraint, so the refusal is the policy, not a duplicate key.
      const override = JSON.stringify({ [t.tenantColumn]: b.orgId });
      const overriding = t.hasIdentity ? "overriding system value" : "";
      const error = await pgError(
        db.withOrg(a.orgId, (tx) =>
          tx.query(
            `insert into ${t.qualified} ${overriding}
             select (json_populate_record(r, $1::json)).* from ${t.qualified} r`,
            [override],
          ),
        ),
      );
      expect(error.code, t.name).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await countAs(b.orgId, t), t.name).toBe(1);
    }
  });

  it("delete of foreign rows affects nothing", async () => {
    for (const t of tables) {
      if (t.name === "audit_events" || t.name === "llm_usage") continue;
      if (t.name === "orgs") {
        // No DELETE privilege at all on the tenant root (final review #2; deletion.test.ts).
        const error = await pgError(
          db.withOrg(a.orgId, (tx) => tx.query("delete from orgs where id = $1", [b.orgId])),
        );
        expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
        expect(await countAs(b.orgId, t), t.name).toBe(1);
        continue;
      }
      const affected = await db.withOrg(a.orgId, async (tx) => {
        const r = await tx.query(`delete from ${t.qualified} where "${t.tenantColumn}" = $1`, [
          b.orgId,
        ]);
        return r.rowCount;
      });
      expect(affected, t.name).toBe(0);
      expect(await countAs(b.orgId, t), t.name).toBe(1);
    }
  });

  it("cannot reference another org's parent row (composite FK)", async () => {
    const error = await pgError(
      db.withOrg(a.orgId, (tx) =>
        tx.query(
          `insert into pull_requests (repo_id, number, title, state, head_sha, base_sha, opened_at)
           values ($1, 1, 't', 'open', repeat('c', 40), repeat('d', 40), now())`,
          [b.repoId],
        ),
      ),
    );
    expect(error.code).toBe(FOREIGN_KEY_VIOLATION);
    const members = await pgError(
      db.withOrg(a.orgId, (tx) =>
        tx.query(
          `insert into comments_pending (pull_request_id, revision_id, author_id, body) values ($1, $2, $3, 'x')`,
          [a.pullRequestId, a.revisionId, b.memberId],
        ),
      ),
    );
    expect(members.code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("cannot see another org's rows through a join or a subquery", async () => {
    const rows = await db.withOrg(
      a.orgId,
      async (tx) =>
        (
          await tx.query<{ n: string }>(
            `select count(*)::text as n from repos r
             left join pull_requests p on p.repo_id = r.id
            where r.id in (select repo_id from pull_requests) or r.org_id in (select id from orgs)`,
          )
        ).rows,
    );
    expect(rows[0]?.n).toBe("1");
  });
});

describe("tenant context outside and around withOrg", () => {
  it("returns zero rows with no app.org_id, an empty one, or after RESET", async () => {
    for (const t of tables) {
      const none = await appPool.query(`select * from ${t.qualified}`);
      expect(none.rowCount, t.name).toBe(0);
    }
    await appPool.query("set app.org_id = ''");
    expect((await appPool.query("select * from repos")).rowCount).toBe(0);
    await appPool.query("reset app.org_id");
    expect((await appPool.query("select * from repos")).rowCount).toBe(0);
  });

  it("fails closed on a non-uuid app.org_id instead of widening the filter", async () => {
    const client = await appPool.connect();
    try {
      await client.query("set app.org_id = 'garbage'");
      const error = await pgError(client.query("select * from repos"));
      expect(error.code).toBe(INVALID_TEXT_REPRESENTATION);
      await client.query("reset app.org_id");
    } finally {
      client.release();
    }
  });

  it("a session-level SET outside withOrg does not survive the next withOrg", async () => {
    const client = await appPool.connect();
    try {
      await client.query("select set_config('app.org_id', $1, false)", [b.orgId]);
      expect((await client.query("select org_id from repos")).rows).toEqual([{ org_id: b.orgId }]);
    } finally {
      client.release();
    }
    // The pool has 2 connections; drain both through withOrg so each is reset.
    await Promise.all([
      db.withOrg(a.orgId, (tx) => tx.query("select 1")),
      db.withOrg(a.orgId, (tx) => tx.query("select 1")),
    ]);
    const after = await Promise.all([
      appPool.query("select org_id from repos"),
      appPool.query("select org_id from repos"),
    ]);
    for (const r of after) expect(r.rowCount).toBe(0);
  });

  it("nested withOrg for another org is refused and does not change what the outer sees", async () => {
    const seen = await db.withOrg(a.orgId, async (outer) => {
      await expect(db.withOrg(b.orgId, (tx) => tx.query("select 1"))).rejects.toThrow(/nested/);
      return (await outer.query<{ org_id: string }>("select org_id from repos")).rows;
    });
    expect(seen).toEqual([{ org_id: a.orgId }]);
  });
});

describe("the application role", () => {
  it("is not superuser, cannot bypass RLS, owns nothing, and inherits no privileged role", async () => {
    const role = await appPool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
    }>("select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = current_user");
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
    const groups = await appPool.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      `select r.rolname, r.rolbypassrls, r.rolsuper from pg_roles r
        where pg_has_role(current_user, r.oid, 'MEMBER') and r.rolname <> current_user`,
    );
    expect(groups.rows.map((g) => g.rolname)).toEqual([APP_ROLE]);
    for (const g of groups.rows) expect(g).toMatchObject({ rolbypassrls: false, rolsuper: false });
    const owned = await appPool.query(
      "select relname from pg_class where relowner in (select oid from pg_roles where pg_has_role(current_user, oid, 'MEMBER'))",
    );
    expect(owned.rowCount).toBe(0);
  });

  it("cannot assume the retention role, alter RLS, drop policies or create tables", async () => {
    for (const sql of [
      `set role ${RETENTION_ROLE}`,
      "alter table repos disable row level security",
      "alter table repos no force row level security",
      "drop policy repos_tenant on repos",
      "create table public.leak (id int)",
      "create policy p on repos for all to public using (true)",
      "alter table audit_events disable trigger all",
    ]) {
      const error = await pgError(appPool.query(sql));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("cannot create temporary tables or functions, which could shadow names on pooled connections (review #7)", async () => {
    for (const sql of [
      "create temp table leak (id int)",
      "create temporary table leak2 as select 1 as x",
      "create function pg_temp.repos() returns setof repos language sql as 'select * from repos'",
    ]) {
      const error = await pgError(appPool.query(sql));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const priv = await appPool.query<{ app: boolean; pub: boolean }>(
      `select has_database_privilege($1, current_database(), 'TEMP') as app,
              has_database_privilege(0, current_database(), 'TEMP') as pub`,
      [APP_ROLE],
    );
    expect(priv.rows[0]).toEqual({ app: false, pub: false });
  });
});

describe("other catalog objects (review #8)", () => {
  it("views and materialized views run as the invoker or are not granted to the app role", async () => {
    const { rows } = await pgs.migrator.query<{
      name: string;
      options: string[] | null;
      granted: boolean;
    }>(
      `select n.nspname || '.' || c.relname as name, c.reloptions as options,
              has_table_privilege($1, c.oid, 'SELECT') as granted
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('v', 'm')
          and n.nspname not in ('pg_catalog', 'information_schema')`,
      [APP_ROLE],
    );
    for (const v of rows) {
      const invoker = (v.options ?? []).includes("security_invoker=true");
      expect(invoker || !v.granted, v.name).toBe(true);
    }
  });

  it("SECURITY DEFINER functions executable by the app role are exactly the retention allow-list", async () => {
    const executable = async (role: string) =>
      (
        await pgs.migrator.query<{ name: string }>(
          `select n.nspname || '.' || p.proname as name
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where p.prosecdef
              and n.nspname not in ('pg_catalog', 'information_schema')
              and has_function_privilege($1, p.oid, 'EXECUTE')
            order by 1`,
          [role],
        )
      ).rows.map((r) => r.name);
    expect(await executable(APP_ROLE)).toEqual(ALLOWED_SECURITY_DEFINER);
    // The server's login reaches exactly the same; the worker's login the worker allow-list.
    expect(await executable(TEST_ROLES.app)).toEqual(ALLOWED_SECURITY_DEFINER);
    expect(await executable(TEST_ROLES.worker)).toEqual(ALLOWED_WORKER_SECURITY_DEFINER);
    // And none of them is reachable by PUBLIC.
    const pub = await pgs.migrator.query<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
          and has_function_privilege(0, p.oid, 'EXECUTE')`,
    );
    expect(pub.rows).toEqual([]);
    // Each SECURITY DEFINER function is owned by its dedicated NOLOGIN role and pins search_path.
    const owners = await pgs.migrator.query<{ name: string; owner: string; config: string[] }>(
      `select n.nspname || '.' || p.proname as name, p.proowner::regrole::text as owner,
              coalesce(p.proconfig, '{}') as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
        order by 1`,
    );
    for (const f of owners.rows) {
      expect(f.owner, f.name).toBe(f.name.startsWith("worker.") ? LIFECYCLE_ROLE : RETENTION_ROLE);
      expect(f.config, f.name).toContain("search_path=pg_catalog");
    }
  });

  it("the P3-3 roles hold exactly their listed privileges, and never log in (ADR 0009)", async () => {
    for (const [role, expected] of Object.entries(ROLE_TABLE_PRIVILEGES)) {
      const { rows } = await pgs.migrator.query<{ name: string; privs: string[] }>(
        `select n.nspname || '.' || c.relname as name,
                array(select privilege_type from aclexplode(c.relacl) where grantee = $1::regrole order by 1) as privs
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
            and n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
          order by 1`,
        [role],
      );
      const held = Object.fromEntries(
        rows.filter((r) => r.privs.length > 0).map((r) => [r.name, r.privs]),
      );
      expect(held, role).toEqual(expected);
      const attrs = await pgs.migrator.query(
        `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
           from pg_roles where rolname = $1`,
        [role],
      );
      expect(attrs.rows[0], role).toEqual({
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
    }
  });

  it("a worker login is a member of rocky_app and rocky_worker only, and owns nothing", async () => {
    const groups = await workerPool.query<{ rolname: string }>(
      `select r.rolname from pg_roles r
        where pg_has_role(current_user, r.oid, 'MEMBER') and r.rolname <> current_user
        order by 1`,
    );
    expect(groups.rows.map((g) => g.rolname)).toEqual([APP_ROLE, WORKER_ROLE]);
    const owned = await workerPool.query(
      "select relname from pg_class where relowner in (select oid from pg_roles where pg_has_role(current_user, oid, 'MEMBER'))",
    );
    expect(owned.rowCount).toBe(0);
    for (const sql of [
      `set role ${LIFECYCLE_ROLE}`,
      `set role ${RETENTION_ROLE}`,
      "select * from app.webhook_deliveries",
      "update app.webhook_deliveries set processed_at = now()",
      "delete from app.webhook_deliveries",
      "delete from orgs",
    ]) {
      const error = await pgError(workerPool.query(sql));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("has no default ACLs that could grant future objects automatically", async () => {
    const { rows } = await pgs.migrator.query<{ n: string }>(
      "select count(*)::text as n from pg_default_acl",
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("holds exactly the expected privileges on every relation, and PUBLIC holds none (final review #2)", async () => {
    const { rows } = await pgs.migrator.query<{
      name: string;
      kind: string;
      app: string[];
      pub: string[];
      column_acls: string;
    }>(
      `select n.nspname || '.' || c.relname as name, c.relkind as kind,
              array(select privilege_type from aclexplode(c.relacl) where grantee = $1::regrole order by 1) as app,
              array(select privilege_type from aclexplode(c.relacl) where grantee = 0 order by 1) as pub,
              (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attacl is not null)::text as column_acls
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname not like 'pg_toast%'
        order by 1`,
      [APP_ROLE],
    );
    const actual = Object.fromEntries(rows.map((r) => [r.name, r.app]));
    expect(actual).toEqual(APP_TABLE_PRIVILEGES);
    for (const r of rows) {
      expect(r.pub, `${r.name} granted to PUBLIC`).toEqual([]);
      // The matrix above is the whole story: no column-level grants widen or narrow it, except
      // the orgs and analyses UPDATE columns pinned exactly below.
      if (r.name !== "public.orgs" && r.name !== "public.analyses") {
        expect(r.column_acls, `${r.name} column ACLs`).toBe("0");
      }
    }
    const columnGrants = async (table: string) =>
      (
        await pgs.migrator.query<{ g: string }>(
          `select format('%s:%s:%s', x.grantee::regrole, x.privilege_type, a.attname) as g
             from pg_attribute a, aclexplode(a.attacl) x
            where a.attrelid = $1::regclass and a.attacl is not null
            order by 1`,
          [table],
        )
      ).rows.map((r) => r.g);
    expect(await columnGrants("public.orgs")).toEqual(ORGS_COLUMN_PRIVILEGES);
    expect(await columnGrants("public.analyses")).toEqual(ANALYSES_COLUMN_PRIVILEGES);
  });

  it("lets the app role read but not change the retention settings", async () => {
    const settings = await appPool.query<{ category: string; days: number }>(
      "select category, days from app.retention_settings order by 1",
    );
    expect(settings.rows.map((r) => r.category)).toEqual([
      "analyses",
      "audit",
      "llm_usage",
      "logs",
      "org_deletion_grace",
      "webhook_deliveries",
    ]);
    for (const sql of [
      "update app.retention_settings set days = 1 where category = 'audit'",
      "delete from app.retention_settings",
      "insert into app.retention_settings (category, days) values ('audit', 1)",
    ]) {
      const error = await pgError(appPool.query(sql));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
});

describe("procedural code and indirect set_config (final review #1)", () => {
  /** Runs `sql` as the app role inside a transaction that is already scoped to org A. */
  const inTenantTransaction = async (sql: string, params: unknown[] = []) => {
    const client = await appPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.org_id', $1, true)", [a.orgId]);
      return await pgError(client.query(sql, params));
    } finally {
      await client.query("rollback");
      client.release();
    }
  };

  it("a DO block that switches tenant, writes, and switches back is refused and plants nothing", async () => {
    const error = await inTenantTransaction(
      `do $x$ begin
         perform set_config('app.org_id', '${b.orgId}', true);
         insert into repos (forge_repo_id, full_name) values (999, 'planted-by-A');
         perform set_config('app.org_id', '${a.orgId}', true);
       end $x$`,
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(error.message).toMatch(/language plpgsql/);
    expect(await countAs(b.orgId, table("repos"), "where full_name = 'planted-by-A'")).toBe(0);
    expect(await countAs(b.orgId, table("repos"))).toBe(1);
  });

  it("cannot change app.org_id through pg_settings", async () => {
    const error = await inTenantTransaction(
      "update pg_catalog.pg_settings set setting = $1 where name = 'app.org_id'",
      [b.orgId],
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(error.message).toMatch(/pg_settings/);
  });

  it("cannot run SQL text through catalog functions that execute it (ts_stat, ts_rewrite, query_to_xml…)", async () => {
    const hidden = `select set_config(''app.org_id'', ''${b.orgId}'', true)`;
    for (const sql of [
      `select ts_stat('${hidden}::tsvector')`,
      `select ts_stat('${hidden}::tsvector', 'x')`,
      `select ts_rewrite('a'::tsquery, '${hidden}::tsquery')`,
      `select query_to_xml('${hidden}', false, false, '')`,
      `select query_to_xmlschema('${hidden}', false, false, '')`,
      `select query_to_xml_and_xmlschema('${hidden}', false, false, '')`,
    ]) {
      const error = await inTenantTransaction(sql);
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      expect(error.message, sql).toMatch(/permission denied for function/);
    }
    // The harmless three-argument ts_rewrite is untouched.
    const ok = await appPool.query<{ v: string }>(
      "select ts_rewrite('a & b'::tsquery, 'a'::tsquery, 'c'::tsquery)::text as v",
    );
    expect(ok.rows[0]?.v).toBe("'b' & 'c'");
  });

  it("cannot create functions, procedures, triggers, rules, operators, casts, aggregates or extensions, or COPY from the server", async () => {
    for (const sql of [
      "create function public.f() returns int language sql as 'select 1'",
      "create function app.f() returns int language sql as 'select 1'",
      "create function retention.f() returns int language sql as 'select 1'",
      "create function public.f() returns int language plpgsql as 'begin return 1; end'",
      "create function pg_temp.f() returns int language sql as 'select 1'",
      "create procedure public.p() language sql as 'select 1'",
      "create procedure public.p() language plpgsql as 'begin null; end'",
      "create trigger t before insert on repos execute function pg_catalog.suppress_redundant_updates_trigger()",
      "create rule r as on insert to repos do instead nothing",
      "create operator public.=== (leftarg = int, rightarg = int, function = int4eq)",
      "create cast (int as text) with inout",
      "create aggregate public.agg(int) (sfunc = int4pl, stype = int)",
      "create extension if not exists pgcrypto",
      "create extension pg_trgm",
      "copy repos from program 'id'",
      "copy repos from '/etc/passwd'",
      "alter role current_user set app.org_id = 'x'",
      "do $$ begin null; end $$",
      "do language sql $$ select 1 $$",
    ]) {
      const error = await pgError(appPool.query(sql));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("catalog: no USAGE on any trusted language, no CREATE on any schema, no UPDATE on pg_settings, no EXECUTE on SPI functions", async () => {
    const languages = await pgs.migrator.query<{
      name: string;
      trusted: boolean;
      app: boolean;
      pub: boolean;
    }>(
      `select lanname as name, lanpltrusted as trusted,
              has_language_privilege($1, oid, 'USAGE') as app,
              has_language_privilege(0, oid, 'USAGE') as pub
         from pg_language order by 1`,
      [APP_ROLE],
    );
    const names = languages.rows.map((l) => l.name);
    expect(names).toContain("plpgsql");
    expect(names).toContain("sql");
    for (const l of languages.rows) {
      // Untrusted languages (c, internal) are superuser-only regardless of their ACL; for
      // every trusted one, neither the app role nor PUBLIC may use it.
      if (!l.trusted) continue;
      expect(l.app, `${l.name} usable by ${APP_ROLE}`).toBe(false);
      expect(l.pub, `${l.name} usable by PUBLIC`).toBe(false);
    }
    // The migrator keeps its grant (migrations create functions and run DO blocks).
    expect(
      (
        await pgs.migrator.query<{ ok: boolean }>(
          "select has_language_privilege('plpgsql', 'USAGE') and has_language_privilege('sql', 'USAGE') as ok",
        )
      ).rows[0]?.ok,
    ).toBe(true);

    const schemas = await pgs.migrator.query<{ name: string; app: boolean; pub: boolean }>(
      `select nspname as name, has_schema_privilege($1, oid, 'CREATE') as app,
              has_schema_privilege(0, oid, 'CREATE') as pub
         from pg_namespace order by 1`,
      [APP_ROLE],
    );
    expect(schemas.rows.map((s) => s.name)).toEqual(
      expect.arrayContaining(["public", "app", "retention", "worker"]),
    );
    for (const s of schemas.rows) {
      expect(s.app, `CREATE on ${s.name} for ${APP_ROLE}`).toBe(false);
      expect(s.pub, `CREATE on ${s.name} for PUBLIC`).toBe(false);
    }
    // The worker login holds no language and no CREATE anywhere either.
    const worker = await pgs.migrator.query<{ name: string; create: boolean }>(
      "select nspname as name, has_schema_privilege($1, oid, 'CREATE') as create from pg_namespace",
      [TEST_ROLES.worker],
    );
    for (const s of worker.rows) expect(s.create, `CREATE on ${s.name} for the worker`).toBe(false);
    const workerLanguages = await pgs.migrator.query<{ name: string; usable: boolean }>(
      "select lanname as name, has_language_privilege($1, oid, 'USAGE') as usable from pg_language where lanpltrusted",
      [TEST_ROLES.worker],
    );
    for (const l of workerLanguages.rows) expect(l.usable, `${l.name} for the worker`).toBe(false);

    const settings = await pgs.migrator.query<{
      app_update: boolean;
      pub_update: boolean;
      app_select: boolean;
    }>(
      `select has_table_privilege($1, 'pg_catalog.pg_settings', 'UPDATE') as app_update,
              has_table_privilege(0, 'pg_catalog.pg_settings', 'UPDATE') as pub_update,
              has_table_privilege($1, 'pg_catalog.pg_settings', 'SELECT') as app_select`,
      [APP_ROLE],
    );
    expect(settings.rows[0]).toEqual({ app_update: false, pub_update: false, app_select: true });

    for (const fn of SPI_FUNCTIONS) {
      const { rows } = await pgs.migrator.query<{ app: boolean; pub: boolean }>(
        `select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as app,
                has_function_privilege(0, $2::regprocedure, 'EXECUTE') as pub`,
        [APP_ROLE, fn],
      );
      expect(rows[0], fn).toEqual({ app: false, pub: false });
    }
  });
});
