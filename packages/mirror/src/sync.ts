import type { OrgId, RepositorySession } from "@rocky-reviews/core";
import {
  closeVanishedPullRequest,
  mirroredPullRequests,
  upsertRepository,
  type Db,
} from "@rocky-reviews/db";
import { MIRROR_DIFF_MAX_BYTES, mirrorPullRequest } from "./mirror.js";

/**
 * Brings one repository's mirror up to date with the forge's listing (P3-4's rebuild, ADR 0010
 * §4; the token sync of P10-4, ADR 0045): every pull request the session lists (any state,
 * newest first, up to `limit`) is read again and written through `mirrorPullRequest`, unless its
 * stored snapshot already matches the listing (same head, same `updated_at`, head diff read),
 * which costs no read. Rows the forge did not list are counted and kept: they may hold a
 * reviewer's work, and deleting tenant data is not a sync's call. Nothing is deleted; every write
 * is an idempotent upsert, safe to run while the worker runs.
 */

export const SYNC_DEFAULT_LIMIT = 1000;
/** A listing is capped at 100 pages of 100 (`MAX_LIST_PAGES`). */
export const SYNC_MAX_LIMIT = 10_000;

export interface SyncReport {
  /** Pull requests the forge listed (deduplicated), up to the limit. */
  readonly listed: number;
  /** Created or refreshed from the forge's answer. */
  readonly mirrored: number;
  /** Already current: not read again. */
  readonly unchanged: number;
  /** Listed, but the forge answered 404 when read (deleted meanwhile). */
  readonly missing: number;
  /** A newer snapshot was already stored (a webhook got there first). */
  readonly stale: number;
  /** Head revisions recorded or completed with a diff reading. */
  readonly revisionsRecorded: number;
  /** Of those, the ones whose diff is incomplete (`max_bytes`, `forge_limit`, `unavailable`). */
  readonly truncatedDiffs: number;
  /** Analyses queued (with `enqueueAnalysis`). */
  readonly analysesQueued: number;
  /** Mirrored pull requests the forge did not list; `null` when the limit cut the listing short. */
  readonly notListed: number | null;
  readonly limitReached: boolean;
}

export interface SyncOptions {
  readonly limit?: number;
  readonly maxDiffBytes?: number;
  /** Queue an analysis of each new open head read (token mode with `ROCKY_ANALYSIS_AUTO=on`). */
  readonly enqueueAnalysis?: boolean;
}

export const syncRepositoryMirror = async (
  db: Pick<Db, "withOrg">,
  orgId: OrgId,
  session: RepositorySession,
  options: SyncOptions = {},
): Promise<SyncReport> => {
  const limit = options.limit ?? SYNC_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SYNC_MAX_LIMIT) {
    throw new Error(`sync: limit must be 1..${SYNC_MAX_LIMIT}`);
  }
  const counts = {
    listed: 0,
    mirrored: 0,
    unchanged: 0,
    missing: 0,
    stale: 0,
    revisionsRecorded: 0,
    truncatedDiffs: 0,
    analysesQueued: 0,
  };
  let limitReached = false;
  const seen = new Set<number>();
  const existing = new Map(
    (
      await db.withOrg(orgId, async (tx) => {
        await upsertRepository(tx, session.repository);
        return mirroredPullRequests(tx, session.repository.id);
      })
    ).map((p) => [p.number, p]),
  );
  for await (const summary of session.listPullRequests()) {
    if (seen.has(summary.number)) continue;
    if (seen.size >= limit) {
      limitReached = true;
      break;
    }
    seen.add(summary.number);
    counts.listed++;
    const known = existing.get(summary.number);
    if (
      known !== undefined &&
      known.headSha === summary.headSha &&
      known.headDiffRead &&
      known.forgeUpdatedAt?.getTime() === summary.updatedAt.getTime()
    ) {
      counts.unchanged++;
      continue;
    }
    const pr = await session.getPullRequest(summary.number);
    if (pr === null) {
      counts.missing++;
      continue;
    }
    const result = await mirrorPullRequest(db, orgId, session, pr, {
      maxDiffBytes: options.maxDiffBytes ?? MIRROR_DIFF_MAX_BYTES,
      ...(options.enqueueAnalysis === undefined
        ? {}
        : { enqueueAnalysis: options.enqueueAnalysis }),
    });
    if (result.outcome === "pr_stale_snapshot") counts.stale++;
    else if (result.outcome === "pr_unchanged") counts.unchanged++;
    else counts.mirrored++;
    if (result.revision === "created" || result.revision === "completed") {
      counts.revisionsRecorded++;
      if (result.truncation !== null) counts.truncatedDiffs++;
    }
    if (result.analysisQueued) counts.analysesQueued++;
  }
  return {
    ...counts,
    notListed: limitReached ? null : [...existing.keys()].filter((n) => !seen.has(n)).length,
    limitReached,
  };
};

