import type { ForgeDiff, ForgePullRequest, OrgId, RepositorySession } from "@rocky-reviews/core";
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

/**
 * The pull request mirror's one write path (P3-4, ADR 0010; moved here from the worker for
 * P10-4, ADR 0045, so the token-mode server syncs through exactly the same code): what the mirror
 * stores is what the forge answers now, in one `withOrg` transaction, as idempotent upserts. The
 * worker's webhook lane, its rebuild and the server's token sync all call `mirrorPullRequest`.
 *
 * Logs are the callers'; nothing here logs. Titles, logins and diffs never leave the session
 * except into the mirror's columns (diff text is not stored: size, digest and truncation are).
 */

/** The longest diff read per revision; longer ones are cut and flagged `max_bytes`. */
export const MIRROR_DIFF_MAX_BYTES = 1024 * 1024;

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
 * transaction (`outcome` from the write). Shared by the inbox, the rebuild and the token sync.
 */
export const mirrorPullRequest = async (
  db: Pick<Db, "withOrg">,
  orgId: OrgId,
  session: RepositorySession,
  pr: ForgePullRequest,
  options: {
    readonly maxDiffBytes?: number;
    readonly lease?: InboxLease;
    /**
     * Throw `DiffNotReadyError` instead of recording an `unavailable` diff (the inbox, for its
     * first attempts). The rebuild and the sync record it; a later read replaces it.
     */
    readonly retryUnavailable?: boolean;
    /**
     * Queue an analysis of a new head revision of an open pull request (P4-6). Webhook-driven
     * reads and the token sync with `ROCKY_ANALYSIS_AUTO=on`; the rebuild leaves it off, so
     * restoring or first mirroring a repository never queues every open pull request (review
     * round 1, SF4).
     */
    readonly enqueueAnalysis?: boolean;
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
    // new readings, and only when the caller asks (webhooks with automatic analysis on).
    const analysisQueued =
      options.enqueueAnalysis === true &&
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
