import type { Clock } from "@rocky-reviews/core";
import type pg from "pg";
import type { Db } from "./client.js";
import {
  PURGE,
  RETENTION_CATEGORIES,
  SETTING_CATEGORIES,
  type RetentionCategory,
  type RetentionConfig,
} from "./retention-sql.js";

export {
  PURGE,
  RETENTION_CATEGORIES,
  type RetentionCategory,
  type RetentionConfig,
} from "./retention-sql.js";

export const DEFAULT_RETENTION: RetentionConfig = {
  analysesDays: 90,
  logsDays: 30,
  auditDays: 365,
  orgDeletionGraceDays: 7,
  webhookDeliveriesDays: 30,
};

/** Mirrors the CHECK constraint on app.retention_settings (migration 0005). */
export const AUDIT_MIN_RETENTION_DAYS = 30;
/** Mirrors the CHECK in migration 0006: GitHub redelivers for up to 3 days. */
export const WEBHOOK_DELIVERIES_MIN_RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Boundary rule: a row is expired when `created_at < as_of - days` (strictly older). A row
 * created exactly `days` ago is kept. The SQL purge functions use the same `<`, with `as_of`
 * clamped to the database clock.
 */
export const expiryCutoff = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * DAY_MS);

const ENV_KEYS: Record<keyof RetentionConfig, string> = {
  analysesDays: "RETENTION_ANALYSES_DAYS",
  logsDays: "RETENTION_LOGS_DAYS",
  auditDays: "RETENTION_AUDIT_DAYS",
  orgDeletionGraceDays: "ORG_DELETION_GRACE_DAYS",
  webhookDeliveriesDays: "RETENTION_WEBHOOK_DELIVERIES_DAYS",
};

const MIN_DAYS: Record<keyof RetentionConfig, number> = {
  analysesDays: 1,
  logsDays: 1,
  auditDays: AUDIT_MIN_RETENTION_DAYS,
  orgDeletionGraceDays: 1,
  webhookDeliveriesDays: WEBHOOK_DELIVERIES_MIN_RETENTION_DAYS,
};

const SETTING_KEYS = Object.keys(MIN_DAYS) as (keyof RetentionConfig)[];

const checkDays = (label: string, value: number, min: number): void => {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer of at least ${min} (days)`);
  }
};

export const validateRetention = (config: RetentionConfig): RetentionConfig => {
  for (const key of SETTING_KEYS) checkDays(key, config[key], MIN_DAYS[key]);
  return config;
};

/** Reads `RETENTION_*_DAYS` / `ORG_DELETION_GRACE_DAYS`, falling back to the defaults. */
export const retentionFromEnv = (env: Record<string, string | undefined>): RetentionConfig => {
  const read = (key: keyof RetentionConfig): number => {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw === "") return DEFAULT_RETENTION[key];
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    checkDays(ENV_KEYS[key], value, MIN_DAYS[key]);
    return value;
  };
  return {
    analysesDays: read("analysesDays"),
    logsDays: read("logsDays"),
    auditDays: read("auditDays"),
    orgDeletionGraceDays: read("orgDeletionGraceDays"),
    webhookDeliveriesDays: read("webhookDeliveriesDays"),
  };
};

/**
 * Writes the periods to app.retention_settings. Runs as the migrator (the table owner); the
 * application role can only read the table, so this is the one place periods change.
 */
export const setRetentionSettings = async (
  migrator: pg.Pool,
  config: RetentionConfig,
): Promise<void> => {
  validateRetention(config);
  const client = await migrator.connect();
  try {
    await client.query("begin");
    for (const key of SETTING_KEYS) {
      await client.query(
        `insert into app.retention_settings (category, days) values ($1, $2)
         on conflict (category) do update set days = excluded.days, updated_at = now()`,
        [SETTING_CATEGORIES[key], config[key]],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

export interface RetentionCategoryReport {
  /** A tenant category, or the (non-tenant) webhook inbox. */
  category: RetentionCategory | "webhook_deliveries";
  table: string;
  /** Cutoff as computed from the injected clock; the database clamps it to its own `now()`. */
  before: Date;
  deleted: number;
  /** Orgs with deleted rows; always 0 for the webhook inbox, which has no org. */
  orgs: number;
}

export interface RetentionReport {
  ranAt: Date;
  categories: RetentionCategoryReport[];
}

/**
 * Purges every category once as of the injected clock. The tenant purge functions write one
 * `retention.purged` audit event per affected org in the same statement as the delete; the
 * webhook inbox purge has no org to audit and only reports its count.
 * Idempotent: a second run at the same instant deletes nothing and writes nothing.
 */
export const runRetention = async (db: Db, deps: { clock: Clock }): Promise<RetentionReport> => {
  const settings = await db.retentionSettings();
  const now = deps.clock.now();
  const categories: RetentionCategoryReport[] = [];
  for (const category of RETENTION_CATEGORIES) {
    const target = PURGE[category];
    const results = await db.purgeExpired(category, now);
    categories.push({
      category,
      table: target.table,
      before: expiryCutoff(now, settings[target.setting]),
      deleted: results.reduce((sum, r) => sum + r.deleted, 0),
      orgs: results.length,
    });
  }
  categories.push({
    category: "webhook_deliveries",
    table: "webhook_deliveries",
    before: expiryCutoff(now, settings.webhookDeliveriesDays),
    deleted: await db.purgeWebhookDeliveries(now),
    orgs: 0,
  });
  return { ranAt: now, categories };
};
