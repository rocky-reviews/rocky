import type { OrgId } from "./ports.js";

/**
 * Org erasure beyond Postgres (P3-3, ADR 0009). Deleting the `orgs` row cascades through every
 * tenant table; data a tenant has in other stores must be erased by that store's adapter. Each
 * store is a named slot here, so adding a store without an eraser is a type error and the
 * deletion sweep cannot forget it:
 *
 * - `object_storage`: R2 objects under the org's prefix (renders, exports). Plugs in with P5.
 * - `embeddings`: vectors or caches kept outside the `embeddings` table. Plugs in with P8.
 *
 * Until those land, the slots hold `nothingStoredYet`, which erases nothing because nothing is
 * stored; the worker wiring and its test name each slot (docs/progress.md follow-up).
 */
export const EXTERNAL_TENANT_STORES = ["object_storage", "embeddings"] as const;
export type ExternalTenantStore = (typeof EXTERNAL_TENANT_STORES)[number];

export interface OrgDataEraser<S extends ExternalTenantStore = ExternalTenantStore> {
  readonly store: S;
  /**
   * Removes everything the store holds for `orgId`. Runs before the org row is deleted, and
   * again after a failure or a crash, so it must be idempotent and succeed when nothing is left.
   */
  eraseOrg(orgId: OrgId): Promise<void>;
  /** True while the store holds nothing for any org (the placeholder); adapters omit it. */
  readonly placeholder?: true;
}

/** One eraser per external store. */
export type OrgErasers = { readonly [S in ExternalTenantStore]: OrgDataEraser<S> };

/** The slot filler for a store that does not exist yet. Erases nothing; marked as a placeholder. */
export const nothingStoredYet = <S extends ExternalTenantStore>(store: S): OrgDataEraser<S> => ({
  store,
  placeholder: true,
  eraseOrg: () => Promise.resolve(),
});
