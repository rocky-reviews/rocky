import type { ForgeKind, OrgMemberEvent } from "@rocky-reviews/core";
import { completeInTenantTx, memberLeftForge, type Db, type InboxLease } from "@rocky-reviews/db";

/**
 * Someone left the GitHub organization (P7-2, ADR 0024 §6): the `organization` webhook's
 * `member_removed`, decoded to `org_member.removed`. Inside the org's `withOrg`, their stored
 * token is deleted and the org is cut from every live session of theirs, and the inbox row is
 * completed in the same transaction (a lost lease rolls it all back).
 *
 * Trust boundary: the event is authenticated by the webhook signature, and it can only take
 * access away; nothing is granted from it. So it is acted on without asking GitHub again: a
 * replayed or reordered delivery can at most sign someone out early, and they sign in again
 * (GitHub is asked then). The org must be bound to both the installation and the organization's
 * account id, as at login; an event naming another account is parked, never applied.
 *
 * Logs (by the inbox drain) carry ids and outcome codes; never logins or tokens.
 */

/** No forge call: the database transaction plus slack. */
export const ORG_MEMBER_ROW_BUDGET_SECONDS = 10;

export type OrgMemberOutcome = "member_left" | "no_member" | "no_org";

/** The event names an account that is not the one the installation's org is bound to. */
export class OrgBindingMismatchError extends Error {
  override readonly name = "OrgBindingMismatchError";
  readonly code = "account_mismatch";
  constructor() {
    super("org member event: account does not match the org binding");
  }
}

export interface OrgMemberDeps {
  readonly db: Db;
  readonly forge: { readonly kind: ForgeKind };
}

export const reconcileOrgMember = async (
  deps: OrgMemberDeps,
  lease: InboxLease & { readonly deliveryId: string },
  event: OrgMemberEvent,
): Promise<{ readonly outcome: OrgMemberOutcome; readonly completed: boolean }> => {
  const [org] = (
    await deps.db.installationOrgs(deps.forge.kind, event.installationId, null)
  ).filter((o) => o.installationId === event.installationId);
  // No org yet (or already erased): nobody can be signed in to it, so there is nothing to cut.
  if (org === undefined) return { outcome: "no_org", completed: false };
  if (org.accountId !== event.account.id) throw new OrgBindingMismatchError();
  return deps.db.withOrg(org.orgId, async (tx) => {
    const left = await memberLeftForge(tx, {
      forgeUserId: event.memberForgeUserId,
      source: "webhook",
      actorId: lease.deliveryId,
    });
    const outcome: OrgMemberOutcome = left === null ? "no_member" : "member_left";
    await completeInTenantTx(tx, lease, outcome);
    return { outcome, completed: true };
  });
};
