import { describe, expect, it } from "vitest";
import {
  entitlementsConformance,
  EntitlementsConformanceError,
  NOT_FEATURES,
  type EntitlementsHarness,
} from "./entitlements-conformance.js";
import { FEATURES, isFeature, type Entitlements, type Feature, type OrgId } from "./ports.js";

const orgA = "org_a" as OrgId;
const orgB = "org_b" as OrgId;
const OSS = FEATURES.filter((f) => !f.startsWith("ee:"));

/** A correct reference: org A has the open-source features, org B everything. */
const reference = (): Entitlements => ({
  can: (org, feature) =>
    Promise.resolve(isFeature(feature) && (org === orgB || !feature.startsWith("ee:"))),
});

const harnessFor = (
  entitlements: Entitlements,
  unavailable?: Entitlements,
): EntitlementsHarness => ({
  entitlements,
  orgs: [
    { label: "basic", org: orgA, features: OSS },
    { label: "full", org: orgB, features: FEATURES },
  ],
  ...(unavailable === undefined ? {} : { unavailable }),
});

const byName = (name: string) => {
  const found = entitlementsConformance.find((c) => c.name.startsWith(name));
  if (found === undefined) throw new Error(`no case ${name}`);
  return found;
};

describe("entitlements conformance suite", () => {
  it("passes a correct implementation, with and without an unavailable variant", async () => {
    const failing: Entitlements = { can: () => Promise.reject(new Error("db down")) };
    const denying: Entitlements = { can: () => Promise.resolve(false) };
    for (const harness of [
      harnessFor(reference()),
      harnessFor(reference(), failing),
      harnessFor(reference(), denying),
    ]) {
      for (const c of entitlementsConformance)
        await expect(c.run(harness)).resolves.toBeUndefined();
    }
  });

  it("rejects a malformed harness", async () => {
    const run = byName("answers every known feature").run;
    const bad: EntitlementsHarness[] = [
      { entitlements: reference(), orgs: [] },
      {
        entitlements: reference(),
        orgs: [
          { label: "x", org: orgA, features: [] },
          { label: "x", org: orgB, features: [] },
        ],
      },
      {
        entitlements: reference(),
        orgs: [{ label: "x", org: orgA, features: ["review.nope" as Feature] }],
      },
    ];
    for (const harness of bad) {
      await expect(run(harness)).rejects.toBeInstanceOf(EntitlementsConformanceError);
    }
  });

  it("catches an implementation that answers with a non-boolean or throws", async () => {
    const truthy = { can: () => Promise.resolve(1) } as unknown as Entitlements;
    const throwing: Entitlements = { can: () => Promise.reject(new Error("boom")) };
    const run = byName("answers every known feature").run;
    await expect(run(harnessFor(truthy))).rejects.toThrow(/not a boolean/);
    await expect(run(harnessFor(throwing))).rejects.toThrow(/rejected/);
  });

  it("catches a missing or an extra feature", async () => {
    const run = byName("grants each org exactly").run;
    const noAsk: Entitlements = {
      can: async (org, feature) =>
        feature !== "review.ask" && (await reference().can(org, feature)),
    };
    const leaksSso: Entitlements = {
      can: async (org, feature) => feature === "ee:sso" || (await reference().can(org, feature)),
    };
    await expect(run(harnessFor(noAsk))).rejects.toThrow(/review\.ask is false/);
    await expect(run(harnessFor(leaksSso))).rejects.toThrow(/basic: ee:sso is true/);
  });

  it("catches an implementation that grants unknown features", async () => {
    const run = byName("refuses unknown features").run;
    // The classic mistake: a plain-object lookup that finds `constructor` on the prototype.
    const table: Record<string, boolean> = Object.fromEntries(OSS.map((f) => [f, true]));
    const lookup: Entitlements = {
      can: (_org, feature) => Promise.resolve(Boolean(table[feature])),
    };
    const prefix: Entitlements = {
      can: (_org, feature) => Promise.resolve(!feature.startsWith("ee:")),
    };
    await expect(run(harnessFor(lookup))).rejects.toThrow(/"__proto__" was granted/);
    await expect(run(harnessFor(prefix))).rejects.toThrow(/unknown feature ""/);
    expect(NOT_FEATURES.some(isFeature)).toBe(false);
  });

  it("catches answers that change with order or concurrency", async () => {
    const run = byName("answers do not depend").run;
    let inFlight = 0;
    const racy: Entitlements = {
      can: async (org, feature) => {
        inFlight++;
        await Promise.resolve();
        const busy = inFlight > 1;
        inFlight--;
        return !busy && (await reference().can(org, feature));
      },
    };
    let lastOrg: OrgId | undefined;
    const sticky: Entitlements = {
      can: async (org, feature) => {
        const previous = lastOrg;
        lastOrg = org;
        await Promise.resolve();
        return reference().can(previous ?? org, feature);
      },
    };
    await expect(run(harnessFor(racy))).rejects.toThrow(/changed when asked concurrently/);
    await expect(run(harnessFor(sticky))).rejects.toThrow(EntitlementsConformanceError);
  });

  it("catches an implementation that grants when its state is unavailable", async () => {
    const run = byName("grants nothing when").run;
    const failOpen: Entitlements = { can: () => Promise.resolve(true) };
    await expect(run(harnessFor(reference(), failOpen))).rejects.toThrow(/granted while state/);
  });
});
