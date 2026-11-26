import { describe, expect, it } from "vitest";
import {
  ANALYSIS_FEATURES,
  checkEntitlement,
  ENTITLEMENT_DENIED,
  isEntitlementReason,
  selfHostEntitlements,
} from "./entitlements.js";
import { entitlementsConformance, type EntitlementsHarness } from "./entitlements-conformance.js";
import { FEATURES, type Entitlements, type Feature, type OrgId } from "./ports.js";

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

/**
 * C-8: the check the app runs before work that costs AI or is plan-gated (ADR 0046). Granted only
 * on an exact `true`; everything else, a throw included, is a denial with a fixed reason.
 */
describe("checkEntitlement", () => {
  const granting: Entitlements = { can: () => Promise.resolve(true) };
  const denying: Entitlements = { can: () => Promise.resolve(false) };

  it("grants on true, denies on false with the fixed reason", async () => {
    expect(await checkEntitlement(granting, org, "review.ask")).toEqual({ granted: true });
    expect(await checkEntitlement(denying, org, "review.ask")).toEqual({
      granted: false,
      code: ENTITLEMENT_DENIED,
      feature: "review.ask",
      reason: "denied",
    });
  });

  it("fails closed: a throwing or rejecting `can` is a denial (`unavailable`), never a throw", async () => {
    const rejecting: Entitlements = { can: () => Promise.reject(new Error("billing db down")) };
    const throwing: Entitlements = {
      can: () => {
        throw new TypeError("boom");
      },
    };
    for (const e of [rejecting, throwing]) {
      expect(await checkEntitlement(e, org, "review.triage")).toEqual({
        granted: false,
        code: ENTITLEMENT_DENIED,
        feature: "review.triage",
        reason: "unavailable",
      });
    }
  });

  it("fails closed on a non-boolean answer (a truthy value is not a grant)", async () => {
    const sloppy = { can: () => Promise.resolve(1) } as unknown as Entitlements;
    const undefinedAnswer = { can: () => Promise.resolve(undefined) } as unknown as Entitlements;
    for (const e of [sloppy, undefinedAnswer]) {
      expect(await checkEntitlement(e, org, "review.drafts")).toMatchObject({
        granted: false,
        reason: "denied",
      });
    }
  });

  it("refuses an unknown feature before asking the implementation", async () => {
    let asked = 0;
    const counting: Entitlements = {
      can: () => {
        asked++;
        return Promise.resolve(true);
      },
    };
    expect(await checkEntitlement(counting, org, "review.nope" as Feature)).toMatchObject({
      granted: false,
      reason: "unknown-feature",
    });
    expect(asked).toBe(0);
  });

  it("passes a safe reason through from `decide`, only when `can` denied", async () => {
    let decided = 0;
    const withReason: Entitlements = {
      can: (_org, feature) => Promise.resolve(feature === "review.ask"),
      decide: () => {
        decided++;
        return Promise.resolve({ granted: false, reason: "lapsed" });
      },
    };
    expect(await checkEntitlement(withReason, org, "review.ask")).toEqual({ granted: true });
    expect(decided).toBe(0);
    expect(await checkEntitlement(withReason, org, "review.memory")).toMatchObject({
      granted: false,
      reason: "lapsed",
    });
    expect(decided).toBe(1);
  });

  it("never leaks an unsafe reason: anything but a short kebab-case code becomes `denied`", async () => {
    const unsafe = [
      "Lapsed",
      "no plan",
      "plan:team-42",
      "x".repeat(33),
      "",
      "<script>",
      "org_7f3e lapsed",
      42,
      null,
      { reason: "lapsed" },
    ];
    for (const reason of unsafe) {
      const e = {
        can: () => Promise.resolve(false),
        decide: () => Promise.resolve({ granted: false, reason }),
      } as unknown as Entitlements;
      const verdict = await checkEntitlement(e, org, "review.ask");
      expect(verdict).toMatchObject({ granted: false, reason: "denied" });
      expect(JSON.stringify(verdict)).not.toContain("7f3e");
    }
    expect(isEntitlementReason("not-in-plan")).toBe(true);
    expect(isEntitlementReason("state-unavailable")).toBe(true);
    expect(isEntitlementReason("Not-In-Plan")).toBe(false);
  });

  it("a `decide` that throws, rejects or contradicts `can` leaves the denial in place", async () => {
    const cases: Entitlements[] = [
      { can: () => Promise.resolve(false), decide: () => Promise.reject(new Error("x")) },
      {
        can: () => Promise.resolve(false),
        decide: () => {
          throw new Error("x");
        },
      },
      // `decide` says granted while `can` said no: `can` is the authority (fail closed).
      { can: () => Promise.resolve(false), decide: () => Promise.resolve({ granted: true }) },
    ];
    for (const e of cases) {
      expect(await checkEntitlement(e, org, "review.change-map")).toMatchObject({
        granted: false,
        reason: "denied",
      });
    }
  });

  it("the self-host default grants every analysis feature, so nothing changes for self-hosters", async () => {
    const e = selfHostEntitlements({ hasEnterpriseLicence: false });
    for (const feature of [...ANALYSIS_FEATURES, "review.ask", "review.memory"] as const) {
      expect(await checkEntitlement(e, org, feature)).toEqual({ granted: true });
    }
    expect(ANALYSIS_FEATURES).toEqual(["review.triage", "review.change-map"]);
  });

  it("only asks about the org it was given", async () => {
    const asked: string[] = [];
    const e: Entitlements = {
      can: (o) => {
        asked.push(o);
        return Promise.resolve(true);
      },
    };
    await checkEntitlement(e, other, "review.ask");
    expect(asked).toEqual([other]);
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
