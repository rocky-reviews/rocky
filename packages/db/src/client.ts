import { AsyncLocalStorage } from "node:async_hooks";
import type { OrgId } from "@rocky-reviews/core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  PURGE,
  SETTING_CATEGORIES,
  type RetentionCategory,
  type RetentionConfig,
} from "./retention-sql.js";
import * as schema from "./schema.js";

/** Thrown before any SQL runs when the tenant context would be wrong (ADR 0003, ADR 0005 §3). */
export class TenantContextError extends Error {
  override readonly name = "TenantContextError";
}

/**
 * What `withOrg` hands to its callback: a Drizzle handle and raw parameterised queries. Both
 * stop working the moment the transaction ends; using a saved handle later throws.
 */
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

export interface OrgDeletion {
  table: string;
  deleted: number;
}

export interface Db {
  /**
   * Runs `fn` in one transaction scoped to `orgId`: `set_config('app.org_id', orgId, true)` is
   * transaction-local, so it is safe with connection pooling. Commits when `fn` resolves, rolls
   * back when it rejects, and refuses to commit if the tenant setting changed underneath it.
   * Nested calls for the same org join the transaction (savepoint, serialised); a different org
   * throws; a call made from work that outlived its enclosing transaction (a timer, an event
   * listener) throws too, so detached work must start its own `withOrg` from outside.
   */
  withOrg<T>(orgId: OrgId, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /**
   * Cross-tenant purge through the SECURITY DEFINER functions owned by rocky_retention
   * (migration 0005). The period comes from app.retention_settings; `asOf` can only move the
   * cutoff into the past (the database clamps it to its clock). Returns rows deleted per org.
   */
  purgeExpired(category: RetentionCategory, asOf: Date): Promise<PurgeResult[]>;
  /** Erases an org whose deletion grace period has elapsed (retention.delete_org). */
  deleteOrg(orgId: OrgId): Promise<OrgDeletion[]>;
  /** The configured periods (read-only for the application role). */
  retentionSettings(): Promise<RetentionConfig>;
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
  client: pg.PoolClient;
  tx: TenantTx;
  savepoints: number;
  /** Set in `finally`, before the connection goes back to the pool. */
  closed: boolean;
  /** Nested calls run one after another on this chain so savepoints never interleave. */
  chain: Promise<unknown>;
}

// --- Statement guard ------------------------------------------------------------------------

/**
 * Statements that would alter the transaction or the tenant context from inside `withOrg`.
 * Checked on the first keyword after comments; `reset` and `discard` are refused entirely, and
 * `set` only for role, session authorization, transaction and `app.*` parameters.
 */
const FORBIDDEN_HEAD =
  /^(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare|discard|reset|set\s+(?:local\s+|session\s+)?(?:role|session\s+authorization|transaction|app\s*\.))\b/i;
/** Any set_config call: the only legitimate one is withOrg's own. */
const SET_CONFIG = /\bset_config\s*\(/i;

const stripLeading = (sql: string): string => {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^[\s(]+/, "");
    if (trimmed.startsWith("--")) {
      const end = trimmed.indexOf("\n");
      rest = end === -1 ? "" : trimmed.slice(end + 1);
    } else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      rest = end === -1 ? "" : trimmed.slice(end + 2);
    } else {
      return trimmed;
    }
  }
};

const checkStatement = (sql: string): void => {
  if (sql.includes(";")) {
    throw new TenantContextError("withOrg: one statement per query (no ';')");
  }
  if (SET_CONFIG.test(sql)) {
    throw new TenantContextError("withOrg: set_config is not allowed inside a tenant transaction");
  }
  if (FORBIDDEN_HEAD.test(stripLeading(sql))) {
    throw new TenantContextError(
      "withOrg: transaction control, role and tenant settings are managed by withOrg",
    );
  }
};

