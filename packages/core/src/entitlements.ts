import type { Entitlements, Feature, OrgId } from "./ports.js";

const isEnterprise = (feature: Feature): boolean => feature.startsWith("ee:");

/**
 * Self-hosted default: every open-source feature is on; Enterprise features need a valid
 * licence. Rocky Cloud supplies its own implementation backed by billing plans.
 */
export const selfHostEntitlements = (options: { hasEnterpriseLicence: boolean }): Entitlements => ({
  can: (_org: OrgId, feature: Feature) =>
    Promise.resolve(!isEnterprise(feature) || options.hasEnterpriseLicence),
});
