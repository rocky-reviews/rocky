import type { TenantTx } from "./client.js";
import { auditEvents } from "./schema.js";

export interface AuditActor {
  type: "user" | "system" | "forge";
  /** Member id, job/worker name, or forge delivery id. Never an email or a token. */
  id: string;
}

export interface AuditTarget {
  /** `finding`, `comment`, `repo`, `table`, … (snake_case). */
  type: string;
  id: string;
}

/** Metadata holds identifiers and counts, so a few KiB is plenty; code or diffs never fit. */
export const AUDIT_METADATA_MAX_BYTES = 4096;

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const TYPE = /^[a-z][a-z0-9_]*$/;
const MAX_ID_LENGTH = 512;

const requireId = (field: string, value: string): void => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error(
      `audit: ${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`,
    );
  }
};

/**
 * Appends one audit event for the current tenant (P2-5). `action` is dotted snake_case such as
 * `finding.accepted` or `retention.purged`. Rows can never be updated or deleted by the
 * application (migration 0004); only the retention purge removes them after the audit period.
 */
export const audit = async (
  tx: TenantTx,
  actor: AuditActor,
  action: string,
  target: AuditTarget,
  metadata: Record<string, unknown> = {},
): Promise<{ id: number }> => {
  if (!ACTION.test(action)) throw new Error("audit: action must look like `thing.happened`");
  requireId("actor.id", actor.id);
  if (!TYPE.test(target.type)) throw new Error("audit: target.type must be snake_case");
  requireId("target.id", target.id);
  const encoded = JSON.stringify(metadata);
  if (Buffer.byteLength(encoded, "utf8") > AUDIT_METADATA_MAX_BYTES) {
    throw new Error(`audit: metadata exceeds ${AUDIT_METADATA_MAX_BYTES} bytes`);
  }
  const [row] = await tx.db
    .insert(auditEvents)
    .values({
      actorType: actor.type,
      actorId: actor.id,
      action,
      targetType: target.type,
      targetId: target.id,
      metadata,
    })
    .returning({ id: auditEvents.id });
  if (row === undefined) throw new Error("audit: insert returned no row");
  return { id: row.id };
};