const textOf = (query: unknown): string => {
  if (typeof query === "string") return query;
  if (typeof query === "object" && query !== null && "text" in query) {
    const text = (query as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  throw new TenantContextError("withOrg: unsupported query shape");
};

// --- Tenant transaction ---------------------------------------------------------------------

const assertOpen = (scope: Scope): void => {
  if (scope.closed) {
    throw new TenantContextError(
      "withOrg: this tenant transaction has finished; start a new withOrg from outside it",
    );
  }
};

/**
 * The pg client Drizzle and `tx.query` talk to: every query is refused once the scope is closed
 * or when it would touch transaction control or the tenant setting. Everything else is the real
 * client, so Drizzle sees a normal `Client`-like object (not a `Pool`).
 */
const guardedClient = (scope: Scope): pg.PoolClient => {
  // Async so a refusal is always a rejection, whichever way the caller consumes the result.
  const query = async (...args: unknown[]): Promise<unknown> => {
    assertOpen(scope);
    checkStatement(textOf(args[0]));
    return (scope.client.query as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  return new Proxy(scope.client, {
    get(target, property) {
      if (property === "query") return query;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
};

const makeTx = (scope: Scope): TenantTx => {
  const client = guardedClient(scope);
  return {
    orgId: scope.orgId,
    db: drizzle(client, { schema }),
    query: (text, values) => client.query(text, values as unknown[] | undefined),
  };
};

export const createDb = (options: DbOptions): Db => {
  const pool =
    "pool" in options
      ? options.pool
      : new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  // One store per Db, so two Db instances in one process never see each other's scope.
  const scope = new AsyncLocalStorage<Scope>();

  const nested = <T>(current: Scope, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      assertOpen(current);
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
    const result = current.chain.then(run, run);
    current.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const withOrg = async <T>(orgId: OrgId, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    if (typeof orgId !== "string" || !UUID.test(orgId)) {
      throw new TenantContextError("withOrg: orgId must be a uuid");
    }
    const current = scope.getStore();
    if (current !== undefined) {
      // A finished scope is still visible to timers and listeners created inside it; its
      // connection now belongs to someone else, so this is refused rather than re-run.
      assertOpen(current);
      if (current.orgId !== orgId) {
        throw new TenantContextError(
          "withOrg: nested call for a different org inside an open tenant transaction",
        );
      }
      return nested(current, fn);
    }

    const client = await pool.connect();
    const store: Scope = {
      orgId,
      client,
      tx: undefined as unknown as TenantTx,
      savepoints: 0,
      closed: false,
      chain: Promise.resolve(),
    };
    store.tx = makeTx(store);
    let broken: Error | undefined;
    try {
      // A pooled connection may carry a session-level app.org_id left by misbehaving code;
      // clear it so nothing outlives this transaction (the transaction-local value below wins
      // inside it, and after COMMIT/ROLLBACK the connection is back to "no tenant").
      await client.query("select set_config('app.org_id', '', false)");
      await client.query("begin");
      await client.query("select set_config('app.org_id', $1, true)", [orgId]);
      const result = await scope.run(store, () => fn(store.tx));
      // Nested work that `fn` did not await must finish (or fail) before we decide to commit.
      await store.chain;
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
      store.closed = true;
      client.release(broken);
    }
  };

  const requireUuid = (orgId: OrgId, where: string): void => {
    if (typeof orgId !== "string" || !UUID.test(orgId)) {
      throw new TenantContextError(`${where}: orgId must be a uuid`);
    }
  };

  const purgeExpired = async (category: RetentionCategory, asOf: Date): Promise<PurgeResult[]> => {
    const purge = PURGE[category];
    if (purge === undefined) throw new Error(`purgeExpired: unknown category ${String(category)}`);
    if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
      throw new Error("purgeExpired: asOf must be a valid Date");
    }
    const { rows } = await pool.query<{ org_id: string; deleted: string }>(purge.sql, [asOf]);
    return rows.map((row) => ({ orgId: row.org_id as OrgId, deleted: Number(row.deleted) }));
  };

  const deleteOrg = async (orgId: OrgId): Promise<OrgDeletion[]> => {
    requireUuid(orgId, "deleteOrg");
    const { rows } = await pool.query<{ table_name: string; deleted: string }>(
      "select table_name, deleted::text from retention.delete_org($1)",
      [orgId],
    );
    return rows.map((row) => ({ table: row.table_name, deleted: Number(row.deleted) }));
  };

  const retentionSettings = async (): Promise<RetentionConfig> => {
    const { rows } = await pool.query<{ category: string; days: number }>(
      "select category, days from app.retention_settings",
    );
    const byCategory = new Map(rows.map((r) => [r.category, r.days]));
    const read = (key: keyof RetentionConfig): number => {
      const days = byCategory.get(SETTING_CATEGORIES[key]);
      if (days === undefined)
        throw new Error(`retention settings: missing ${SETTING_CATEGORIES[key]}`);
      return days;
    };
    return {
      analysesDays: read("analysesDays"),
      logsDays: read("logsDays"),
      auditDays: read("auditDays"),
      orgDeletionGraceDays: read("orgDeletionGraceDays"),
    };
  };

  return { withOrg, purgeExpired, deleteOrg, retentionSettings, close: () => pool.end() };
};
