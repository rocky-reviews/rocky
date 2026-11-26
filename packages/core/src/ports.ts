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
export const FEATURES = Object.freeze([
  "review.triage",
  "review.drafts",
  "review.change-map",
  "review.ask",
  "review.memory",
  "ee:sso",
  "ee:audit-log-ui",
  "ee:org-policies",
  "ee:insights",
] as const);

export type Feature = (typeof FEATURES)[number];

const FEATURE_SET: ReadonlySet<string> = new Set(FEATURES);

/** Whether `value` is a known feature; a typo or a value read from elsewhere is not. */
export const isFeature = (value: unknown): value is Feature =>
  typeof value === "string" && FEATURE_SET.has(value);

/**
 * Which features an org may use. Implementations (self-host below, Rocky Cloud's plans) must
 * pass the shared conformance suite (`@rocky-reviews/core/entitlements-conformance`, C-8):
 * answers are booleans, unknown features are `false`, answers for one org never depend on
 * another, and state that cannot be read never grants.
 */
export interface Entitlements {
  can(org: OrgId, feature: Feature): Promise<boolean>;
  /**
   * Optional: the same answer with a fixed reason code (Rocky Cloud's `decide`: `no-plan`,
   * `not-in-plan`, `state-unavailable`, …). The app reads it only after `can` denied, to tell
   * the person why; the reason must be a short kebab-case code (`isEntitlementReason`), or it
   * is replaced by `denied`. `can` stays the authority: `decide` can never grant.
   */
  decide?(org: OrgId, feature: Feature): Promise<EntitlementDecision>;
}

export interface EntitlementDecision {
  readonly granted: boolean;
  readonly reason?: string;
}
