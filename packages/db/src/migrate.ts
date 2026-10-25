import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/**
 * Plain SQL migrations (ADR 0005). Each version is a pair `NNNN_name.up.sql` / `.down.sql` in
 * ../migrations, applied in its own transaction and recorded in `app.schema_migrations`.
 * The runner takes a session advisory lock so two deployers cannot interleave. Runs as the
 * table owner (migrator), never as the application role.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: Date;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
/** Arbitrary constant; identifies "Rocky migrations" among advisory locks on the cluster. */
const LOCK_KEY = 726_335_920;

export const loadMigrations = (dir: string = MIGRATIONS_DIR): Migration[] => {
  const partial = new Map<number, { name: string; up?: string; down?: string }>();
  for (const file of readdirSync(dir).sort()) {
    const match = FILE.exec(file);
    if (match === null) throw new Error(`migrations: unexpected file name ${file}`);
    const version = Number(match[1]);
    const name = `${match[1]}_${match[2]}`;
    const entry = partial.get(version) ?? { name };
    if (entry.name !== name) throw new Error(`migrations: two names for version ${version}`);
    entry[match[3] as "up" | "down"] = readFileSync(join(dir, file), "utf8");
    partial.set(version, entry);
  }
  const migrations = [...partial.entries()]
    .sort(([a], [b]) => a - b)
    .map(([version, entry]) => {
      if (entry.up === undefined || entry.down === undefined) {
        throw new Error(`migrations: ${entry.name} needs both .up.sql and .down.sql`);
      }
      return { version, name: entry.name, up: entry.up, down: entry.down };
    });
  migrations.forEach((m, index) => {
    if (m.version !== index + 1)
      throw new Error(`migrations: versions must be 1..n, found ${m.name}`);
  });
  return migrations;
};

const withLock = async <T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      await client.query("create schema if not exists app");
      await client.query(
        `create table if not exists app.schema_migrations (
           version integer primary key,
           name text not null,
           applied_at timestamptz not null default now()
         )`,
      );
      return await fn(client);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
};

const readLedger = async (client: pg.PoolClient): Promise<AppliedMigration[]> => {
  const { rows } = await client.query<{ version: number; name: string; applied_at: Date }>(
    "select version, name, applied_at from app.schema_migrations order by version",
  );
  return rows.map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at }));
};

/** Every applied version must correspond to a known migration of the same name. */
const checkLedger = (applied: AppliedMigration[], migrations: Migration[]): void => {
  for (const row of applied) {
    const known = migrations.find((m) => m.version === row.version);
    if (known === undefined || known.name !== row.name) {
      throw new Error(
        `migrations: ledger has ${row.name} (v${row.version}) which is not in the migrations directory`,
      );
    }
  }
};

const runInTransaction = async (
  client: pg.PoolClient,
  label: string,
  sql: string,
  record: string,
  params: unknown[],
) => {
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query(record, params);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`migration ${label} failed: ${message}`, { cause: error });
  }
};

export const migrate = async (
  pool: pg.Pool,
  options: { to?: number; migrations?: Migration[] } = {},
): Promise<{ applied: string[] }> =>
  withLock(pool, async (client) => {
    const migrations = options.migrations ?? loadMigrations();
    const ledger = await readLedger(client);
    checkLedger(ledger, migrations);
    const done = new Set(ledger.map((m) => m.version));
    const pending = migrations.filter(
      (m) => !done.has(m.version) && (options.to === undefined || m.version <= options.to),
    );
    const applied: string[] = [];
    for (const m of pending) {
      await runInTransaction(
        client,
        `${m.name} (up)`,
        m.up,
        "insert into app.schema_migrations (version, name) values ($1, $2)",
        [m.version, m.name],
      );
      applied.push(m.name);
    }
    return { applied };
  });

export const rollback = async (
  pool: pg.Pool,
  options: { steps?: number; migrations?: Migration[] } = {},
): Promise<{ reverted: string[] }> =>
  withLock(pool, async (client) => {
    const steps = options.steps ?? 1;
    const migrations = options.migrations ?? loadMigrations();
    const ledger = await readLedger(client);
    checkLedger(ledger, migrations);
    if (!Number.isInteger(steps) || steps < 1 || steps > ledger.length) {
      throw new Error(`migrations: cannot roll back ${steps} steps, ${ledger.length} applied`);
    }
    const reverted: string[] = [];
    for (const row of ledger.slice(-steps).reverse()) {
      const m = migrations.find((x) => x.version === row.version);
      if (m === undefined) throw new Error(`migrations: ${row.name} not found`);
      await runInTransaction(
        client,
        `${m.name} (down)`,
        m.down,
        "delete from app.schema_migrations where version = $1",
        [m.version],
      );
      reverted.push(m.name);
    }
    return { reverted };
  });

export const appliedMigrations = (pool: pg.Pool): Promise<AppliedMigration[]> =>
  withLock(pool, readLedger);
