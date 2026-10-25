import { describe, expect, it } from "vitest";
import { selfHostEntitlements } from "./entitlements.js";
import type { OrgId } from "./ports.js";

const org = "org_1" as OrgId;

describe("selfHostEntitlements", () => {
  it("enables open-source features without a licence", async () => {
    const entitlements = selfHostEntitlements({ hasEnterpriseLicence: false });
    expect(await entitlements.can(org, "review.drafts")).toBe(true);
  });

  it("disables enterprise features without a licence", async () => {
    const entitlements = selfHostEntitlements({ hasEnterpriseLicence: false });
    expect(await entitlements.can(org, "ee:sso")).toBe(false);
  });

  it("enables enterprise features with a licence", async () => {
    const entitlements = selfHostEntitlements({ hasEnterpriseLicence: true });
    expect(await entitlements.can(org, "ee:sso")).toBe(true);
  });
});
