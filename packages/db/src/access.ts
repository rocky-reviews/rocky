import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "./client.js";
import { members, orgs, repos } from "./schema.js";
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
  /**
   * The member's forge user id (`members.forge_user_id`), or `null` when there is no such
   * member. The reader checks that the token belongs to this user.
   */
  readonly forgeUserId: number | null;
  /**
   * The org's forge installation (`orgs.installation_id`), on whose behalf membership is checked
   * for repositories that are not private; `null` when the org row is not visible.
   */
  readonly installationId: number | null;
  /** `owner/name` of the org's repository with this forge id, or `null`. */
  readonly repositoryFullName: string | null;
  /** The member's encrypted forge token (`rk1:…`), or `null` when none is stored. */
  readonly token: StoredSecret | null;
  /** The org's wrapped data key (`rkw1:…`), or `null` when none is provisioned. */
  readonly dataKey: StoredSecret | null;
}

/**
 * A caller passed input that names nothing valid (a bug in the caller, not a database or secret
 * failure). Fixed message; carries no values.
 */
export class AccessInputError extends Error {
  override readonly name = "AccessInputError";
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
      .select({ id: members.id, forgeUserId: members.forgeUserId })
      .from(members)
      // A member removed in Rocky is not a member (P7-1 review round 1).
      .where(and(eq(members.orgId, tx.orgId), eq(members.id, memberId), isNull(members.removedAt)));
    const [repo] = await tx.db
      .select({ fullName: repos.fullName })
      .from(repos)
      .where(and(eq(repos.orgId, tx.orgId), eq(repos.forgeRepoId, forgeRepoId)));
    const [org] = await tx.db
      .select({ installationId: orgs.installationId })
      .from(orgs)
      .where(eq(orgs.id, tx.orgId));
    const exists = member !== undefined;
    return {
      member: exists,
      forgeUserId: member?.forgeUserId ?? null,
      installationId: org?.installationId ?? null,
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

/** What a route names: one of its own repositories, or a pull request of one. */
export type RepositoryAccessTarget =
  | { readonly repoId: string; readonly pullRequestId?: never }
  | { readonly pullRequestId: string; readonly repoId?: never };

/**
 * The first query of a repository-scoped route (ADR 0011 §6): resolves only the forge repository
 * id of what the route names, so the route can call the access check **before** it loads any of
 * the repository's data. `null` when the org has no such repository or pull request (RLS hides
 * other orgs' rows); answer it like a deny. Exactly one of `repoId`/`pullRequestId` (uuids).
 */
export const resolveRepositoryForAccess = async (
  tx: TenantTx,
  target: RepositoryAccessTarget,
): Promise<{ readonly forgeRepoId: number } | null> => {
  const { repoId, pullRequestId } = (target ?? {}) as Record<string, unknown>;
  const byRepo = repoId !== undefined;
  const id = byRepo ? repoId : pullRequestId;
  if ((byRepo && pullRequestId !== undefined) || typeof id !== "string" || !UUID.test(id)) {
    throw new AccessInputError("access: name exactly one repository or pull request by uuid");
  }
  let rows: { forge_repo_id: string | number }[];
  try {
    const result = byRepo
      ? await tx.query<{ forge_repo_id: string | number }>(
          "select forge_repo_id from repos where org_id = $1 and id = $2",
          [tx.orgId, id],
        )
      : await tx.query<{ forge_repo_id: string | number }>(
          `select r.forge_repo_id from pull_requests p
             join repos r on r.org_id = p.org_id and r.id = p.repo_id
            where p.org_id = $1 and p.id = $2`,
          [tx.orgId, id],
        );
    rows = result.rows;
  } catch {
    throw new SecretStoreError("access: database error");
  }
  const forgeRepoId = Number(rows[0]?.forge_repo_id);
  return rows.length === 1 && Number.isSafeInteger(forgeRepoId) && forgeRepoId > 0
    ? { forgeRepoId }
    : null;
};
