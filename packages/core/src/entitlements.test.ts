import { describe, expect, it } from "vitest";
import { selfHostEntitlements } from "./entitlements.js";
import { entitlementsConformance, type EntitlementsHarness } from "./entitlements-conformance.js";
import { FEATURES, type Feature, type OrgId } from "./ports.js";

const org = "org_1" as OrgId;
const other = "org_2" as OrgId;
const OSS = FEATURES.filter((f) => !f.startsWith("ee:"));

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

  it("fails closed on an unknown feature, with or without a licence", async () => {
    for (const hasEnterpriseLicence of [false, true]) {
      const entitlements = selfHostEntitlements({ hasEnterpriseLicence });
      expect(await entitlements.can(org, "review.unknown" as Feature)).toBe(false);
    }
  });
});

/** C-8: the shared suite every implementation passes; Rocky Cloud runs it on its own. */
const harnesses: readonly (readonly [string, () => EntitlementsHarness])[] = [
  [
    "without a licence",
    () => ({
      readsState: false,
      entitlements: selfHostEntitlements({ hasEnterpriseLicence: false }),
      orgs: [
        { label: "org 1", org, features: OSS },
        { label: "org 2", org: other, features: OSS },
      ],
    }),
  ],
  [
    "with a licence",
    () => ({
      readsState: false,
      entitlements: selfHostEntitlements({ hasEnterpriseLicence: true }),
      orgs: [
        { label: "org 1", org, features: FEATURES },
        { label: "org 2", org: other, features: FEATURES },
      ],
    }),
  ],
];

describe.each(harnesses)("selfHostEntitlements conformance %s", (_label, harness) => {
  it.each(entitlementsConformance.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    await c.run(harness());
  });
});
