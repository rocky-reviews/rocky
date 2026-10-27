import type { ForgeAccountKind, ForgeKind, OrgId } from "@rocky-reviews/core";
import { audit, type AuditActor } from "./audit.js";
import type { TenantTx } from "./client.js";

/**
 * Org rows for the installation lifecycle (migration 0007, ADR 0009). All writes run inside
 * `withOrg` (the org's own tenant transaction); creating an org needs the worker login, the only
 * one with INSERT on `orgs`. Orgs are bound by (forge, installation id) and the forge's immutable
 * account id, never by login.
 */

/** An org bound to an installation or to its account, as the lookup returns it (ids only). */
export interface InstallationOrg {
  readonly orgId: OrgId;
  readonly installationId: number;
  readonly accountId: number;
  readonly deleteAfter: Date | null;
}

export interface InstallationOrgRow {
  org_id: string;
  installation_id: string;
  account_id: string;
  delete_after: Date | null;
}

export const INSTALLATION_ORGS_SQL =
  "select org_id, installation_id::text, account_id::text, delete_after from worker.installation_orgs($1, $2, $3)";

export const installationOrgFromRow = (row: InstallationOrgRow): InstallationOrg => ({
  orgId: row.org_id as OrgId,
  installationId: Number(row.installation_id),
  accountId: Number(row.account_id),
  deleteAfter: row.delete_after,
});

/** Everything the org row holds about its installation; values come from the forge, not the event. */
export interface NewInstallationOrg {
  readonly forge: ForgeKind;
  readonly installationId: number;
  readonly accountId: number;
  /** Display only (renamed and reused on the forge). */
  readonly login: string;
  readonly kind: ForgeAccountKind;
  /** Candidate first admin from the webhook sender; null when unknown or not trusted. */
  readonly installerForgeUserId: number | null;
}

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const checkNewOrg = (org: NewInstallationOrg): void => {
  if (!isId(org.installationId) || !isId(org.accountId)) throw new Error("org: invalid ids");
  if (org.installerForgeUserId !== null && !isId(org.installerForgeUserId)) {
    throw new Error("org: invalid installer id");
  }
  if (typeof org.login !== "string" || !LOGIN.test(org.login))
    throw new Error("org: invalid login");
  if (org.kind !== "organization" && org.kind !== "user") throw new Error("org: invalid kind");
};

/** Inserts the org row for `tx.orgId` (the tenant being created). Worker login only. */
export const insertInstallationOrg = async (
  tx: TenantTx,
  org: NewInstallationOrg,
): Promise<void> => {
  checkNewOrg(org);
  await tx.query(
    `insert into orgs (id, forge, installation_id, account_id, login, kind, installer_forge_user_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tx.orgId,
      org.forge,
      org.installationId,
      org.accountId,
      org.login,
      org.kind,
      org.installerForgeUserId,
    ],
  );
};

/**
 * Schedules the deletion of `tx.orgId` while it is still bound to `installationId` and not being
 * erased. The database pushes the date to at least `now() + grace` and audits it (0005/0007). An
 * existing schedule is kept, unless it lies beyond the grace window (a date written before the
 * window was enforced, or by hand): then it is rescheduled, never treated as "already scheduled".
 */
export const scheduleOrgDeletion = async (
  tx: TenantTx,
  installationId: number,
): Promise<"scheduled" | "already_scheduled" | "stale"> => {
  const { rowCount } = await tx.query(
    `update orgs set delete_after = now(), updated_at = now()
      where id = $1 and installation_id = $2 and erasing_at is null
        and (delete_after is null
             or delete_after > now() + interval '1 hour' + make_interval(days => (
                  select s.days from app.retention_settings s
                   where s.category = 'org_deletion_grace')))`,
    [tx.orgId, installationId],
  );
  if (rowCount === 1) return "scheduled";
  const { rows } = await tx.query<{ bound: boolean }>(
    "select installation_id = $2 and erasing_at is null as bound from orgs where id = $1",
    [tx.orgId, installationId],
  );
  return rows[0]?.bound === true ? "already_scheduled" : "stale";
};

/**
 * Binds `tx.orgId` to `installationId` (same id: a no-op rebind) and cancels any scheduled
 * deletion; refreshes the display fields from the forge. Only applies while the org is still
 * bound to `expectedInstallationId` and not being erased (a concurrent rebind or erasure makes it
 * return false). Worker login only (column grants and trigger `orgs_guard_identity`).
 */
export const bindInstallation = async (
  tx: TenantTx,
  options: {
    expectedInstallationId: number;
    installationId: number;
    login: string;
    kind: ForgeAccountKind;
  },
): Promise<boolean> => {
  if (!isId(options.expectedInstallationId) || !isId(options.installationId)) {
    throw new Error("org: invalid ids");
  }
  if (!LOGIN.test(options.login)) throw new Error("org: invalid login");
  if (options.kind !== "organization" && options.kind !== "user") {
    throw new Error("org: invalid kind");
  }
  const { rowCount } = await tx.query(
    `update orgs set installation_id = $3, login = $4, kind = $5, delete_after = null,
                     updated_at = now()
      where id = $1 and installation_id = $2 and erasing_at is null`,
    [tx.orgId, options.expectedInstallationId, options.installationId, options.login, options.kind],
  );
  return rowCount === 1;
};

/** Cancels a scheduled deletion that has not started erasing. False when there was none. */
export const cancelOrgDeletion = async (tx: TenantTx): Promise<boolean> => {
  const { rowCount } = await tx.query(
    `update orgs set delete_after = null, updated_at = now()
      where id = $1 and delete_after is not null and erasing_at is null`,
    [tx.orgId],
  );
  return rowCount === 1;
};

/**
 * Marks `tx.orgId` as being erased (the point of no return) under its row lock, once its grace
 * period is over. `started` the first time, `resumed` when an earlier sweep already started (it
 * crashed or an external store failed), `not_due` when it is no longer scheduled or not yet due.
 */
export const beginOrgErasure = async (tx: TenantTx): Promise<"started" | "resumed" | "not_due"> => {
  const { rowCount } = await tx.query(
    `update orgs set erasing_at = now(), updated_at = now()
      where id = $1 and erasing_at is null and delete_after is not null and delete_after <= now()`,
    [tx.orgId],
  );
  if (rowCount === 1) return "started";
  const { rows } = await tx.query<{ erasing: boolean }>(
    "select erasing_at is not null as erasing from orgs where id = $1",
    [tx.orgId],
  );
  return rows[0]?.erasing === true ? "resumed" : "not_due";
};

/** Appends a lifecycle audit event for `tx.orgId`: ids only (ADR 0005 §5). */
export const auditLifecycle = async (
  tx: TenantTx,
  actor: AuditActor,
  action:
    | "org.installed"
    | "org.uninstalled"
    | "org.reinstalled"
    | "org.uninstall_ignored"
    | "org.erasure_cancelled"
    | "org.erasure_started",
  metadata: Record<string, number | boolean | string | null>,
): Promise<void> => {
  await audit(tx, actor, action, { type: "org", id: tx.orgId }, metadata);
};
