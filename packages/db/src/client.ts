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
   * Nested calls for the same org join the transaction (savepoint; siblings are serialised); a
   * different org throws; a call made from work that outlived its enclosing transaction (a
   * timer, an event listener) throws too, so detached work must start its own `withOrg` from
   * outside.
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

/** One tenant transaction: shared by the outer `withOrg` and every nested call inside it. */
interface Shared {
  orgId: OrgId;
  client: pg.PoolClient;
  tx: TenantTx;
  savepoints: number;
  /** Set in `finally`, before the connection goes back to the pool. */
  closed: boolean;
}

/**
 * One nesting level. Nested calls made at the same level queue on their parent's `chain` so
 * savepoints never interleave; each nested `fn` runs in its own scope, so deeper calls only
 * queue behind their siblings, never behind the call that is awaiting them.
 */
interface Scope {
  shared: Shared;
  chain: Promise<unknown>;
}

// --- Statement guard ------------------------------------------------------------------------

/**
 * Best-effort denylist for statements that would alter the transaction or the tenant context
 * from inside `withOrg` (the commit-time recheck of `app.org_id` is the real guarantee). The
 * text is normalised first: comments removed, string literals blanked, quoted identifiers
 * unquoted, lower-cased, whitespace collapsed.
 */
const FORBIDDEN_HEAD =
  /^(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare|discard|reset|set (?:local |session )?(?:role|session authorization|transaction|app ?\.))\b/;
/** Any set_config call: the only legitimate one is withOrg's own. */
const SET_CONFIG = /\bset_config ?\(/;
const DOLLAR_TAG = /^\$([a-z_][a-z0-9_]*)?\$/i;

const normaliseSql = (sql: string): string => {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += "''";
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let identifier = "";
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            identifier += '"';
            j += 2;
            continue;
          }
          break;
        }
        identifier += sql[j];
        j++;
      }
      out += identifier.replace(/;/g, "");
      i = j + 1;
    } else if (c === "$" && DOLLAR_TAG.test(sql.slice(i, i + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))?.[0] ?? "$$";
      const end = sql.indexOf(tag, i + tag.length);
      out += "''";
      i = end === -1 ? n : end + tag.length;
    } else {
      out += c;
      i++;
    }
  }
  return out.toLowerCase().replace(/\s+/g, " ").trim();
};

const checkStatement = (sql: string): void => {
  let text = normaliseSql(sql);
  if (text.endsWith(";")) text = text.slice(0, -1).trim();
  if (text.includes(";")) {
    throw new TenantContextError("withOrg: one statement per query");
  }
  if (SET_CONFIG.test(text)) {
    throw new TenantContextError("withOrg: set_config is not allowed inside a tenant transaction");
  }
  if (FORBIDDEN_HEAD.test(text.replace(/^[( ]+/, ""))) {
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

const assertOpen = (shared: Shared): void => {
  if (shared.closed) {
    throw new TenantContextError(
      "withOrg: this tenant transaction has finished; start a new withOrg from outside it",
    );
  }
};

/**
 * The pg client Drizzle and `tx.query` talk to. It exposes exactly one thing, `query`, which is
 * refused once the transaction ended or when the statement would touch transaction control or
 * the tenant setting. Everything else on the real client (`release`, `connection`, `end`, …)
 * throws, so nothing inside `fn` can hand a mid-transaction connection back to the pool.
 */
const guardedClient = (shared: Shared): pg.PoolClient => {
  // Async so a refusal is always a rejection, whichever way the caller consumes the result.
  const query = async (...args: unknown[]): Promise<unknown> => {
    assertOpen(shared);
    checkStatement(textOf(args[0]));
    return (shared.client.query as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  const surface = Object.freeze({ query });
  return new Proxy(surface, {
    get(_target, property) {
      if (property === "query") return query;
      // Drizzle checks `constructor.name` to tell a config object and a Pool from a client.
      if (property === "constructor") return Object;
      if (typeof property === "symbol" || property === "then") return undefined;
      throw new TenantContextError(
        `withOrg: the pg client is not exposed inside a tenant transaction (${property})`,
      );
    },
  }) as unknown as pg.PoolClient;
};

const makeTx = (shared: Shared): TenantTx => {
  const client = guardedClient(shared);
  return {
    orgId: shared.orgId,
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
  const scopes = new AsyncLocalStorage<Scope>();

  const nested = <T>(parent: Scope, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    const { shared } = parent;
    const run = async (): Promise<T> => {
      assertOpen(shared);
      const savepoint = `withorg_${++shared.savepoints}`;
      await shared.client.query(`savepoint ${savepoint}`);
      const child: Scope = { shared, chain: Promise.resolve() };
      try {
        const result = await scopes.run(child, () => fn(shared.tx));
        // Deeper calls that `fn` did not await must settle before this savepoint is released.
        await child.chain;
        await shared.client.query(`release savepoint ${savepoint}`);
        return result;
      } catch (error) {
        await child.chain;
        await shared.client.query(`rollback to savepoint ${savepoint}`);
        throw error;
      }
    };
    const result = parent.chain.then(run, run);
    parent.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const withOrg = async <T>(orgId: OrgId, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    if (typeof orgId !== "string" || !UUID.test(orgId)) {
      throw new TenantContextError("withOrg: orgId must be a uuid");
    }
    const current = scopes.getStore();
    if (current !== undefined) {
      // A finished scope is still visible to timers and listeners created inside it; its
      // connection now belongs to someone else, so this is refused rather than re-run.
      assertOpen(current.shared);
      if (current.shared.orgId !== orgId) {
        throw new TenantContextError(
          "withOrg: nested call for a different org inside an open tenant transaction",
        );
      }
      return nested(current, fn);
    }

    const client = await pool.connect();
    const shared: Shared = {
      orgId,
      client,
      tx: undefined as unknown as TenantTx,
      savepoints: 0,
      closed: false,
    };
    shared.tx = makeTx(shared);
    const root: Scope = { shared, chain: Promise.resolve() };
    let broken: Error | undefined;
    try {
      // A pooled connection may carry a session-level app.org_id left by misbehaving code;
      // clear it so nothing outlives this transaction (the transaction-local value below wins
      // inside it, and after COMMIT/ROLLBACK the connection is back to "no tenant").
      await client.query("select set_config('app.org_id', '', false)");
      await client.query("begin");
      await client.query("select set_config('app.org_id', $1, true)", [orgId]);
      const result = await scopes.run(root, () => fn(shared.tx));
      // Nested work that `fn` did not await must finish (or fail) before we decide to commit.
      await root.chain;
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
      shared.closed = true;
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
      if (days === undefined) {
        throw new Error(`retention settings: missing ${SETTING_CATEGORIES[key]}`);
      }
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
