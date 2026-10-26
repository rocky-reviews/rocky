/**
 * Retention categories, settings and the SQL that purges each one. The purge functions are
 * SECURITY DEFINER, owned by rocky_retention (migration 0005); they take their period from
 * app.retention_settings and only accept an `as_of` that moves the cutoff into the past.
 * Kept apart from retention.ts so the client can import it without a cycle.
 */
export const RETENTION_CATEGORIES = ["analyses", "logs", "audit"] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

/** Retention periods in whole days, as stored in app.retention_settings. */
export interface RetentionConfig {
  /** Analysis documents (and, by cascade, finding states). */
  analysesDays: number;
  /** Finished job rows. Application logs are not in the database. */
  logsDays: number;
  /** Audit events. The table refuses values below AUDIT_MIN_RETENTION_DAYS. */
  auditDays: number;
  /** Minimum delay between scheduling an org deletion and executing it. */
  orgDeletionGraceDays: number;
}

/** `category` column value for each setting. */
export const SETTING_CATEGORIES: Readonly<Record<keyof RetentionConfig, string>> = {
  analysesDays: "analyses",
  logsDays: "logs",
  auditDays: "audit",
  orgDeletionGraceDays: "org_deletion_grace",
};

export interface PurgeTarget {
  /** The table the category purges (for reports). */
  table: string;
  /** The settings key holding the period. */
  setting: keyof RetentionConfig;
  /** Full statement; `$1` is `as_of` (clamped to now() by the function). */
  sql: string;
}

export const PURGE: Readonly<Record<RetentionCategory, PurgeTarget>> = {
  analyses: {
    table: "analyses",
    setting: "analysesDays",
    sql: "select org_id, deleted::text from retention.purge_analyses($1)",
  },
  logs: {
    table: "jobs",
    setting: "logsDays",
    sql: "select org_id, deleted::text from retention.purge_jobs($1)",
  },
  audit: {
    table: "audit_events",
    setting: "auditDays",
    sql: "select org_id, deleted::text from retention.purge_audit_events($1)",
  },
};
