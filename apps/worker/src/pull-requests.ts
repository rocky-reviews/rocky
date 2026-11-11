import { ForgeReadError, type Forge, type PullRequestEvent } from "@rocky-reviews/core";
import type { Db, InboxLease } from "@rocky-reviews/db";
import { mirrorPullRequest, type PullRequestOutcome } from "@rocky-reviews/mirror";
import { CONTRADICTION_ATTEMPTS } from "./installations.js";

export {
  DiffNotReadyError,
  MIRROR_DIFF_MAX_BYTES,
  mirrorPullRequest,
  type MirrorResult,
  type PullRequestOutcome,
} from "@rocky-reviews/mirror";

/**
 * The pull request mirror (P3-4, ADR 0010). A `pull_request.*` inbox row is a hint that a pull
 * request changed; what the mirror stores is what GitHub answers now (ADR 0007 §4), so the four
 * actions (opened, synchronize, closed, reopened) are handled alike and a replayed, reordered or
 * planted row can at most cause a redundant read:
 *
 * 1. the installation must exist on GitHub (`GET /app/installations/{id}`) and not be suspended;
 *    a suspended one is not read on behalf of (GitHub refuses its tokens) and the row is finished
 *    as `installation_suspended`: the next event, or the rebuild, catches up after unsuspension;
 * 2. a live org must be bound to it; if not yet (the installation lane runs separately), the
 *    row is retried as a strike, then finished as `no_org`;
 * 3. a session on the one repository (a token scoped to it, read-only, revoked at the end);
 *    GitHub refusing it means the repository is not the installation's (`repository_inaccessible`);
 * 4. the pull request as GitHub has it now; its head revision's diff is read (up to
 *    `MIRROR_DIFF_MAX_BYTES`, truncation flagged) only when the mirror has no reading for it;
 * 5. one `withOrg` transaction writes the repository, the pull request (unless the stored
 *    snapshot is newer) and the revision, queues an analysis of a new head revision of an open
 *    pull request when automatic analysis is on (P4-6, ADR 0017; webhooks only, never the
 *    rebuild), and marks the inbox row processed, so a lost lease rolls everything back.
 *
 * The write (steps 4 and 5) is `@rocky-reviews/mirror`'s `mirrorPullRequest`, shared with the
 * rebuild and the token-mode server (P10-4). Logs (by the inbox drain) carry ids and outcome
 * codes; never titles, logins, diffs or tokens.
 */

/**
 * Worst-case time for one row: the installation read, the token mint, the pull request read
 * (10 s each), the diff read (30 s), the revocation (10 s), plus slack for the database.
 */
export const PR_ROW_BUDGET_SECONDS = 10 + 10 + 10 + 30 + 10 + 10;

/** The installation has no live org yet (its `created` row may still be in its lane): retry. */
export class OrgNotReadyError extends Error {
  override readonly name = "OrgNotReadyError";
  readonly code = "org_not_ready";
  constructor() {
    super("pull request mirror: no org for the installation yet");
  }
}

export interface PullRequestDeps {
  /** The worker login (installation lookup; tenant writes through withOrg). */
  readonly db: Db;
  readonly forge: Forge;
  readonly maxDiffBytes?: number;
  /**
   * Queue an analysis of each new head revision read here (P4-6). On only with
   * `ROCKY_ANALYSIS_AUTO=on`; off by default, so nothing spends until an operator turns it on.
   */
  readonly enqueueAnalyses?: boolean;
}

/** GitHub's answer disagrees with the event's head (a lagging replica, or a stale event): retry. */
export class HeadMismatchError extends Error {
  override readonly name = "HeadMismatchError";
  readonly code = "forge_head_mismatch";
  constructor() {
    super("pull request mirror: GitHub's head differs from the event's");
  }
}

export const reconcilePullRequest = async (
  deps: PullRequestDeps,
  lease: InboxLease & { readonly strikes: number },
  event: PullRequestEvent,
): Promise<{ readonly outcome: PullRequestOutcome; readonly completed: boolean }> => {
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

  // Also returns an org in its deletion grace period (not one being erased). Harmless: GitHub
  // just said the installation exists, so mirroring into it is what a reinstall would keep.
  const [org] = (
    await deps.db.installationOrgs(deps.forge.kind, event.installationId, null)
  ).filter((o) => o.installationId === event.installationId);
  if (org === undefined) {
    if (lease.strikes < CONTRADICTION_ATTEMPTS - 1) throw new OrgNotReadyError();
    return { outcome: "no_org", completed: false };
  }

  const session = await deps.forge.openRepository({
    installationId: event.installationId,
    repositoryId: event.repositoryId,
  });
  if (session === null) return { outcome: "repository_inaccessible", completed: false };
  try {
    const pr = await session.getPullRequest(event.number);
    if (pr === null) return { outcome: "pull_request_not_found", completed: false };
    const retry = lease.strikes < CONTRADICTION_ATTEMPTS - 1;
    // Review round 1: an opened or pushed head GitHub does not show yet is a lagging read, not
    // the truth; retried (a strike) before GitHub's answer is believed. For closed and reopened
    // the head need not have changed, so their answers are taken as they are.
    const announcesHead =
      event.type === "pull_request.opened" || event.type === "pull_request.synchronize";
    if (announcesHead && pr.headSha !== event.headSha && retry) throw new HeadMismatchError();
    const { outcome } = await mirrorPullRequest(deps.db, org.orgId, session, pr, {
      ...(deps.maxDiffBytes === undefined ? {} : { maxDiffBytes: deps.maxDiffBytes }),
      lease,
      retryUnavailable: retry,
      enqueueAnalysis: deps.enqueueAnalyses === true,
    });
    // Recorded inside the tenant transaction together with the mirror's writes.
    return { outcome, completed: true };
  } finally {
    await session.close();
  }
};
