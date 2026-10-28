import { isAssignableRole, isRole, type AssignableRole, type Role } from "@rocky-reviews/core";
import { audit } from "./audit.js";
import type { TenantTx } from "./client.js";

/**
 * Roles and membership changes inside one org (P7-2, migration 0014, ADR 0024). Every function
 * runs in the caller's `withOrg` transaction, so RLS keeps it to that org, and audits in the same
 * transaction: a change without its audit event never commits.
 *
 * Who may call what is the server's policy (`can(role, permission)`); these functions re-check
 * what the database alone can know at the moment of the change (the target exists here, is not
 * removed, is or is not an owner, the actor is still the owner) with the rows locked, so a check
 * made a moment earlier cannot be raced. Changes to an org's owners take the org's owner lock
 * first (`app.lock_org_owners`), and the database refuses any change that would leave an org with
 * owners without one (trigger `members_keep_an_owner`).
 *
 * Results are fixed codes; errors carry no values.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MemberStoreError extends Error {
  override readonly name = "MemberStoreError";
}

const assertUuid = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new MemberStoreError(`members: ${what} must be a uuid`);
  }
  return value.toLowerCase();
};

const assertForgeId = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new MemberStoreError("members: forge user id must be a positive integer");
  }
  return value;
};

const lockOwners = (tx: TenantTx) => tx.query("select app.lock_org_owners($1::uuid)", [tx.orgId]);

interface MemberRow {
  id: string;
  forge_user_id: string;
  login: string;
  role: string;
  removed_at: Date | null;
  created_at: Date;
}

/** One member as an admin sees it: no token, no ciphertext, display login only. */
export interface OrgMemberView {
  readonly memberId: string;
  readonly forgeUserId: number;
  readonly login: string;
  readonly role: Role;
  readonly removed: boolean;
  readonly createdAt: Date;
}

const view = (row: MemberRow): OrgMemberView => {
  if (!isRole(row.role)) throw new MemberStoreError("members: unknown role in a row");
  return {
    memberId: row.id,
    forgeUserId: Number(row.forge_user_id),
    login: row.login,
    role: row.role,
    removed: row.removed_at !== null,
    createdAt: row.created_at,
  };
};

/** Most members one listing returns (an org larger than this is a follow-up: paging). */
export const MAX_MEMBER_LISTING = 1000;

/** The org's members, removed ones included (they can be re-added), owners first. */
export const listMembers = async (tx: TenantTx): Promise<OrgMemberView[]> => {
  const { rows } = await tx.query<MemberRow>(
    `select id, forge_user_id::text, login, role, removed_at, created_at from members
      where org_id = $1
      order by (removed_at is not null), case role when 'owner' then 0 when 'admin' then 1 else 2 end,
               lower(login), id
      limit $2`,
    [tx.orgId, MAX_MEMBER_LISTING],
  );
  return rows.map(view);
};

/** The target, locked for this transaction; `null` when it is not a member row of this org. */
const lockMember = async (tx: TenantTx, memberId: string): Promise<MemberRow | null> => {
  const { rows } = await tx.query<MemberRow>(
    `select id, forge_user_id::text, login, role, removed_at, created_at from members
      where org_id = $1 and id = $2 for update`,
    [tx.orgId, memberId],
  );
  return rows[0] ?? null;
};

/** Ends this org in every live session of the member (the links are what sessions use). */
const cutSessions = async (tx: TenantTx, memberId: string): Promise<number> => {
  const { rowCount } = await tx.query(
    "delete from app.session_orgs where org_id = $1 and member_id = $2",
    [tx.orgId, memberId],
  );
  return rowCount ?? 0;
};

const clearToken = (tx: TenantTx, memberId: string) =>
  tx.query(
    `update members
        set forge_token_ciphertext = null, forge_token_key_version = null,
            forge_access_expires_at = null, updated_at = now()
      where org_id = $1 and id = $2`,
    [tx.orgId, memberId],
  );

/**
 * The first owner (ADR 0024 §2): makes `memberId` the owner only while the org has no owner, and
 * only once (the owner lock serialises two first sign-ins). The caller decides who qualifies (an
 * admin of the GitHub organization, or a User account's owner). Later GitHub role changes never
 * come through here once the org has an owner. `true` when this call made the owner.
 */
