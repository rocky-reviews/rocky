import type { EntitlementDenial } from "@rocky-reviews/core";

/**
 * The one answer every plan-gated route gives when a feature is refused (C-8, ADR 0046 §4):
 * 403 with the stable code, the feature and a fixed reason code. Nothing from the request, the
 * org's billing state or an error message is in it; the web app maps it to a pointer to the
 * organization's billing.
 */
export const ENTITLEMENT_DENIED_STATUS = 403;

export const entitlementDeniedBody = (denial: EntitlementDenial) => ({
  error: denial.code,
  feature: denial.feature,
  reason: denial.reason,
});

/** The fields a route logs about a denial: fixed codes, next to the route's ids. */
export const entitlementDeniedFields = (denial: EntitlementDenial) => ({
  feature: denial.feature,
  reason: denial.reason,
});
