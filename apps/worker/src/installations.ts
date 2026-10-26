import {
  ForgeReadError,
  type ForgeInstallation,
  type InstallationEvent,
  type InstallationReader,
  type OrgId,
} from "@rocky-reviews/core";
import {
  auditLifecycle,
  bindInstallation,
  completeInTenantTx,
  insertInstallationOrg,
  scheduleOrgDeletion,
  type Db,
  type InboxLease,
} from "@rocky-reviews/db";

/**
 * The installation lifecycle (P3-3, ADR 0009). An inbox row is a hint; GitHub is the fact
 * (ADR 0007 §4). Every decision is taken on what `GET /app/installations/{id}` answers now, so
 * a forged, planted, replayed or out-of-order row can at most cause a redundant read:
 *
 * When GitHub contradicts the event (a `created` it answers 404 for, a `deleted` it still has),
 * the row is retried with backoff for its first CONTRADICTION_ATTEMPTS attempts (GitHub's API can
 * lag its webhooks), each a strike; after that GitHub's answer is final (review round 1, S1).
 *
 * `installation.created` (GitHub must say the installation exists):
 * - an org is bound to this installation id: nothing to do, or, if its deletion is scheduled,
 *   cancel it (the same id exists again: a redelivery after a transient 404, never a real
 *   reinstall, since GitHub issues a new id for that);
 * - an org is bound to the same account under an older installation id that GitHub now says is
 *   gone: a reinstall. Rebind the org to the new id and cancel any scheduled deletion; its data
 *   survives (this is what the grace period is for);
 * - otherwise: create a new org (also after an earlier org of the account was erased).
 *
 * `installation.deleted` (GitHub must answer 404): schedule the deletion of the org bound to
 * this installation id; the database enforces the grace period and audits it (migration 0005).
 * A deadline beyond the grace window is rescheduled, an in-window one kept (review round 1, H1).
 * A suspended installation still exists: nothing is scheduled.
 *
 * Every tenant effect, its audit events and the inbox "processed" mark commit in one `withOrg`
 * transaction, so a crash or a lost lease never applies an effect twice.
 */

/** Fixed outcome codes: stored on the inbox row and logged. */
export type InstallationOutcome =
  | "org_created"
  | "org_reinstalled"
  | "org_rebound"
  | "already_installed"
  | "installation_not_found"
  | "unsupported_account_type"
  | "deletion_scheduled"
  | "deletion_already_scheduled"
  | "no_org"
  | "installation_exists";

export interface InstallationResult {
  readonly outcome: InstallationOutcome;
  /** True when the inbox row was already marked processed inside the tenant transaction. */
  readonly completed: boolean;
}

/** A row that cannot succeed as it is; parked for a human with this code. */
export class ParkDeliveryError extends Error {
  override readonly name = "ParkDeliveryError";
  constructor(
    readonly code: "account_mismatch" | "account_has_live_installation" | "forge_mismatch",
  ) {
    super(`installation lifecycle: ${code}`);
  }
}

/** Attempts during which GitHub contradicting the event is retried rather than believed. */
export const CONTRADICTION_ATTEMPTS = 3;

/** GitHub contradicts the event, possibly because its API lags the webhook: retry (a strike). */
export class ContradictionError extends Error {
  override readonly name = "ContradictionError";
  readonly code = "forge_contradiction";
  constructor() {
    super("installation lifecycle: GitHub contradicts the event");
  }
}

/** State changed between the lookup and the write (a concurrent rebind or erasure): retry. */
export class StaleOrgError extends Error {
  override readonly name = "StaleOrgError";
  readonly code = "org_changed";
  constructor() {
    super("installation lifecycle: org changed concurrently");
  }
}

export interface InstallationDeps {
  /** Must connect as the worker login (creates orgs, reads the installation lookup). */
  readonly db: Db;
  readonly forge: InstallationReader;
  readonly newOrgId: () => OrgId;
}

type Verified =
  | { readonly kind: "exists"; readonly installation: ForgeInstallation }
  | { readonly kind: "gone" }
  | { readonly kind: "unsupported" };

/** Asks the forge; an outage throws (the row is retried), it is never read as "gone". */
const verify = async (forge: InstallationReader, installationId: number): Promise<Verified> => {
  try {
    const installation = await forge.getInstallation(installationId);
    return installation === null ? { kind: "gone" } : { kind: "exists", installation };
  } catch (error) {
    if (error instanceof ForgeReadError && error.reason === "unsupported_account_type") {
      return { kind: "unsupported" };
    }
    throw error;
  }
};