export const claimFirstOwner = async (tx: TenantTx, memberId: string): Promise<boolean> => {
  const id = assertUuid(memberId, "member id");
  await lockOwners(tx);
  const { rowCount } = await tx.query(
    `update members set role = 'owner', updated_at = now()
      where org_id = $1 and id = $2 and removed_at is null
        and not exists (select 1 from members o
                         where o.org_id = $1 and o.role = 'owner' and o.removed_at is null)`,
    [tx.orgId, id],
  );
  if (rowCount !== 1) return false;
  await audit(tx, { type: "system", id: "sign_in" }, "member.first_owner", {
    type: "member",
    id,
  });
  return true;
};

export type RoleChangeResult =
  | { readonly outcome: "changed"; readonly from: Role; readonly to: AssignableRole }
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "not_found" }
  /** An owner's role moves only by transfer (and the org must keep one). */
  | { readonly outcome: "target_is_owner" };

/**
 * Promotes a member to admin or demotes an admin to member (owners only, by the server's
 * policy). The actor must not be the target: an owner changes their own role by transferring
 * ownership. Audited `member.role_changed`.
 */
export const changeMemberRole = async (
  tx: TenantTx,
  input: {
    readonly actorMemberId: string;
    readonly targetMemberId: string;
    readonly role: unknown;
  },
): Promise<RoleChangeResult> => {
  const actor = assertUuid(input.actorMemberId, "actor id");
  const target = assertUuid(input.targetMemberId, "member id");
  if (!isAssignableRole(input.role)) throw new MemberStoreError("members: role not assignable");
  const role = input.role;
  await lockOwners(tx);
  const row = await lockMember(tx, target);
  if (row === null || row.removed_at !== null) return { outcome: "not_found" };
  if (row.role === "owner") return { outcome: "target_is_owner" };
  if (!isRole(row.role)) throw new MemberStoreError("members: unknown role in a row");
  if (row.role === role) return { outcome: "unchanged" };
  const from = row.role;
  await tx.query("update members set role = $3, updated_at = now() where org_id = $1 and id = $2", [
    tx.orgId,
    target,
    role,
  ]);
  await audit(
    tx,
    { type: "user", id: actor },
    "member.role_changed",
    { type: "member", id: target },
    {
      from,
      to: role,
    },
  );
  return { outcome: "changed", from, to: role };
};

export type RemoveMemberResult =
  | { readonly outcome: "removed"; readonly sessionsCut: number }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "already_removed" }
  | { readonly outcome: "target_is_owner" }
  | { readonly outcome: "self" };

/**
 * Removes a member in Rocky (admins and owners, by the server's policy): durable `removed_at`,
 * the stored token deleted, the org cut from every live session of theirs, audited
 * `member.removed`. Never an owner (ownership moves by transfer first) and never oneself. The
 * next sign-in does not bring them back; `restoreMember` does. Call the access check's
 * `invalidateMember` after the commit.
 */
export const removeMember = async (
  tx: TenantTx,
  input: { readonly actorMemberId: string; readonly targetMemberId: string },
): Promise<RemoveMemberResult> => {
  const actor = assertUuid(input.actorMemberId, "actor id");
  const target = assertUuid(input.targetMemberId, "member id");
  if (actor === target) return { outcome: "self" };
  await lockOwners(tx);
  const row = await lockMember(tx, target);
  if (row === null) return { outcome: "not_found" };
  if (row.removed_at !== null) return { outcome: "already_removed" };
  if (row.role === "owner") return { outcome: "target_is_owner" };
  await tx.query(
    `update members
        set removed_at = now(), forge_token_ciphertext = null, forge_token_key_version = null,
            forge_access_expires_at = null, updated_at = now()
      where org_id = $1 and id = $2`,
    [tx.orgId, target],
  );
  const sessionsCut = await cutSessions(tx, target);
  await audit(
    tx,
    { type: "user", id: actor },
    "member.removed",
    { type: "member", id: target },
    {
      role: row.role,
      sessionsCut,
    },
  );
  return { outcome: "removed", sessionsCut };
};