export interface OpenSyncReport {
  /** Open pull requests the forge listed (deduplicated), up to the limit. */
  readonly listed: number;
  /** Created or refreshed from the forge's answer (open ones, and ones that closed). */
  readonly mirrored: number;
  /** Already current: not read again. */
  readonly unchanged: number;
  /** Open in the mirror, not listed, and gone when read (404): left as they are. */
  readonly missing: number;
  /** Open in the mirror but no longer open on the forge: read again and written as closed. */
  readonly closed: number;
  readonly analysesQueued: number;
  readonly limitReached: boolean;
}

/**
 * The token sync (P10-4, ADR 0045 §5): what the inbox needs, at the least cost to the token's
 * rate limit. The open pull requests are listed (`state=open`, newest first, up to `limit`) and
 * each new or changed one is read and written through `mirrorPullRequest`; then every pull
 * request the mirror still has as open but the forge did not list is read once, so a merge or a
 * close shows (skipped when the limit cut the listing short: it may simply not have been
 * reached). Closed pull requests are never listed, so an old repository costs one listing page.
 * As with the rebuild, nothing is deleted and every write is an idempotent upsert.
 */
export const syncOpenPullRequests = async (
  db: Pick<Db, "withOrg">,
  orgId: OrgId,
  session: RepositorySession,
  options: SyncOptions = {},
): Promise<OpenSyncReport> => {
  const limit = options.limit ?? SYNC_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SYNC_MAX_LIMIT) {
    throw new Error(`sync: limit must be 1..${SYNC_MAX_LIMIT}`);
  }
  const write = {
    maxDiffBytes: options.maxDiffBytes ?? MIRROR_DIFF_MAX_BYTES,
    ...(options.enqueueAnalysis === undefined ? {} : { enqueueAnalysis: options.enqueueAnalysis }),
  };
  const counts = { listed: 0, mirrored: 0, unchanged: 0, missing: 0, closed: 0, analysesQueued: 0 };
  let limitReached = false;
  const seen = new Set<number>();
  const existing = new Map(
    (
      await db.withOrg(orgId, async (tx) => {
        await upsertRepository(tx, session.repository);
        return mirroredPullRequests(tx, session.repository.id);
      })
    ).map((p) => [p.number, p]),
  );
  const read = async (number: number): Promise<"written" | "unchanged" | "missing"> => {
    const pr = await session.getPullRequest(number);
    if (pr === null) return "missing";
    const result = await mirrorPullRequest(db, orgId, session, pr, write);
    if (result.analysisQueued) counts.analysesQueued++;
    return result.outcome === "pr_mirrored" ? "written" : "unchanged";
  };
  for await (const summary of session.listPullRequests({ state: "open" })) {
    if (seen.has(summary.number)) continue;
    if (seen.size >= limit) {
      limitReached = true;
      break;
    }
    seen.add(summary.number);
    counts.listed++;
    const known = existing.get(summary.number);
    if (
      known !== undefined &&
      known.open &&
      known.headSha === summary.headSha &&
      known.headDiffRead &&
      known.forgeUpdatedAt?.getTime() === summary.updatedAt.getTime()
    ) {
      counts.unchanged++;
      continue;
    }
    const outcome = await read(summary.number);
    if (outcome === "written") counts.mirrored++;
    else if (outcome === "unchanged") counts.unchanged++;
    else counts.missing++;
  }
  if (!limitReached) {
    for (const known of existing.values()) {
      if (!known.open || seen.has(known.number)) continue;
      const outcome = await read(known.number);
      if (outcome === "missing") {
        // Gone from GitHub: closed in the mirror, so the next sync does not read it again.
        counts.missing++;
        await db.withOrg(orgId, (tx) =>
          closeVanishedPullRequest(tx, session.repository.id, known.number, new Date()),
        );
      } else {
        counts.closed++;
        if (outcome === "written") counts.mirrored++;
      }
    }
  }
  return { ...counts, limitReached };
};
