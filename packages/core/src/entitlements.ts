import { isFeature, type Entitlements, type Feature, type OrgId } from "./ports.js";

const isEnterprise = (feature: Feature): boolean => feature.startsWith("ee:");

/**
 * Self-hosted default: every open-source feature is on; Enterprise features need a valid
 * licence. Fails closed: a string that is not a known feature is `false`. Rocky Cloud supplies
 * its own implementation backed by billing plans; both pass `entitlementsConformance` (C-8).
 */
export const selfHostEntitlements = (options: { hasEnterpriseLicence: boolean }): Entitlements => ({
  can: (_org: OrgId, feature: Feature) =>
    Promise.resolve(isFeature(feature) && (!isEnterprise(feature) || options.hasEnterpriseLicence)),
});
