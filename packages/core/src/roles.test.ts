import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_ROLES,
  can,
  isAssignableRole,
  isPermission,
  isRole,
  PERMISSION_MIN_ROLE,
  PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
} from "./roles.js";

/** The decision recorded in ADR 0024, written out per role so a change to the table shows here. */
const EXPECTED: Readonly<Record<Role, readonly Permission[]>> = {
  member: ["pull_requests.review", "drafts.own", "settings.own", "ask"],
  admin: [
    "pull_requests.review",
    "drafts.own",
    "settings.own",
    "ask",
    "members.read",
    "members.manage",
    "repo_settings.manage",
    "spend_caps.manage",
    "analysis.approve_over_limit",
    "memory.edit",
  ],
  owner: [...PERMISSIONS],
};

describe("roles (P7-2, ADR 0024)", () => {
  it("grants exactly the permissions of the decision, per role", () => {
    for (const role of ROLES) {
      const granted = PERMISSIONS.filter((p) => can(role, p));
      expect(granted.toSorted(), role).toEqual([...EXPECTED[role]].toSorted());
    }
  });

  it("nests roles: whatever a member can do an admin can, whatever an admin can an owner can", () => {
    for (const permission of PERMISSIONS) {
      if (can("member", permission)) expect(can("admin", permission)).toBe(true);
      if (can("admin", permission)) expect(can("owner", permission)).toBe(true);
    }
  });

  it("keeps billing, org deletion, admin promotion and ownership with the owner only", () => {
    for (const p of ["billing.manage", "org.delete", "roles.manage", "ownership.transfer"]) {
      expect(can("owner", p)).toBe(true);
      expect(can("admin", p)).toBe(false);
      expect(can("member", p)).toBe(false);
    }
    expect(can("admin", "analysis.approve_over_limit")).toBe(true);
    expect(can("member", "analysis.approve_over_limit")).toBe(false);
  });

  it("fails closed on anything that is not a known role and permission", () => {
    for (const role of ["", "Owner", "root", "superadmin", null, undefined, 2, {}, "__proto__"]) {
      expect(can(role, "ask"), String(role)).toBe(false);
    }
    for (const permission of ["", "*", "toString", "__proto__", "constructor", null, 1]) {
      expect(can("owner", permission), String(permission)).toBe(false);
    }
    expect(isRole("hasOwnProperty")).toBe(false);
    expect(isPermission("hasOwnProperty")).toBe(false);
  });

  it("assigns only member and admin by role change; owner moves by transfer", () => {
    expect(ASSIGNABLE_ROLES).toEqual(["member", "admin"]);
    expect(isAssignableRole("owner")).toBe(false);
    expect(isAssignableRole("admin")).toBe(true);
    expect(isAssignableRole("member")).toBe(true);
    expect(isAssignableRole("Admin")).toBe(false);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PERMISSION_MIN_ROLE)).toBe(true);
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });
});
