import {
  ForgeReadError,
  type CodeReader,
  type Forge,
  type RepositoryPushEvent,
} from "@rocky-reviews/core";
import {
  completeInTenantTx,
  enqueueCodeIndex,
  upsertRepository,
  type Db,
  type InboxLease,
} from "@rocky-reviews/db";
import { CONTRADICTION_ATTEMPTS } from "./installations.js";
import { OrgNotReadyError } from "./pull-requests.js";

/**
 * Push events (P9-1, ADR 0040): commits reached a repository's default branch, so its index is
 * queued to catch up. Like the mirror (ADR 0010), the row is a hint: the installation is
 * re-checked with GitHub, the repository is read on a token scoped to it, and the run reads the
 * branch head again before it fetches anything, so a replayed or planted push costs at most a
 * run that finds nothing changed. With indexing off the row is finished without a GitHub read.
 */

/**
 * Worst-case time for one row: the installation read, the token mint, the revocation (10 s
 * each), plus slack for the database.
 */
export const PUSH_ROW_BUDGET_SECONDS = 10 + 10 + 10 + 10;

export type PushOutcome =
  | "index_queued"
  | "indexing_off"
  | "installation_not_found"
  | "installation_suspended"
  | "unsupported_account_type"
  | "no_org"
  | "repository_inaccessible";

export interface PushDeps {
  readonly db: Db;
  readonly forge: Forge & CodeReader;
  /** `ROCKY_INDEX_AUTO=on`: pushes queue index runs. */
  readonly indexing: boolean;
}

export const reconcilePush = async (
  deps: PushDeps,
  lease: InboxLease & { readonly strikes: number },
  event: RepositoryPushEvent,
): Promise<{ readonly outcome: PushOutcome; readonly completed: boolean }> => {
  if (!deps.indexing) return { outcome: "indexing_off", completed: false };
  let installation;
  try {
    installation = await deps.forge.getInstallation(event.installationId);
  } catch (error) {
    if (error instanceof ForgeReadError && error.reason === "unsupported_account_type") {
      return { outcome: "unsupported_account_type", completed: false };
    }
    throw error;
  }
  if (installation === null) return { outcome: "installation_not_found", completed: false };
  if (installation.suspended) return { outcome: "installation_suspended", completed: false };

  const [org] = (
    await deps.db.installationOrgs(deps.forge.kind, event.installationId, null)
  ).filter((o) => o.installationId === event.installationId);
  if (org === undefined) {
    if (lease.strikes < CONTRADICTION_ATTEMPTS - 1) throw new OrgNotReadyError();
    return { outcome: "no_org", completed: false };
  }

  // Only the repository's description is read here; the run opens its own session.
  const session = await deps.forge.openCode({
    installationId: event.installationId,
    repositoryId: event.repositoryId,
  });
  if (session === null) return { outcome: "repository_inaccessible", completed: false };
  try {
    const repository = session.repository;
    await deps.db.withOrg(org.orgId, async (tx) => {
      const repoId = await upsertRepository(tx, repository);
      await enqueueCodeIndex(tx, repoId, event.headSha);
      await completeInTenantTx(tx, lease, "index_queued");
    });
    return { outcome: "index_queued", completed: true };
  } finally {
    await session.close();
  }
};
