import { AsyncLocalStorage } from "node:async_hooks";
import type { OrgId } from "@rocky-reviews/core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { PURGE, type RetentionCategory } from "./retention-sql.js";
import * as schema from "./schema.js";

/** Thrown before any SQL runs when the tenant context would be wrong (ADR 0003). */
export class TenantContextError extends Error {
  override readonly name = "TenantContextError";
}

/** What `withOrg` hands to its callback: a Drizzle handle and raw parameterised queries. */
export interface TenantTx {
  readonly orgId: OrgId;
  readonly db: NodePgDatabase<typeof schema>;
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface PurgeResult {
  orgId: OrgId;
  deleted: number;
}

export interface Db {
  /**
   * Runs `fn` in one transaction scoped to `orgId`: `set_config('app.org_id', orgId, true)` is
   * transaction-local, so it is safe with connection pooling. Commits when `fn` resolves, rolls
   * back when it rejects, and refuses to commit if the tenant setting changed underneath it.
   * Nested calls for the same org join the transaction (savepoint); a different org throws.
   */
  withOrg<T>(orgId: OrgId, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /**
   * The only cross-tenant operation: calls the SECURITY DEFINER purge function for `category`
   * (owned by rocky_retention, migration 0005). Returns rows deleted per org.
   */
  purgeExpired(category: RetentionCategory, before: Date): Promise<PurgeResult[]>;
  close(): Promise<void>;
}

export type DbOptions =
  | { connectionString: string; max?: number }
  | {
      /** An existing pool (tests). Must connect as the application role. */
      pool: pg.Pool;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Scope {
  orgId: OrgId;
  tx: TenantTx;
  client: pg.PoolClient;
  savepoints: number;
}

const makeTx = (orgId: OrgId, client: pg.PoolClient): TenantTx => ({
  orgId,
  db: drizzle(client, { schema }),
  query: (text, values) => client.query(text, values as unknown[] | undefined),
});

export const createDb = (options: DbOptions): Db => {
  const pool =
    "pool" in options
      ? options.pool
      : new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  // One store per Db, so two Db instances in one process never see each other's scope.
  const scope = new AsyncLocalStorage<Scope>();

  const nested = async <T>(current: Scope, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    const savepoint = `withorg_${++current.savepoints}`;
    await current.client.query(`savepoint ${savepoint}`);
    try {
      const result = await fn(current.tx);
      await current.client.query(`release savepoint ${savepoint}`);
      return result;
    } catch (error) {
      await current.client.query(`rollback to savepoint ${savepoint}`);
      throw error;
    }
  };

  const withOrg = async <T>(orgId: OrgId, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    if (typeof orgId !== "string" || !UUID.test(orgId)) {
      throw new TenantContextError("withOrg: orgId must be a uuid");
    }
    const current = scope.getStore();
    if (current !== undefined) {
      if (current.orgId !== orgId) {
        throw new TenantContextError(
          "withOrg: nested call for a different org inside an open tenant transaction",
        );
      }
      return nested(current, fn);
    }

    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      // A pooled connection may carry a session-level app.org_id left by misbehaving code;
      // clear it so nothing outlives this transaction (the transaction-local value below wins
      // inside it, and after COMMIT/ROLLBACK the connection is back to "no tenant").
      await client.query("select set_config('app.org_id', '', false)");
      await client.query("begin");
      await client.query("select set_config('app.org_id', $1, true)", [orgId]);
      const tx = makeTx(orgId, client);
      const result = await scope.run({ orgId, tx, client, savepoints: 0 }, () => fn(tx));
      const check = await client.query<{ org_id: string | null }>(
        "select current_setting('app.org_id', true) as org_id",
      );
      if (check.rows[0]?.org_id !== orgId) {
        throw new TenantContextError("withOrg: app.org_id changed inside the transaction");
      }
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // The connection is unusable (for example it dropped): destroy it instead of pooling it.
        broken = error instanceof Error ? error : new Error(String(error));
      }
      throw error;
    } finally {
      client.release(broken);
    }
  };

  const purgeExpired = async (
    category: RetentionCategory,
    before: Date,
  ): Promise<PurgeResult[]> => {
    const purge = PURGE[category];
    if (purge === undefined) throw new Error(`purgeExpired: unknown category ${String(category)}`);
    if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
      throw new Error("purgeExpired: before must be a valid Date");
    }
    const { rows } = await pool.query<{ org_id: string; deleted: string }>(purge.sql, [before]);
    return rows.map((row) => ({ orgId: row.org_id as OrgId, deleted: Number(row.deleted) }));
  };

  return { withOrg, purgeExpired, close: () => pool.end() };
};
