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
   *
   * Nesting (REQUIRED propagation): a `withOrg` for the same org inside `fn` joins the open
   * transaction and runs with the same handle; there are no savepoints. A nested failure is not
   * rolled back on its own: the error propagates and the whole transaction rolls back unless the
   * caller catches it, in which case the outer work commits together with whatever the nested
   * call had already written. A nested call for a different org throws. Once the root `fn` has
   * settled the scope is closed: any later query from work that outlived it (a timer, an event
   * listener, a saved handle), at any depth, throws `TenantContextError` and never reaches the
   * connection, so detached work must start its own `withOrg` from outside.
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

/** One tenant transaction, shared by the root `withOrg` and every nested call inside it. */
interface Scope {
  orgId: OrgId;
  client: pg.PoolClient;
  tx: TenantTx;
  /** Set as soon as the root `fn` settles, before commit/rollback and before release. */
  closed: boolean;
}

// --- Statement guard ------------------------------------------------------------------------

/**
 * Second-layer denylist for statements that would alter the transaction or the tenant context
 * from inside `withOrg`. The first layer is the database: the application role cannot run
 * procedural code (no USAGE on any trusted language, no CREATE on any schema), cannot write
 * `pg_settings` and cannot execute the catalog functions that run SQL text (ADR 0005 §2, §3),
 * so every statement it sends is one the guard can read. The commit-time recheck of
 * `app.org_id` then detects a change that persisted to commit. The text is normalised first:
 * comments removed, string literals blanked, quoted identifiers unquoted, lower-cased,
 * whitespace collapsed. The library itself never issues savepoints, so those are refused along
 * with everything else that moves the transaction. `DO`, `CALL` and `CREATE` have no place in
 * a tenant transaction (and the role could not run them anyway); `ALTER ROLE … SET` would
 * persist session defaults; `UPDATE pg_settings` is `set_config` by another name.
 */
const FORBIDDEN_HEAD =
  /^(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare|discard|reset|do|call|create|alter (?:role|user|system)|update (?:pg_catalog ?\. ?)?pg_settings|set (?:local |session )?(?:role|session authorization|transaction|app ?\.))\b/;
/** Any set_config call: the only legitimate one is withOrg's own. */
const SET_CONFIG = /\bset_config ?\(/;
/**
 * pg_catalog functions that execute their text argument through SPI; a `set_config` inside that
 * literal is invisible after blanking. EXECUTE on them is revoked from PUBLIC at provisioning;
 * this refuses them by name as well (isolation.test.ts proves the revoke).
 */
const SPI_FUNCTION = /\b(?:query_to_xml(?:schema|_and_xmlschema)?|ts_stat|ts_rewrite) ?\(/;
/** Unicode-escape syntax (`u&'…'`, `u&"…"`) can spell anything; refused outright. */
const UNICODE_ESCAPE = /(?:^|[^a-z0-9_$])u&["']/i;
const DOLLAR_TAG = /^\$([a-z_][a-z0-9_]*)?\$/i;
const IDENTIFIER_CHAR = /[a-z0-9_$]/i;

const isIdentifierChar = (c: string | undefined): boolean =>
  c !== undefined && IDENTIFIER_CHAR.test(c);

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
      // E'…' literals (an `e`/`E` right before the quote that is not part of an identifier)
      // honour backslash escapes; ordinary literals only double the quote.
      const prev = sql[i - 1];
      const escapes = (prev === "e" || prev === "E") && !isIdentifierChar(sql[i - 2]);
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
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
    } else if (
      c === "$" &&
      !isIdentifierChar(sql[i - 1]) &&
      DOLLAR_TAG.test(sql.slice(i, i + 64))
    ) {
      // A dollar quote, unless the `$` continues an identifier such as `a$x$`.
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
  if (UNICODE_ESCAPE.test(sql)) {
    throw new TenantContextError(
      "withOrg: unicode-escaped strings and identifiers are not allowed",
    );
  }
  let text = normaliseSql(sql);
  if (text.endsWith(";")) text = text.slice(0, -1).trim();
  if (text.includes(";")) {
    throw new TenantContextError("withOrg: one statement per query");
  }
  if (SET_CONFIG.test(text)) {
    throw new TenantContextError("withOrg: set_config is not allowed inside a tenant transaction");
  }
  if (SPI_FUNCTION.test(text)) {
    throw new TenantContextError(
      "withOrg: functions that execute SQL text are not allowed inside a tenant transaction",
    );
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

const assertOpen = (scope: Scope): void => {
  if (scope.closed) {
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
const guardedClient = (scope: Scope): pg.PoolClient => {
  // Async so a refusal is always a rejection, whichever way the caller consumes the result.
  const query = async (...args: unknown[]): Promise<unknown> => {
    assertOpen(scope);
    checkStatement(textOf(args[0]));
    return (scope.client.query as (...a: unknown[]) => Promise<unknown>)(...args);
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
  const scopes = new AsyncLocalStorage<Scope>();

  const withOrg = async <T>(orgId: OrgId, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    if (typeof orgId !== "string" || !UUID.test(orgId)) {
      throw new TenantContextError("withOrg: orgId must be a uuid");
    }
    const current = scopes.getStore();
    if (current !== undefined) {
      // A finished scope is still visible to timers and listeners created inside it; its
      // connection now belongs to someone else, so this is refused rather than re-run.
      assertOpen(current);
      if (current.orgId !== orgId) {
        throw new TenantContextError(
          "withOrg: nested call for a different org inside an open tenant transaction",
        );
      }
      // REQUIRED propagation: join the open transaction with the same guarded handle. node-pg
      // queues concurrent queries on one client, so parallel nested calls are safe.
      return fn(current.tx);
    }

    const client = await pool.connect();
    const scope: Scope = {
      orgId,
      client,
      tx: undefined as unknown as TenantTx,
      closed: false,
    };
    scope.tx = makeTx(scope);
    let broken: Error | undefined;
    try {
      // A pooled connection may carry a session-level app.org_id left by misbehaving code;
      // clear it so nothing outlives this transaction (the transaction-local value below wins
      // inside it, and after COMMIT/ROLLBACK the connection is back to "no tenant").
      await client.query("select set_config('app.org_id', '', false)");
      await client.query("begin");
      await client.query("select set_config('app.org_id', $1, true)", [orgId]);
      let result: T;
      try {
        result = await scopes.run(scope, () => fn(scope.tx));
      } finally {
        // From here on nothing that came out of `fn` may reach the connection again.
        scope.closed = true;
      }
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
      scope.closed = true;
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
