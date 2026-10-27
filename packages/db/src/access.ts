import { and, eq } from "drizzle-orm";
import type { TenantTx } from "./client.js";
import { members, repos } from "./schema.js";
import { loadForgeToken, loadOrgDataKey, SecretStoreError, type StoredSecret } from "./secrets.js";

/**
 * What the repository access check (P3-6, ADR 0011) needs from the tenant's data, read in one
 * `withOrg` transaction: whether the member exists in this org, the repository's current name,
 * and the ciphertexts needed to decrypt the member's forge token (never a plaintext: decryption
 * happens in the caller, outside the transaction). RLS makes another org's member or repository
 * look absent.
 */
export interface RepositoryAccessContext {
  readonly member: boolean;
  /** `owner/name` of the org's repository with this forge id, or `null`. */
  readonly repositoryFullName: string | null;
  /** The member's encrypted forge token (`rk1:…`), or `null` when none is stored. */
  readonly token: StoredSecret | null;
  /** The org's wrapped data key (`rkw1:…`), or `null` when none is provisioned. */
  readonly dataKey: StoredSecret | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const loadRepositoryAccessContext = async (
  tx: TenantTx,
  request: { readonly memberId: string; readonly forgeRepoId: number },
): Promise<RepositoryAccessContext> => {
  const { memberId, forgeRepoId } = request;
  if (typeof memberId !== "string" || !UUID.test(memberId)) {
    throw new SecretStoreError("access: member id must be a uuid");
  }
  if (!Number.isSafeInteger(forgeRepoId) || forgeRepoId < 1) {
    throw new SecretStoreError("access: repository id must be a positive integer");
  }
  try {
    const [member] = await tx.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.orgId, tx.orgId), eq(members.id, memberId)));
    const [repo] = await tx.db
      .select({ fullName: repos.fullName })
      .from(repos)
      .where(and(eq(repos.orgId, tx.orgId), eq(repos.forgeRepoId, forgeRepoId)));
    const exists = member !== undefined;
    return {
      member: exists,
      repositoryFullName: repo?.fullName ?? null,
      token: exists ? await loadForgeToken(tx, memberId) : null,
      dataKey: exists ? await loadOrgDataKey(tx) : null,
    };
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    // Driver errors carry statement parameters; keep none of them.
    throw new SecretStoreError("access: database error");
  }
};
