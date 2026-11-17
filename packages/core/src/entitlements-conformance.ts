/**
 * The conformance suite every `Entitlements` implementation must pass (C-8): the self-host one in
 * this package and any other (Rocky Cloud's plan-backed one lives in its own repository and runs
 * the same cases). Framework-free so core stays free of test dependencies: each case is an async
 * function that throws `EntitlementsConformanceError` on failure; a test file wraps each one in its
 * runner's `it`.
 *
 * What the suite holds every implementation to, whatever its plans:
 * - every known feature gets a boolean answer for every org (never a truthy value, never a throw);
 * - each org gets exactly the features the harness says it has, and nothing else;
 * - unknown features (typos, prototype keys, case or whitespace variants) are `false`;
 * - answers do not depend on call order, concurrency or other orgs' queries;
 * - when the backing state cannot be read, nothing is granted (reject or `false`).
 */
import { FEATURES, isFeature, type Entitlements, type Feature, type OrgId } from "./ports.js";

export interface EntitlementsHarnessOrg {
  /** Shown in failure messages; unique within the harness. */
  readonly label: string;
  readonly org: OrgId;
  /** Exactly the features this org has; every other feature must be `false`. */
  readonly features: readonly Feature[];
}

export interface EntitlementsHarness {
  readonly entitlements: Entitlements;
  /** At least one org; cover every distinct answer set the implementation can give. */
  readonly orgs: readonly EntitlementsHarnessOrg[];
  /**
   * The same implementation with its backing state unreadable, when its answers depend on that
   * state. Omit it for a configuration whose answers never read state (self-host, or one that
   * only observes state without enforcing it).
   */
  readonly unavailable?: Entitlements;
}

export interface EntitlementsConformanceCase {
  readonly name: string;
  run(harness: EntitlementsHarness): Promise<void>;
}

export class EntitlementsConformanceError extends Error {
  override readonly name = "EntitlementsConformanceError";
}

const fail = (message: string): never => {
  throw new EntitlementsConformanceError(message);
};

/** Strings that are not features but look like one, or would hit a plain-object lookup. */
export const NOT_FEATURES: readonly string[] = Object.freeze([
  "",
  "ee:",
  "review.",
  "review.unknown",
  "ee:unknown",
  " review.triage",
  "review.triage ",
  "REVIEW.TRIAGE",
  "EE:SSO",
  "review.triage\u0000",
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
]);

const checkHarness = (harness: EntitlementsHarness): void => {
  if (harness.orgs.length === 0) fail("harness: no orgs");
  const labels = new Set(harness.orgs.map((o) => o.label));
  if (labels.size !== harness.orgs.length) fail("harness: org labels must be unique");
  for (const { label, features } of harness.orgs) {
    for (const feature of features) {
      if (!isFeature(feature)) fail(`harness: ${label} lists an unknown feature`);
    }
  }
};

const ask = async (
  entitlements: Entitlements,
  { label, org }: EntitlementsHarnessOrg,
  feature: string,
): Promise<boolean> => {
  let answer: unknown;
  try {
    answer = await entitlements.can(org, feature as Feature);
  } catch {
    return fail(`${label}: can(${JSON.stringify(feature)}) rejected`);
  }
  if (typeof answer !== "boolean") {
    fail(`${label}: can(${JSON.stringify(feature)}) returned a ${typeof answer}, not a boolean`);
  }
  return answer as boolean;
};

type Query = { readonly org: EntitlementsHarnessOrg; readonly feature: Feature };

const queries = (harness: EntitlementsHarness): Query[] =>
  harness.orgs.flatMap((org) => FEATURES.map((feature) => ({ org, feature })));

const key = ({ org, feature }: Query): string => `${org.label}\u0000${feature}`;

export const entitlementsConformance: readonly EntitlementsConformanceCase[] = Object.freeze([
  {
    name: "answers every known feature with a boolean, for every org",
    async run(harness) {
      checkHarness(harness);
      for (const { org, feature } of queries(harness))
        await ask(harness.entitlements, org, feature);
    },
  },
  {
    name: "grants each org exactly its features",
    async run(harness) {
      checkHarness(harness);
      for (const org of harness.orgs) {
        const expected = new Set<Feature>(org.features);
        for (const feature of FEATURES) {
          const answer = await ask(harness.entitlements, org, feature);
          if (answer !== expected.has(feature)) {
            fail(`${org.label}: ${feature} is ${String(answer)}, expected ${String(!answer)}`);
          }
        }
      }
    },
  },
  {
    name: "refuses unknown features (fails closed)",
    async run(harness) {
      checkHarness(harness);
      for (const org of harness.orgs) {
        for (const feature of NOT_FEATURES) {
          if (await ask(harness.entitlements, org, feature)) {
            fail(`${org.label}: unknown feature ${JSON.stringify(feature)} was granted`);
          }
        }
      }
    },
  },
  {
    name: "answers do not depend on order, concurrency or other orgs",
    async run(harness) {
      checkHarness(harness);
      const all = queries(harness);
      const sequential = new Map<string, boolean>();
      for (const q of all)
        sequential.set(key(q), await ask(harness.entitlements, q.org, q.feature));
      // Reversed and interleaved across orgs, all at once, twice.
      const shuffled = [...all].reverse();
      for (let round = 0; round < 2; round++) {
        const answers = await Promise.all(
          shuffled.map((q) => ask(harness.entitlements, q.org, q.feature)),
        );
        shuffled.forEach((q, i) => {
          if (answers[i] !== sequential.get(key(q))) {
            fail(`${q.org.label}: ${q.feature} changed when asked concurrently`);
          }
        });
      }
    },
  },
  {
    name: "grants nothing when its state cannot be read",
    async run(harness) {
      checkHarness(harness);
      const { unavailable } = harness;
      if (unavailable === undefined) return;
      for (const { org, feature } of queries(harness)) {
        // Rejecting is failing closed too.
        const answer: unknown = await unavailable.can(org.org, feature).catch(() => false);
        if (answer !== false) fail(`${org.label}: ${feature} granted while state is unavailable`);
      }
    },
  },
]);