export type RestoreMemberResult =
  | { readonly outcome: "restored" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "not_removed" };

/**
 * Re-adds a member removed in Rocky (admins and owners): clears `removed_at` and resets the role
 * to `member` (a returning person gets no privilege back by default). They regain access at
 * their next sign-in, and only if GitHub still says they are a member. Audited `member.restored`.
 */
export const restoreMember = async (
  tx: TenantTx,
  input: { readonly actorMemberId: string; readonly targetMemberId: string },
): Promise<RestoreMemberResult> => {
  const actor = assertUuid(input.actorMemberId, "actor id");
  const target = assertUuid(input.targetMemberId, "member id");
  const row = await lockMember(tx, target);
  if (row === null) return { outcome: "not_found" };
  if (row.removed_at === null) return { outcome: "not_removed" };
  await tx.query(
    `update members set removed_at = null, role = 'member', updated_at = now()
      where org_id = $1 and id = $2`,
    [tx.orgId, target],
  );
  await audit(tx, { type: "user", id: actor }, "member.restored", { type: "member", id: target });
  return { outcome: "restored" };
};

export type TransferResult =
  | { readonly outcome: "transferred" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "self" }
  /** The actor is no longer an active owner of this org (changed since the request began). */
  | { readonly outcome: "not_owner" };

/**
 * Transfers ownership (owners only): the target becomes the owner and the actor an admin, in one
 * transaction under the owner lock, so the org has an owner at every step. Audited
 * `org.ownership_transferred`.
 */
export const transferOwnership = async (
  tx: TenantTx,
  input: { readonly actorMemberId: string; readonly targetMemberId: string },
): Promise<TransferResult> => {
  const actor = assertUuid(input.actorMemberId, "actor id");
  const target = assertUuid(input.targetMemberId, "member id");
  if (actor === target) return { outcome: "self" };
  await lockOwners(tx);
  const me = await lockMember(tx, actor);
  if (me === null || me.removed_at !== null || me.role !== "owner") return { outcome: "not_owner" };
  const row = await lockMember(tx, target);
  if (row === null || row.removed_at !== null) return { outcome: "not_found" };
  // The new owner first, so the trigger sees an owner when the old one steps down.
  await tx.query(
    "update members set role = 'owner', updated_at = now() where org_id = $1 and id = $2",
    [tx.orgId, target],
  );
  await tx.query(
    "update members set role = 'admin', updated_at = now() where org_id = $1 and id = $2",
    [tx.orgId, actor],
  );
  await audit(
    tx,
    { type: "user", id: actor },
    "org.ownership_transferred",
    { type: "member", id: target },
    { previousRole: row.role },
  );
  return { outcome: "transferred" };
};

/**
 * The forge says this person is no longer a member of the organization (the `organization`
 * webhook, or a sign-in where GitHub answered "not a member"). Their stored token is deleted and
 * the org is cut from every live session of theirs; the member row and its role stay (they come
 * back by signing in once GitHub has them again). Nothing is granted here. Audited
 * `member.left_forge` when a row existed. Returns the member id, or `null` when there is none.
 * Call the access check's `invalidateMember` after the commit.
 */
export const memberLeftForge = async (
  tx: TenantTx,
  input: {
    readonly forgeUserId: number;
    readonly source: "webhook" | "sign_in";
    readonly actorId: string;
  },
): Promise<{ memberId: string; sessionsCut: number } | null> => {
  const forgeUserId = assertForgeId(input.forgeUserId);
  if (input.source !== "webhook" && input.source !== "sign_in") {
    throw new MemberStoreError("members: unknown source");
  }
  const { rows } = await tx.query<{ id: string }>(
    "select id from members where org_id = $1 and forge_user_id = $2 for update",
    [tx.orgId, forgeUserId],
  );
  const memberId = rows[0]?.id;
  if (memberId === undefined) return null;
  await clearToken(tx, memberId);
  const sessionsCut = await cutSessions(tx, memberId);
  await audit(
    tx,
    { type: input.source === "webhook" ? "forge" : "system", id: input.actorId },
    "member.left_forge",
    { type: "member", id: memberId },
    { source: input.source, sessionsCut },
  );
  return { memberId, sessionsCut };
};
