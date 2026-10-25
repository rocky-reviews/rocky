import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appliedMigrations, loadMigrations, migrate, rollback } from "./migrate.js";
import { CONTAINER_TIMEOUT_MS, startPostgres, type TestPostgres } from "./testing/index.js";

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
      where n.nspname in ('app', 'retention') order by 1`,
  );
  const policies = await pool.query<{ count: string }>("select count(*)::text from pg_policies");
  return {
    tables: tables.rows.map((r) => r.name),
    functions: functions.rows.map((r) => r.name),
    policies: Number(policies.rows[0]?.count),
  };
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

  it("holds an advisory lock so two migrators cannot interleave", async () => {
    const all = loadMigrations();
    await rollback(db.migrator, { steps: all.length });
    const other = new pg.Pool({ connectionString: db.migratorUrl, max: 2 });
    try {
      const [a, b] = await Promise.all([migrate(db.migrator), migrate(other)]);
      const applied = [...a.applied, ...b.applied].sort();
      expect(applied).toEqual(all.map((m) => m.name).sort());
    } finally {
      await other.end();
    }
  });
});
