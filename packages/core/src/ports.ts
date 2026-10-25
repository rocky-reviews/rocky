/**
 * Ports: the interfaces the domain depends on. Adapters (GitHub, Postgres, LLM providers,
 * Paddle, R2) implement them outside this package. Each port grows in the phase that needs it;
 * only the ones the scaffold already uses are defined here.
 */

export type OrgId = string & { readonly __brand: "OrgId" };

export interface Clock {
  now(): Date;
}

/** Features that can be switched per plan. `ee:*` features need an Enterprise licence. */
export type Feature =
  | "review.triage"
  | "review.drafts"
  | "review.change-map"
  | "review.ask"
  | "review.memory"
  | "ee:sso"
  | "ee:audit-log-ui"
  | "ee:org-policies"
  | "ee:insights";

export interface Entitlements {
  can(org: OrgId, feature: Feature): Promise<boolean>;
}
