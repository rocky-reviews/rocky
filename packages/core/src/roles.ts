/**
 * Roles per org and what each may do (P7-2, ADR 0024). The one table every server route is
 * checked against: a route declares a permission, never a role, so moving a permission between
 * roles is a change here and nowhere else.
 *
 * - member: review pull requests (only repositories GitHub lets them read, P3-6), their own
 *   drafts and settings, Ask;
 * - admin: everything a member can do, plus managing members (remove, re-add), repository and
 *   analysis settings, spend caps, approving an analysis over the token limit, project memory;
 * - owner: everything an admin can do, plus billing, deleting the org, promoting and demoting
 *   admins, and transferring ownership.
 *
 * Roles never widen GitHub access: an owner still sees a repository only while GitHub gives them
 * read access, and only a human posts.
 */

export const ROLES = ["member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Readonly<Record<Role, number>> = { member: 0, admin: 1, owner: 2 };

/** Each permission and the least role that holds it. Roles are strictly nested. */
export const PERMISSION_MIN_ROLE = Object.freeze({
  "pull_requests.review": "member",
  "drafts.own": "member",
  "settings.own": "member",
  ask: "member",
  "members.read": "admin",
  "members.manage": "admin",
  "repo_settings.manage": "admin",
  "spend_caps.manage": "admin",
  "analysis.approve_over_limit": "admin",
  "memory.edit": "admin",
  "billing.manage": "owner",
  "org.delete": "owner",
  "roles.manage": "owner",
  "ownership.transfer": "owner",
} as const satisfies Record<string, Role>);

export type Permission = keyof typeof PERMISSION_MIN_ROLE;

export const PERMISSIONS = Object.freeze(Object.keys(PERMISSION_MIN_ROLE)) as readonly Permission[];

export const isRole = (value: unknown): value is Role =>
  typeof value === "string" && Object.hasOwn(RANK, value);

export const isPermission = (value: unknown): value is Permission =>
  typeof value === "string" && Object.hasOwn(PERMISSION_MIN_ROLE, value);

/**
 * Whether `role` holds `permission`. Fails closed: an unknown role or permission (a typo, a value
 * read from somewhere unexpected) is `false`.
 */
export const can = (role: unknown, permission: unknown): boolean => {
  if (!isRole(role) || !isPermission(permission)) return false;
  return RANK[role] >= RANK[PERMISSION_MIN_ROLE[permission]];
};

/** Roles an owner may give with a role change; `owner` moves only by transfer. */
export const ASSIGNABLE_ROLES = ["member", "admin"] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const isAssignableRole = (value: unknown): value is AssignableRole =>
  value === "member" || value === "admin";
