import { EXTERNAL_TENANT_STORES, type OrgErasers, type OrgId } from "@rocky-reviews/core";
import type { Db } from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";

/**
 * The deletion sweep (P3-3, ADR 0009): erases every org whose grace period has elapsed. For each
 * due org, first every external store (object storage, embeddings; `OrgErasers`), then the
 * database through `retention.delete_org` (audit events, the org row and its cascade through
 * every tenant table, its finished inbox rows, and a tombstone in `app.org_deletions`).
 *
 * Safe with several workers: `delete_org` locks the org row; a second worker finds it gone (or
 * a reinstall finds it cancelled) and gets `22023`, counted as skipped. External erasure is
 * idempotent and runs again on the next sweep if anything fails, and the org row is only
 * deleted after every store succeeded.
 */

const NOT_SCHEDULED = "22023"; // invalid_parameter_value: not scheduled, or no longer due

export interface SweepDeps {
  /** Must connect as the worker login. */
  readonly db: Db;
  readonly erasers: OrgErasers;
  readonly log: Logger;
  /** Orgs per sweep (default 20). */
  readonly limit?: number;
}

export interface SweepReport {
  readonly due: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly failed: number;
}

const codeOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$|^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : "internal_error";
};

const eraseOne = async (deps: SweepDeps, orgId: OrgId): Promise<"deleted" | "skipped"> => {
  for (const store of EXTERNAL_TENANT_STORES) await deps.erasers[store].eraseOrg(orgId);
  try {
    const tables = await deps.db.deleteOrg(orgId);
    deps.log.info(
      { orgId, deleted: Object.fromEntries(tables.map((t) => [t.table, t.deleted])) },
      "org erased",
    );
    return "deleted";
  } catch (error) {
    if (codeOf(error) === NOT_SCHEDULED) {
      deps.log.info({ orgId }, "org erasure skipped: no longer due");
      return "skipped";
    }
    throw error;
  }
};

export const sweepOrgDeletions = async (deps: SweepDeps): Promise<SweepReport> => {
  const due = await deps.db.orgsDueForDeletion(deps.limit ?? 20);
  const report = { due: due.length, deleted: 0, skipped: 0, failed: 0 };
  for (const orgId of due) {
    try {
      report[await eraseOne(deps, orgId)]++;
    } catch (error) {
      report.failed++;
      deps.log.error({ orgId, errorCode: codeOf(error) }, "org erasure failed; retried next sweep");
    }
  }
  return report;
};
