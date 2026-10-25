/**
 * Retention categories and the SQL that purges each one. The functions are SECURITY DEFINER,
 * owned by rocky_retention (migration 0005); the application role can only execute them.
 * Kept apart from retention.ts so the client can import it without a cycle.
 */
export const RETENTION_CATEGORIES = ["analyses", "logs", "audit"] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export interface PurgeTarget {
  /** The table the category purges (for audit events and reports). */
  table: string;
  /** Full statement; `$1` is the cutoff. Rows strictly older than it are deleted. */
  sql: string;
}

export const PURGE: Readonly<Record<RetentionCategory, PurgeTarget>> = {
  analyses: {
    table: "analyses",
    sql: "select org_id, deleted::text from retention.purge_analyses($1)",
  },
  logs: {
    table: "jobs",
    sql: "select org_id, deleted::text from retention.purge_jobs($1)",
  },
  audit: {
    table: "audit_events",
    sql: "select org_id, deleted::text from retention.purge_audit_events($1)",
  },
};