export const reconcileInstallation = async (
  deps: InstallationDeps,
  lease: InboxLease & { readonly attempts: number },
  event: InstallationEvent,
): Promise<InstallationResult> => {
  const forge = deps.forge.kind;
  const actor = { type: "forge" as const, id: lease.deliveryId };
  const verified = await verify(deps.forge, event.installationId);
  const contradicts =
    event.type === "installation.deleted" ? verified.kind !== "gone" : verified.kind === "gone";
  if (contradicts && lease.attempts < CONTRADICTION_ATTEMPTS) throw new ContradictionError();

  if (event.type === "installation.deleted") {
    if (verified.kind !== "gone") {
      // Still installed (active, suspended, or on an unmodelled account): not an uninstall.
      const [org] = (await deps.db.installationOrgs(forge, event.installationId, null)).filter(
        (o) => o.installationId === event.installationId,
      );
      if (org === undefined) return { outcome: "installation_exists", completed: false };
      await deps.db.withOrg(org.orgId, async (tx) => {
        await auditLifecycle(tx, actor, "org.uninstall_ignored", {
          installation_id: event.installationId,
          suspended: verified.kind === "exists" && verified.installation.suspended,
        });
        await completeInTenantTx(tx, lease, "installation_exists");
      });
      return { outcome: "installation_exists", completed: true };
    }
    const [org] = (await deps.db.installationOrgs(forge, event.installationId, null)).filter(
      (o) => o.installationId === event.installationId,
    );
    if (org === undefined) return { outcome: "no_org", completed: false };
    // Scheduled even when a deadline exists: one beyond the grace window is replaced (H1).
    const outcome = await deps.db.withOrg(org.orgId, async (tx) => {
      const scheduled = await scheduleOrgDeletion(tx, event.installationId);
      if (scheduled === "stale") throw new StaleOrgError();
      const code = scheduled === "scheduled" ? "deletion_scheduled" : "deletion_already_scheduled";
      if (scheduled === "scheduled") {
        await auditLifecycle(tx, actor, "org.uninstalled", {
          installation_id: event.installationId,
          uninstalled_by: event.sender?.id ?? null,
          rescheduled: org.deleteAfter !== null,
        });
      }
      await completeInTenantTx(tx, lease, code);
      return code;
    });
    return { outcome, completed: true };
  }

  // installation.created
  if (verified.kind === "gone") return { outcome: "installation_not_found", completed: false };
  if (verified.kind === "unsupported") {
    return { outcome: "unsupported_account_type", completed: false };
  }
  const installation = verified.installation;
  const account = installation.account;
  const orgs = await deps.db.installationOrgs(forge, installation.id, account.id);
  const byInstallation = orgs.find((o) => o.installationId === installation.id);
  const byAccount = orgs.find((o) => o.accountId === account.id);

  if (byInstallation !== undefined) {
    // Bound by installation id; the account is immutable, so a mismatch is not ours to fix.
    if (byInstallation.accountId !== account.id) throw new ParkDeliveryError("account_mismatch");
    if (byInstallation.deleteAfter === null) {
      return { outcome: "already_installed", completed: false };
    }
    await deps.db.withOrg(byInstallation.orgId, async (tx) => {
      const bound = await bindInstallation(tx, {
        expectedInstallationId: installation.id,
        installationId: installation.id,
        login: account.login,
        kind: account.kind,
      });
      if (!bound) throw new StaleOrgError();
      await auditLifecycle(tx, actor, "org.reinstalled", {
        installation_id: installation.id,
        previous_installation_id: installation.id,
        deletion_cancelled: true,
      });
      await completeInTenantTx(tx, lease, "org_reinstalled");
    });
    return { outcome: "org_reinstalled", completed: true };
  }

  if (byAccount !== undefined) {
    // A new installation id for an account that has an org: a reinstall, but only once GitHub
    // confirms the old installation is gone (one installation per app per account).
    const previous = await verify(deps.forge, byAccount.installationId);
    if (previous.kind !== "gone") {
      // The old installation's removal may not have reached the API yet (S1).
      if (lease.attempts < CONTRADICTION_ATTEMPTS) throw new ContradictionError();
      throw new ParkDeliveryError("account_has_live_installation");
    }
    await deps.db.withOrg(byAccount.orgId, async (tx) => {
      const bound = await bindInstallation(tx, {
        expectedInstallationId: byAccount.installationId,
        installationId: installation.id,
        login: account.login,
        kind: account.kind,
      });
      if (!bound) throw new StaleOrgError();
      await auditLifecycle(tx, actor, "org.reinstalled", {
        installation_id: installation.id,
        previous_installation_id: byAccount.installationId,
        deletion_cancelled: byAccount.deleteAfter !== null,
      });
      await completeInTenantTx(tx, lease, "org_rebound");
    });
    return { outcome: "org_rebound", completed: true };
  }

  // A new tenant. Identity comes from GitHub's answer, not from the event. The installer is
  // whoever the (signed) webhook names, kept only when the event agrees with GitHub about the
  // account: a candidate for the first admin that P7-1 must verify, never a membership.
  const installer =
    event.sender !== null && event.account.id === account.id ? event.sender.id : null;
  const orgId = deps.newOrgId();
  await deps.db.withOrg(orgId, async (tx) => {
    await insertInstallationOrg(tx, {
      forge,
      installationId: installation.id,
      accountId: account.id,
      login: account.login,
      kind: account.kind,
      installerForgeUserId: installer,
    });
    await auditLifecycle(tx, actor, "org.installed", {
      installation_id: installation.id,
      account_id: account.id,
      account_kind: account.kind,
      installer_id: installer,
      suspended: installation.suspended,
    });
    await completeInTenantTx(tx, lease, "org_created");
  });
  return { outcome: "org_created", completed: true };
};
