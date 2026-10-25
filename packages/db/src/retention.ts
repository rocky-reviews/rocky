import type { Clock } from "@rocky-reviews/core";
import { audit } from "./audit.js";
import type { Db } from "./client.js";
import { PURGE, RETENTION_CATEGORIES, type RetentionCategory } from "./retention-sql.js";

export { PURGE, RETENTION_CATEGORIES, type RetentionCategory } from "./retention-sql.js";

/** Retention periods in whole days (P2-6). */
export interface RetentionConfig {
  /** Analysis documents (and, by cascade, finding states). */
  analysesDays: number;
  /** Finished job rows. Application logs are not in the database. */
  logsDays: number;
  /** Audit events. Cannot go below AUDIT_MIN_RETENTION_DAYS. */
  auditDays: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  analysesDays: 90,
  logsDays: 30,
  auditDays: 365,
};

/** Mirrors the floor hard-coded in retention.purge_audit_events (migration 0005). */
export const AUDIT_MIN_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Boundary rule: a row is expired when `created_at < now - days` (strictly older). A row created
 * exactly `days` ago is kept. The SQL purge functions use the same `<`.
 */
export const expiryCutoff = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * DAY_MS);

const ENV_KEYS: Record<keyof RetentionConfig, string> = {
  analysesDays: "RETENTION_ANALYSES_DAYS",
  logsDays: "RETENTION_LOGS_DAYS",
  auditDays: "RETENTION_AUDIT_DAYS",
};

const checkDays = (label: string, value: number, min = 1): void => {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer of at least ${min} (days)`);
  }
};

export const validateRetention = (config: RetentionConfig): RetentionConfig => {
  checkDays("analysesDays", config.analysesDays);
  checkDays("logsDays", config.logsDays);
  checkDays("auditDays", config.auditDays, AUDIT_MIN_RETENTION_DAYS);
  return config;
};

/** Reads `RETENTION_*_DAYS` from the environment, falling back to the defaults. */
export const retentionFromEnv = (env: Record<string, string | undefined>): RetentionConfig => {
  const read = (key: keyof RetentionConfig, min = 1): number => {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw === "") return DEFAULT_RETENTION[key];
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    checkDays(ENV_KEYS[key], value, min);
    return value;
  };
  return {
    analysesDays: read("analysesDays"),
    logsDays: read("logsDays"),
    auditDays: read("auditDays", AUDIT_MIN_RETENTION_DAYS),
  };
};

export interface RetentionCategoryReport {
  category: RetentionCategory;
  table: string;
  before: Date;
  deleted: number;
  orgs: number;
}

export interface RetentionReport {
  ranAt: Date;
  categories: RetentionCategoryReport[];
}

const SYSTEM_ACTOR = { type: "system", id: "retention" } as const;

/**
 * Purges every category once, using the injected clock for "now", and records one
 * `retention.purged` audit event per affected org and table. Idempotent: a second run at the
 * same instant deletes nothing and writes nothing.
 */
export const runRetention = async (
  db: Db,
  deps: { clock: Clock; config?: RetentionConfig },
): Promise<RetentionReport> => {
  const config = validateRetention(deps.config ?? DEFAULT_RETENTION);
  const now = deps.clock.now();
  const days: Record<RetentionCategory, number> = {
    analyses: config.analysesDays,
    logs: config.logsDays,
    audit: config.auditDays,
  };
  const categories: RetentionCategoryReport[] = [];
  for (const category of RETENTION_CATEGORIES) {
    const before = expiryCutoff(now, days[category]);
    const table = PURGE[category].table;
    const results = await db.purgeExpired(category, before);
    for (const result of results) {
      await db.withOrg(result.orgId, (tx) =>
        audit(
          tx,
          SYSTEM_ACTOR,
          "retention.purged",
          { type: "table", id: table },
          { category, deleted: result.deleted, before: before.toISOString() },
        ),
      );
    }
    categories.push({
      category,
      table,
      before,
      deleted: results.reduce((sum, r) => sum + r.deleted, 0),
      orgs: results.length,
    });
  }
  return { ranAt: now, categories };
};
