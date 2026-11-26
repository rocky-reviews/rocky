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

/**
 * The stable code the app answers with when a feature is refused (C-8, ADR 0046): stored as
 * `analyses.error_code` and `code_index_runs.error_code`, returned as `{ error }` by the API,
 * logged as `errorCode`. The UI maps it to a pointer to the organization's billing.
 */
export const ENTITLEMENT_DENIED = "entitlement_denied";

/**
 * The features an analysis run needs before any model call (ADR 0046 §2): the per-file triage,
 * the review that writes the findings and their drafts (most of the spend), and the change map
 * drawn over them. The pipeline draws all of it into one document, so a run needs every one or
 * does not start. `review.memory` is checked separately: without it the run goes ahead without
 * project memory.
 */
export const ANALYSIS_FEATURES: readonly Feature[] = Object.freeze([
  "review.triage",
  "review.drafts",
  "review.change-map",
]);

/**
 * How long `checkEntitlement` waits for `can` or `decide` before it gives up (ADR 0046 §1): an
 * implementation that never settles must not hold a request or a worker slot. Past it, `can`
 * is `unavailable` and `decide` falls back to `denied`.
 */
export const ENTITLEMENT_DEADLINE_MS = 3_000;

/**
 * A reason an implementation may give for a denial: a short kebab-case code, nothing else.
 * Rocky Cloud's reasons (`no-plan`, `not-in-plan`, `unknown-plan`, `state-unavailable`) fit;
 * anything that could carry data (ids, text, upper case, spaces) does not and is replaced.
 */
export const isEntitlementReason = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);

/** `can` answered `false` (or something that is not `true`); `decide`, if any, gave no reason. */
export const DENIED_REASON = "denied";
/** `can` threw or rejected: the state could not be read, so nothing is granted. */
export const UNAVAILABLE_REASON = "unavailable";
/** The feature is not one Rocky knows; refused before any implementation is asked. */
export const UNKNOWN_FEATURE_REASON = "unknown-feature";

export interface EntitlementDenial {
  readonly granted: false;
  readonly code: typeof ENTITLEMENT_DENIED;
  readonly feature: Feature;
  /** A fixed code (`isEntitlementReason`): safe for the API body and the log line. */
  readonly reason: string;
}

export type EntitlementVerdict = { readonly granted: true } | EntitlementDenial;

/**
 * The check every gated path runs (C-8, ADR 0046 §3), fail closed:
 *
 * - granted only when `can` answers exactly `true`;
 * - `false`, a non-boolean, a throw or a rejection are denials (`denied`, `unavailable`), never
 *   an exception the caller could mishandle into a retry loop;
 * - an unknown feature is refused before the implementation is asked;
 * - when denied and the implementation has `decide`, its reason is passed through if it is a
 *   safe code; a `decide` that fails, or claims a grant `can` refused, changes nothing;
 * - each call gets `deadlineMs` (default `ENTITLEMENT_DEADLINE_MS`) to settle; one that does
 *   not is treated as a throw (`unavailable` for `can`, `denied` for `decide`).
 *
 * It never logs: the caller logs ids, the feature and the reason (all fixed codes).
 */
export const checkEntitlement = async (
  entitlements: Entitlements,
  org: OrgId,
  feature: Feature,
  options: { readonly deadlineMs?: number } = {},
): Promise<EntitlementVerdict> => {
  const deadlineMs = options.deadlineMs ?? ENTITLEMENT_DEADLINE_MS;
  const deny = (reason: string): EntitlementDenial => ({
    granted: false,
    code: ENTITLEMENT_DENIED,
    feature,
    reason,
  });
  if (!isFeature(feature)) return deny(UNKNOWN_FEATURE_REASON);
  let answer: unknown;
  try {
    answer = await withinDeadline(() => entitlements.can(org, feature), deadlineMs);
  } catch {
    return deny(UNAVAILABLE_REASON);
  }
  if (answer === true) return { granted: true };
  const { decide } = entitlements;
  if (typeof decide !== "function") return deny(DENIED_REASON);
  try {
    const decision: unknown = await withinDeadline(
      () => decide.call(entitlements, org, feature),
      deadlineMs,
    );
    const reason = (decision as { reason?: unknown } | null | undefined)?.reason;
    return deny(isEntitlementReason(reason) ? reason : DENIED_REASON);
  } catch {
    return deny(DENIED_REASON);
  }
};

/**
 * `call()`'s settled value, or a rejection once `deadlineMs` has passed. A synchronous throw
 * inside `call` rejects too. The timer never keeps the process alive (`unref`, where it exists).
 */
const withinDeadline = <T>(call: () => Promise<T>, deadlineMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("entitlements: deadline")), deadlineMs);
    (timer as { unref?: () => void }).unref?.();
    Promise.resolve()
      .then(call)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("entitlements: failed"));
        },
      );
  });
