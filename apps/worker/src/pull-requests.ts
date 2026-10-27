import {
  ForgeReadError,
  type Forge,
  type ForgeDiff,
  type ForgePullRequest,
  type OrgId,
  type PullRequestEvent,
  type RepositorySession,
} from "@rocky-reviews/core";
import {
  completeInTenantTx,
  enqueueHeadAnalysis,
  mirroredPullRequest,
  recordRevision,
  upsertPullRequest,
  upsertRepository,
  type Db,
  type InboxLease,
  type PullRequestWrite,
  type RevisionDiff,
  type RevisionWrite,
} from "@rocky-reviews/db";
import { CONTRADICTION_ATTEMPTS } from "./installations.js";

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
 *    pull request (P4-6, ADR 0017), and marks the inbox row processed, so a lost lease rolls
 *    everything back.
 *
 * Logs (by the inbox drain) carry ids and outcome codes; never titles, logins, diffs or tokens.
 */

/** The longest diff read per revision; longer ones are cut and flagged `max_bytes`. */
export const MIRROR_DIFF_MAX_BYTES = 1024 * 1024;

/**
 * Worst-case time for one row: the installation read, the token mint, the pull request read
 * (10 s each), the diff read (30 s), the revocation (10 s), plus slack for the database.
 */
export const PR_ROW_BUDGET_SECONDS = 10 + 10 + 10 + 30 + 10 + 10;

/** Fixed outcome codes: stored on the inbox row and logged. */
export type PullRequestOutcome =
  | "pr_mirrored"
  | "pr_unchanged"
  | "pr_stale_snapshot"
  | "installation_not_found"
  | "installation_suspended"
  | "unsupported_account_type"
  | "no_org"
  | "repository_inaccessible"
  | "pull_request_not_found";

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
}

export interface MirrorResult {
  /** `pr_mirrored`, `pr_unchanged` (nothing to write) or `pr_stale_snapshot`. */
  readonly outcome: PullRequestOutcome;
  readonly pullRequest: PullRequestWrite;
  /** `null` when the stored snapshot was newer and nothing was written. */
  readonly revision: RevisionWrite | null;
  /** Why the head revision's diff is incomplete, when it was read now and is. */
  readonly truncation: RevisionDiff["truncation"];
  /** An analysis of the head revision was queued by this write (P4-6). */
  readonly analysisQueued: boolean;
}

/** GitHub's answer disagrees with the event's head (a lagging replica, or a stale event): retry. */
export class HeadMismatchError extends Error {
  override readonly name = "HeadMismatchError";
  readonly code = "forge_head_mismatch";
  constructor() {
    super("pull request mirror: GitHub's head differs from the event's");
  }
}

/** GitHub has no diff for the head yet (a commit just pushed, a transient 404): retry. */
export class DiffNotReadyError extends Error {
  override readonly name = "DiffNotReadyError";
  readonly code = "forge_diff_unavailable";
  constructor() {
    super("pull request mirror: diff not available yet");
  }
}

/** The adapter measured and hashed the raw bytes it read; nothing is decoded here. */
const diffReading = (diff: ForgeDiff): RevisionDiff => ({
  bytes: diff.bytes.byteLength,
  sha256: diff.sha256,
  truncation: diff.truncation,
});

/**
 * Writes one pull request snapshot to the org's mirror, reading the head revision's diff first
 * when the mirror has no reading for it. With a `lease`, the inbox row is completed in the same
 * transaction (`outcome` from the write). Shared by the inbox and the rebuild command.
 */
export const mirrorPullRequest = async (
  db: Db,
  orgId: OrgId,
  session: RepositorySession,
  pr: ForgePullRequest,
  options: {
    readonly maxDiffBytes?: number;
    readonly lease?: InboxLease;
    /**
     * Throw `DiffNotReadyError` instead of recording an `unavailable` diff (the inbox, for its
     * first attempts). The rebuild records it; a later event or rebuild replaces it.
     */
    readonly retryUnavailable?: boolean;
  } = {},
): Promise<MirrorResult> => {
  const known = await db.withOrg(orgId, (tx) =>
    mirroredPullRequest(tx, session.repository.id, pr.ref.number),
  );
  // A revision's commits fix its diff: read it once per head (an `unavailable` reading does not
  // count as read, review round 1).
  const needsDiff = !(known?.headSha === pr.headSha && known.headDiffRead);
  const diff = needsDiff
    ? await session.getDiff(
        { baseSha: pr.baseSha, headSha: pr.headSha },
        { maxBytes: options.maxDiffBytes ?? MIRROR_DIFF_MAX_BYTES },
      )
    : undefined;
  if (diff?.truncation === "unavailable" && options.retryUnavailable === true) {
    throw new DiffNotReadyError();
  }
  const reading = diff === undefined ? undefined : diffReading(diff);
  return db.withOrg(orgId, async (tx) => {
    const repoId = await upsertRepository(tx, session.repository);
    const { id, write } = await upsertPullRequest(tx, repoId, pr);
    const revision =
      write === "stale" || reading === undefined ? null : await recordRevision(tx, id, pr, reading);
    // A head revision whose diff was read now, of an open pull request, is analysed (P4-6). Only
    // new readings: revisions mirrored before stay as they are until their next push, so a
    // rebuild never queues a backlog of old pull requests.
    const analysisQueued =
      pr.state === "open" &&
      (revision === "created" || revision === "completed") &&
      (await enqueueHeadAnalysis(tx, id, pr.headSha)) !== undefined;
    const outcome: PullRequestOutcome =
      write === "stale"
        ? "pr_stale_snapshot"
        : write === "unchanged" && (revision === null || revision === "unchanged")
          ? "pr_unchanged"
          : "pr_mirrored";
    if (options.lease !== undefined) await completeInTenantTx(tx, options.lease, outcome);
    return {
      outcome,
      pullRequest: write,
      revision,
      truncation: revision === null ? null : (reading?.truncation ?? null),
      analysisQueued,
    };
  });
};

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
    });
    // Recorded inside the tenant transaction together with the mirror's writes.
    return { outcome, completed: true };
  } finally {
    await session.close();
  }
};
