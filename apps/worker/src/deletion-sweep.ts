import {
  EXTERNAL_TENANT_STORES,
  ForgeReadError,
  type InstallationReader,
  type OrgErasers,
} from "@rocky-reviews/core";
import {
  auditLifecycle,
  beginOrgErasure,
  cancelOrgDeletion,
  type Db,
  type DueOrg,
} from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";
import type { AppCheck } from "./app-check.js";

/**
 * The deletion sweep (P3-3, ADR 0009): erases every org whose grace period has elapsed.
 *
 * For each due org (review round 1, S1c and S6):
 * 1. Unless an earlier sweep already started erasing it, ask GitHub again whether the
 *    installation is gone. It exists (active or suspended): cancel the deletion and audit why.
 *    GitHub fails to answer: leave the org for the next sweep. Only a genuine 404 proceeds. This
 *    also stops a deadline that reached the database by any other path.
 * 2. Mark the org erasing under its row lock: from here on nothing cancels or rebinds it, and a
 *    reinstall gets a fresh org (migration 0007).
 * 3. Erase every external store (`OrgErasers`), then the database through `retention.delete_org`
 *    (audit events, the org row and its cascade through every tenant table, its inbox rows, and
 *    a tombstone in `app.org_deletions`).
 *
 * Idempotent and resumable: an org marked erasing is listed again and goes straight to step 3
 * until it is gone. Safe with several workers: the mark and `delete_org` lock the org row; a
 * second worker finds it gone and gets `22023`, counted as skipped (an org not marked erasing
 * gets `55000`, counted as failed). Nothing runs until the app check passed (M2): a wrong key
 * must not read as "every installation is gone".
 */

/**
 * invalid_parameter_value: not scheduled (gone: another worker erased it) or not due. An org
 * that is not marked erasing raises 55000 instead (review round 5, N2): it means this sweep
 * skipped its own mark, a bug, so it is a failure (logged, counted), never a skip.
 */
const NOT_SCHEDULED = "22023";

export interface SweepDeps {
  /** Must connect as the worker login. */
  readonly db: Db;
  readonly forge: InstallationReader;
  readonly appCheck: AppCheck;
  readonly erasers: OrgErasers;
  readonly log: Logger;
  /** Orgs per sweep (default 20). */
  readonly limit?: number;
}

export interface SweepReport {
  readonly due: number;
  readonly deleted: number;
  /** GitHub still has the installation: the deletion was cancelled. */
  readonly cancelled: number;
  /** GitHub did not answer: left for the next sweep. */
  readonly deferred: number;
  readonly skipped: number;
  readonly failed: number;
}

type OrgResult = "deleted" | "cancelled" | "deferred" | "skipped";

const codeOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$|^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : "internal_error";
};

/** Re-verifies a not-yet-erasing org with GitHub; returns a result to stop at, or "proceed". */
const reverify = async (deps: SweepDeps, org: DueOrg): Promise<OrgResult | "proceed"> => {
  let exists: { suspended: boolean } | null;
  try {
    const installation = await deps.forge.getInstallation(org.installationId);
    exists = installation === null ? null : { suspended: installation.suspended };
  } catch (error) {
    if (error instanceof ForgeReadError && error.reason === "unsupported_account_type") {
      exists = { suspended: false }; // it exists, on an account kind we do not model
    } else {
      deps.log.warn(
        { orgId: org.orgId, errorCode: codeOf(error) },
        "org erasure deferred: GitHub did not confirm the uninstall",
      );
      return "deferred";
    }
  }
  if (exists === null) return "proceed";
  const cancelled = await deps.db.withOrg(org.orgId, async (tx) => {
    if (!(await cancelOrgDeletion(tx))) return false;
    await auditLifecycle(
      tx,
      { type: "system", id: "org_deletion_sweep" },
      "org.erasure_cancelled",
      {
        installation_id: org.installationId,
        reason: "installation_exists",
        suspended: exists.suspended,
      },
    );
    return true;
  });
  deps.log.warn(
    { orgId: org.orgId, installationId: org.installationId, cancelled },
    "org erasure cancelled: the installation still exists",
  );
  return cancelled ? "cancelled" : "skipped";
};

const eraseOne = async (deps: SweepDeps, org: DueOrg): Promise<OrgResult> => {
  if (!org.erasing) {
    const verdict = await reverify(deps, org);
    if (verdict !== "proceed") return verdict;
    const begun = await deps.db.withOrg(org.orgId, async (tx) => {
      const state = await beginOrgErasure(tx);
      if (state === "started") {
        await auditLifecycle(
          tx,
          { type: "system", id: "org_deletion_sweep" },
          "org.erasure_started",
          { installation_id: org.installationId },
        );
      }
      return state;
    });
    if (begun === "not_due") {
      deps.log.info({ orgId: org.orgId }, "org erasure skipped: no longer due");
      return "skipped";
    }
  }
  for (const store of EXTERNAL_TENANT_STORES) await deps.erasers[store].eraseOrg(org.orgId);
  try {
    const tables = await deps.db.deleteOrg(org.orgId);
    deps.log.info(
      { orgId: org.orgId, deleted: Object.fromEntries(tables.map((t) => [t.table, t.deleted])) },
      "org erased",
    );
    return "deleted";
  } catch (error) {
    if (codeOf(error) === NOT_SCHEDULED) {
      deps.log.info({ orgId: org.orgId }, "org erasure skipped: already erased");
      return "skipped";
    }
    throw error;
  }
};

export const sweepOrgDeletions = async (deps: SweepDeps): Promise<SweepReport> => {
  const report = { due: 0, deleted: 0, cancelled: 0, deferred: 0, skipped: 0, failed: 0 };
  if (!(await deps.appCheck.ready())) return report;
  const due = (await deps.db.orgsDueForDeletion(deps.limit ?? 20)).filter(
    (org) => org.forge === deps.forge.kind,
  );
  report.due = due.length;
  for (const org of due) {
    try {
      report[await eraseOne(deps, org)]++;
    } catch (error) {
      report.failed++;
      deps.log.error(
        { orgId: org.orgId, errorCode: codeOf(error) },
        "org erasure failed; retried next sweep",
      );
    }
  }
  return report;
};
