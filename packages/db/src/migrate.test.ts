import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appliedMigrations, checksumOf, loadMigrations, migrate, rollback } from "./migrate.js";
import {
  CONTAINER_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
  ignoreIdleError,
} from "./testing/index.js";

/** P2-1: migrations go up and down, in both directions, on a real Postgres. */

let db: TestPostgres;

beforeAll(async () => {
  db = await startPostgres({ migrate: false });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.stop();
});

const userObjects = async (pool: pg.Pool) => {
  const tables = await pool.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
      order by 1`,
  );
  const functions = await pool.query<{ name: string }>(
    `select n.nspname || '.' || p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'retention', 'worker') order by 1`,
  );
  const policies = await pool.query<{ count: string }>("select count(*)::text from pg_policies");
  return {
    tables: tables.rows.map((r) => r.name),
    functions: functions.rows.map((r) => r.name),
    policies: Number(policies.rows[0]?.count),
  };
};

/**
 * Everything a down file must restore besides tables (review round 1, N5): table and column ACLs,
 * function ACLs, owners and bodies, schema ACLs, policies and triggers.
 */
const aclSnapshot = async (pool: pg.Pool): Promise<Record<string, string>> => {
  const { rows } = await pool.query<{ k: string; v: string }>(
    `select 'rel:' || n.nspname || '.' || c.relname as k,
            coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's' else 'r' end::"char", c.relowner))::text
              || '|' || c.relowner::regrole::text || '|' ||
            coalesce((select string_agg(a.attname || '=' || a.attacl::text, ',' order by a.attname)
                        from pg_attribute a where a.attrelid = c.oid and a.attacl is not null), '') as v
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
     union all
     select 'fn:' || p.oid::regprocedure::text,
            coalesce(p.proacl, acldefault('f', p.proowner))::text || '|' || p.proowner::regrole::text || '|' ||
            p.prosecdef::text || '|' || md5(p.prosrc) || '|' || coalesce(p.proconfig::text, '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
     union all
     select 'ns:' || nspname, coalesce(nspacl, acldefault('n', nspowner))::text || '|' || nspowner::regrole::text
       from pg_namespace where left(nspname, 3) <> 'pg_' and nspname <> 'information_schema'
     union all
     select 'pol:' || schemaname || '.' || tablename || '.' || policyname,
            permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' ||
            coalesce(with_check, '')
       from pg_policies
     union all
     select 'trg:' || tgrelid::regclass::text || '.' || tgname, tgenabled::text || '|' || tgfoid::regprocedure::text
       from pg_trigger where not tgisinternal
     union all
     select 'con:' || conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
       from pg_constraint where connamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
     union all
     select 'idx:' || indexrelid::regclass::text, pg_get_indexdef(indexrelid)
       from pg_index i join pg_class c on c.oid = i.indrelid
      where c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
        and c.relnamespace::regnamespace::text not like 'pg_toast%'`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
};

describe("migrations", () => {
  it("are numbered consecutively from 1 and each has an up and a down file", () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    migrations.forEach((m, i) => {
      expect(m.version).toBe(i + 1);
      expect(m.up.trim()).not.toBe("");
      expect(m.down.trim()).not.toBe("");
    });
  });

  it("go up, down to nothing, and up again; re-running is a no-op", async () => {
    const all = loadMigrations();

    const up = await migrate(db.migrator);
    expect(up.applied).toEqual(all.map((m) => m.name));
    const afterUp = await userObjects(db.migrator);
    expect(afterUp.tables).toContain("public.orgs");
    expect(afterUp.tables).toContain("public.audit_events");
    expect(afterUp.policies).toBeGreaterThan(0);

    const again = await migrate(db.migrator);
    expect(again.applied).toEqual([]);
    expect((await appliedMigrations(db.migrator)).map((m) => m.version)).toEqual(
      all.map((m) => m.version),
    );

    const down = await rollback(db.migrator, { steps: all.length });
    expect(down.reverted).toEqual(all.map((m) => m.name).reverse());
    const afterDown = await userObjects(db.migrator);
    // Only the migration ledger survives; roles and extensions are cluster-level (ADR 0005).
    expect(afterDown.tables).toEqual(["app.schema_migrations"]);
    expect(afterDown.functions).toEqual([]);
    expect(afterDown.policies).toBe(0);
    expect(await appliedMigrations(db.migrator)).toEqual([]);

    const upAgain = await migrate(db.migrator);
    expect(upAgain.applied).toEqual(all.map((m) => m.name));
    expect(await userObjects(db.migrator)).toEqual(afterUp);
  });

  it("can step one migration down and up at a time", async () => {
    const all = loadMigrations();
    const last = all.at(-1);
    if (last === undefined) throw new Error("no migrations");

    const down = await rollback(db.migrator, { steps: 1 });
    expect(down.reverted).toEqual([last.name]);
    expect((await appliedMigrations(db.migrator)).length).toBe(all.length - 1);

    const up = await migrate(db.migrator);
    expect(up.applied).toEqual([last.name]);
  });

  it("restores grants, policies, triggers, constraints and function bodies exactly at every step (N5)", async () => {
    const all = loadMigrations();
    const levels: Record<string, string>[] = [];
    for (let i = all.length; i >= 1; i--) {
      levels[i] = await aclSnapshot(db.migrator);
      await rollback(db.migrator, { steps: 1 });
    }
    levels[0] = await aclSnapshot(db.migrator);
    for (let i = 1; i <= all.length; i++) {
      await migrate(db.migrator, { to: i });
      expect(await aclSnapshot(db.migrator), all[i - 1]!.name).toEqual(levels[i]);
    }
    // Going down again lands on the same state as before going up.
    await rollback(db.migrator, { steps: 1 });
    expect(await aclSnapshot(db.migrator)).toEqual(levels[all.length - 1]);
    await migrate(db.migrator);
  });

  it("can migrate to a target version", async () => {
    const all = loadMigrations();
    await rollback(db.migrator, { steps: all.length });
    const partial = await migrate(db.migrator, { to: 2 });
    expect(partial.applied).toEqual(all.slice(0, 2).map((m) => m.name));
    expect((await userObjects(db.migrator)).policies).toBe(0);
    const rest = await migrate(db.migrator);
    expect(rest.applied).toEqual(all.slice(2).map((m) => m.name));
  });

  it("refuses to roll back more steps than are applied, without touching anything", async () => {
    const all = loadMigrations();
    const before = await userObjects(db.migrator);
    await expect(rollback(db.migrator, { steps: all.length + 1 })).rejects.toThrow(/steps/);
    expect(await userObjects(db.migrator)).toEqual(before);
  });

  it("records a sha256 per migration and refuses to run when an applied one changed (review #12)", async () => {
    const all = loadMigrations();
    const { rows } = await db.migrator.query<{ checksum: string }>(
      "select checksum from app.schema_migrations order by version",
    );
    expect(rows).toHaveLength(all.length);
    for (const r of rows) expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);

    const tampered = all.map((m, i) => (i === 1 ? { ...m, up: `${m.up}\n-- edited` } : m));
    await expect(migrate(db.migrator, { migrations: tampered })).rejects.toThrow(/checksum/);
    await expect(rollback(db.migrator, { migrations: tampered, steps: 1 })).rejects.toThrow(
      /checksum/,
    );
    expect((await appliedMigrations(db.migrator)).length).toBe(all.length);
  });

  it("checksums the down script too, and ignores line-ending differences (re-review E)", async () => {
    const all = loadMigrations();
    const downEdited = all.map((m, i) => (i === 2 ? { ...m, down: `${m.down}\n-- edited` } : m));
    await expect(migrate(db.migrator, { migrations: downEdited })).rejects.toThrow(/checksum/);
    await expect(rollback(db.migrator, { migrations: downEdited, steps: 1 })).rejects.toThrow(
      /checksum/,
    );
    // The same files checked out with CRLF line endings are the same migrations.
    const crlf = all.map((m) => ({
      ...m,
      up: m.up.replace(/\n/g, "\r\n"),
      down: m.down.replace(/\n/g, "\r\n"),
    }));
    expect(crlf[0]?.up).not.toBe(all[0]?.up);
    expect(crlf.map(checksumOf)).toEqual(all.map(checksumOf));
    expect(await migrate(db.migrator, { migrations: crlf })).toEqual({ applied: [] });
    expect((await appliedMigrations(db.migrator)).length).toBe(all.length);
  });

  it("holds an advisory lock so two migrators cannot interleave", async () => {
    const all = loadMigrations();
    await rollback(db.migrator, { steps: all.length });
    const other = new pg.Pool({ connectionString: db.migratorUrl, max: 2 }).on(
      "error",
      ignoreIdleError,
    );
    try {
      const [a, b] = await Promise.all([migrate(db.migrator), migrate(other)]);
      const applied = [...a.applied, ...b.applied].sort();
      expect(applied).toEqual(all.map((m) => m.name).sort());
    } finally {
      await other.end();
    }
  });
});
