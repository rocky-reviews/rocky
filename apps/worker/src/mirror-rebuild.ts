import { ForgeReadError, type Forge, type OrgId } from "@rocky-reviews/core";
import { mirroredPullRequests, upsertRepository, type Db } from "@rocky-reviews/db";
import { isRepositoryFullName } from "@rocky-reviews/forge-github";
import { mirrorPullRequest, MIRROR_DIFF_MAX_BYTES } from "./pull-requests.js";

/**
 * Rebuild-from-GitHub for one repository's mirror (P3-4, ADR 0010 §4). The mirror is derived
 * data; this recreates it from GitHub's answers alone, so it also repairs a mirror that lost rows
 * (a restore, a bug, a missed webhook while the server was down) or drifted from GitHub:
 *
 * - every pull request GitHub lists for the repository (any state, newest first, up to `limit`)
 *   is read again and written through the same path as a webhook (`mirrorPullRequest`): row
 *   created or refreshed, head revision recorded with its diff reading (truncation flagged);
 * - a pull request whose stored snapshot already matches the listing (same head, same `updated_at`,
 *   head diff read) is not read again, so a second run is cheap and changes nothing;
 * - rows GitHub did not list are counted (`notListed`) and kept: they may hold a reviewer's work
 *   (drafts, decisions), and deleting tenant data is not a rebuild's call;
 * - earlier revisions of a pull request (one per push seen by a webhook) cannot be recreated:
 *   GitHub keeps no list of past heads. Existing ones are kept; a rebuild recreates the current
 *   head's revision.
 *
 * It acts only after the same checks as the worker: the app check, the repository's installation
 * on GitHub (not suspended), a live org bound to it, and a token GitHub scopes to the repository.
 * Nothing is deleted; every write is an idempotent upsert, safe to run while the worker runs.
 */

export const REBUILD_DEFAULT_LIMIT = 1000;
/** A listing is capped at 100 pages of 100 (`MAX_LIST_PAGES`). */
export const REBUILD_MAX_LIMIT = 10_000;

export type RebuildRefusal =
  | "app_not_installed"
  | "installation_suspended"
  | "unsupported_account_type"
  | "no_org"
  | "repository_inaccessible";

/** Why a rebuild did not start. Fixed codes: safe to log and to print. */
export class RebuildError extends Error {
  override readonly name = "RebuildError";
  constructor(readonly code: RebuildRefusal) {
    super(`mirror rebuild refused: ${code}`);
  }
}

export interface RebuildReport {
  readonly orgId: OrgId;
  readonly installationId: number;
  readonly repositoryId: number;
  /** Pull requests GitHub listed (deduplicated), up to the limit. */
  readonly listed: number;
  /** Created or refreshed from GitHub's answer. */
  readonly mirrored: number;
  /** Already current: not read again. */
  readonly unchanged: number;
  /** Listed, but GitHub answered 404 when read (deleted meanwhile). */
  readonly missing: number;
  /** A newer snapshot was already stored (a webhook got there first). */
  readonly stale: number;
  /** Head revisions recorded or completed with a diff reading. */
  readonly revisionsRecorded: number;
  /** Of those, the ones whose diff is incomplete (`max_bytes`, `forge_limit`, `unavailable`). */
  readonly truncatedDiffs: number;
  /** Mirrored pull requests GitHub did not list; `null` when the limit cut the listing short. */
  readonly notListed: number | null;
  readonly limitReached: boolean;
}

export interface RebuildDeps {
  /** The worker login: the installation lookup is worker-only. */
  readonly db: Db;
  readonly forge: Forge;
}

export interface RebuildOptions {
  readonly limit?: number;
  readonly maxDiffBytes?: number;
}

export const rebuildRepositoryMirror = async (
  deps: RebuildDeps,
  fullName: string,
  options: RebuildOptions = {},
): Promise<RebuildReport> => {
  if (!isRepositoryFullName(fullName)) throw new Error("rebuild: expected owner/name");
  const limit = options.limit ?? REBUILD_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > REBUILD_MAX_LIMIT) {
    throw new Error(`rebuild: limit must be 1..${REBUILD_MAX_LIMIT}`);
  }
  // Another app's key would make GitHub answer 404 for everything (ADR 0009 §4).
  await deps.forge.verifyApp();

  let ref;
  try {
    ref = await deps.forge.locateRepository(fullName);
  } catch (error) {
    if (error instanceof ForgeReadError && error.reason === "installation_suspended") {
      throw new RebuildError("installation_suspended");
    }
    throw error;
  }
  if (ref === null) throw new RebuildError("app_not_installed");
  let installation;
  try {
    installation = await deps.forge.getInstallation(ref.installationId);
  } catch (error) {
    if (error instanceof ForgeReadError && error.reason === "unsupported_account_type") {
      throw new RebuildError("unsupported_account_type");
    }
    throw error;
  }
  if (installation === null) throw new RebuildError("app_not_installed");
  if (installation.suspended) throw new RebuildError("installation_suspended");
  const [org] = (await deps.db.installationOrgs(deps.forge.kind, ref.installationId, null)).filter(
    (o) => o.installationId === ref.installationId,
  );
  if (org === undefined) throw new RebuildError("no_org");

  const session = await deps.forge.openRepository(ref);
  if (session === null) throw new RebuildError("repository_inaccessible");
  const counts = {
    listed: 0,
    mirrored: 0,
    unchanged: 0,
    missing: 0,
    stale: 0,
    revisionsRecorded: 0,
    truncatedDiffs: 0,
  };
  let limitReached = false;
  const seen = new Set<number>();
  try {
    const existing = new Map(
      (
        await deps.db.withOrg(org.orgId, async (tx) => {
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
      const result = await mirrorPullRequest(deps.db, org.orgId, session, pr, {
        maxDiffBytes: options.maxDiffBytes ?? MIRROR_DIFF_MAX_BYTES,
      });
      if (result.outcome === "pr_stale_snapshot") counts.stale++;
      else if (result.outcome === "pr_unchanged") counts.unchanged++;
      else counts.mirrored++;
      if (result.revision === "created" || result.revision === "completed") {
        counts.revisionsRecorded++;
        if (result.truncation !== null) counts.truncatedDiffs++;
      }
    }
    return {
      orgId: org.orgId,
      installationId: ref.installationId,
      repositoryId: ref.repositoryId,
      ...counts,
      notListed: limitReached ? null : [...existing.keys()].filter((n) => !seen.has(n)).length,
      limitReached,
    };
  } finally {
    await session.close();
  }
};

/** `<owner/name> [--limit N]`. Throws with a usage message on anything else. */
export const parseRebuildArgs = (
  argv: readonly string[],
): { readonly fullName: string; readonly limit: number } => {
  const usage = `usage: pnpm mirror:rebuild <owner/name> [--limit 1..${REBUILD_MAX_LIMIT}]`;
  let fullName: string | undefined;
  let limit = REBUILD_DEFAULT_LIMIT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--limit") {
      const value = argv[++i];
      if (value === undefined || !/^[1-9][0-9]{0,4}$/.test(value)) throw new Error(usage);
      limit = Number(value);
      if (limit > REBUILD_MAX_LIMIT) throw new Error(usage);
    } else if (fullName === undefined && isRepositoryFullName(arg)) {
      fullName = arg;
    } else {
      throw new Error(usage);
    }
  }
  if (fullName === undefined) throw new Error(usage);
  return { fullName, limit };
};
