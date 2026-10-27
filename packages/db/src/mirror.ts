import type { DiffTruncation, ForgePullRequest, ForgeRepository } from "@rocky-reviews/core";
import type { TenantTx } from "./client.js";

/**
 * The pull request mirror (P3-4, migration 0008, ADR 0010): `repos`, `pull_requests` and
 * `pr_revisions` rows derived from what the forge answers. Every write runs inside `withOrg`
 * (the org's tenant transaction, RLS) and is an idempotent upsert, so replaying an event or
 * running the rebuild again changes nothing. GitHub is the source of truth: a snapshot older
 * than the stored one (by the forge's own `updated_at`) is never applied.
 *
 * Titles and logins are untrusted text stored verbatim; nothing here logs them. Diff text is not
 * stored: a revision records how many bytes were read, their sha256 and why the diff is
 * incomplete, if it is.
 */

/** What was read of a revision's diff. */
export interface RevisionDiff {
  /** UTF-8 bytes of the diff text that was read. */
  readonly bytes: number;
  /** sha256 of those bytes, lower-case hex. */
  readonly sha256: string;
  readonly truncation: DiffTruncation | null;
}

/** A mirrored pull request of one repository, as the rebuild compares it with the forge. */
export interface MirroredPullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly forgeUpdatedAt: Date | null;
  /** The revision of the current head exists and its diff was read. */
  readonly headDiffRead: boolean;
}

export type PullRequestWrite = "created" | "updated" | "unchanged" | "stale";
export type RevisionWrite = "created" | "completed" | "unchanged";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** No control characters, spaces or DEL; bounded. */
const isBranch = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length >= 1 &&
  v.length <= 255 &&
  [...v].every((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f);
const ACTOR_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TITLE = 1024;
const MAX_INT = 2_147_483_647;
const TRUNCATIONS: ReadonlySet<string> = new Set(["max_bytes", "forge_limit", "unavailable"]);
const STATES: ReadonlySet<string> = new Set(["open", "closed", "merged"]);

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isCount = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_INT;
const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

/** Messages name the field, never the value (it can be untrusted text). */
const invalid = (field: string): never => {
  throw new Error(`mirror: invalid ${field}`);
};

const checkRepository = (repo: ForgeRepository): void => {
  if (!isId(repo.id)) invalid("repository id");
  if (typeof repo.fullName !== "string" || !FULL_NAME.test(repo.fullName))
    invalid("repository name");
  if (typeof repo.private !== "boolean") invalid("repository visibility");
  if (!isBranch(repo.defaultBranch)) {
    invalid("default branch");
  }
};

const checkPullRequest = (pr: ForgePullRequest): void => {
  if (!isId(pr.ref.repositoryId) || !isId(pr.ref.installationId)) invalid("pull request ref");
  if (!Number.isInteger(pr.ref.number) || pr.ref.number < 1 || pr.ref.number > MAX_INT) {
    invalid("pull request number");
  }
  if (typeof pr.title !== "string" || pr.title.length > MAX_TITLE) invalid("title");
  if (
    pr.authorLogin !== null &&
    (typeof pr.authorLogin !== "string" || !ACTOR_LOGIN.test(pr.authorLogin))
  ) {
    invalid("author");
  }
  if (!STATES.has(pr.state)) invalid("state");
  if (typeof pr.headSha !== "string" || !SHA.test(pr.headSha)) invalid("head sha");
  if (typeof pr.baseSha !== "string" || !SHA.test(pr.baseSha)) invalid("base sha");
  if (!isDate(pr.openedAt) || !isDate(pr.updatedAt)) invalid("dates");
  if (pr.closedAt !== null && !isDate(pr.closedAt)) invalid("closed date");
  if (!isCount(pr.changedFiles) || !isCount(pr.additions) || !isCount(pr.deletions)) {
    invalid("stats");
  }
};

const checkDiff = (diff: RevisionDiff): void => {
  if (!isCount(diff.bytes)) invalid("diff size");
  if (typeof diff.sha256 !== "string" || !SHA256_HEX.test(diff.sha256)) invalid("diff digest");
  if (diff.truncation !== null && !TRUNCATIONS.has(diff.truncation)) invalid("diff truncation");
};

/** Creates or refreshes the repository row of `tx.orgId`; returns its id. */
export const upsertRepository = async (tx: TenantTx, repo: ForgeRepository): Promise<string> => {
  checkRepository(repo);
  const { rows } = await tx.query<{ id: string }>(
    `insert into repos (forge_repo_id, full_name, private, default_branch)
     values ($1, $2, $3, $4)
     on conflict (org_id, forge_repo_id) do update
        set full_name = excluded.full_name, private = excluded.private,
            default_branch = excluded.default_branch, updated_at = now()
      where (repos.full_name, repos.private, repos.default_branch)
            is distinct from (excluded.full_name, excluded.private, excluded.default_branch)
     returning id`,
    [repo.id, repo.fullName, repo.private, repo.defaultBranch],
  );
  if (rows[0] !== undefined) return rows[0].id;
  const existing = await tx.query<{ id: string }>("select id from repos where forge_repo_id = $1", [
    repo.id,
  ]);
  const id = existing.rows[0]?.id;
  if (id === undefined) throw new Error("mirror: repository row missing");
  return id;
};

/**
 * Applies the forge's snapshot of a pull request to the mirror, unless the stored one is newer
 * (`stale`). Returns its row id and what happened.
 */
export const upsertPullRequest = async (
  tx: TenantTx,
  repoId: string,
  pr: ForgePullRequest,
): Promise<{ readonly id: string; readonly write: PullRequestWrite }> => {
  if (typeof repoId !== "string" || !UUID.test(repoId)) invalid("repository row id");
  checkPullRequest(pr);
  const values = [
    repoId,
    pr.ref.number,
    pr.title,
    pr.authorLogin,
    pr.state,
    pr.headSha,
    pr.baseSha,
    pr.openedAt,
    pr.closedAt,
    pr.updatedAt,
  ];
  const { rows } = await tx.query<{ id: string; inserted: boolean }>(
    `insert into pull_requests
       (repo_id, number, title, author_login, state, head_sha, base_sha, opened_at, closed_at,
        forge_updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (org_id, repo_id, number) do update
        set title = excluded.title, author_login = excluded.author_login, state = excluded.state,
            head_sha = excluded.head_sha, base_sha = excluded.base_sha,
            opened_at = excluded.opened_at, closed_at = excluded.closed_at,
            forge_updated_at = excluded.forge_updated_at, updated_at = now()
      where (pull_requests.forge_updated_at is null
             or pull_requests.forge_updated_at <= excluded.forge_updated_at)
        and (pull_requests.title, pull_requests.author_login, pull_requests.state,
             pull_requests.head_sha, pull_requests.base_sha, pull_requests.opened_at,
             pull_requests.closed_at, pull_requests.forge_updated_at)
            is distinct from
            (excluded.title, excluded.author_login, excluded.state, excluded.head_sha,
             excluded.base_sha, excluded.opened_at, excluded.closed_at, excluded.forge_updated_at)
     returning id, (xmax = 0) as inserted`,
    values,
  );
  const row = rows[0];
  if (row !== undefined) return { id: row.id, write: row.inserted ? "created" : "updated" };
  const existing = await tx.query<{ id: string; newer: boolean }>(
    `select id, coalesce(forge_updated_at > $3, false) as newer
       from pull_requests where repo_id = $1 and number = $2`,
    [repoId, pr.ref.number, pr.updatedAt],
  );
  const found = existing.rows[0];
  if (found === undefined) throw new Error("mirror: pull request row missing");
  return { id: found.id, write: found.newer ? "stale" : "unchanged" };
};

/**
 * Records the revision of the pull request's current head with what was read of its diff. A
 * revision that exists without a diff reading gets one (`completed`); one that has a reading is
 * kept as it is (`unchanged`): a revision's commits, and so its diff, do not change.
 */
export const recordRevision = async (
  tx: TenantTx,
  pullRequestId: string,
  pr: ForgePullRequest,
  diff: RevisionDiff,
): Promise<RevisionWrite> => {
  if (typeof pullRequestId !== "string" || !UUID.test(pullRequestId)) {
    invalid("pull request row id");
  }
  checkPullRequest(pr);
  checkDiff(diff);
  const { rows } = await tx.query<{ inserted: boolean }>(
    `insert into pr_revisions
       (pull_request_id, head_sha, base_sha, stats, diff_truncated, diff_bytes, diff_sha256,
        diff_truncation)
     values ($1, $2, $3, $4::jsonb, $5, $6, decode($7, 'hex'), $8)
     on conflict (org_id, pull_request_id, head_sha) do update
        set base_sha = excluded.base_sha, stats = excluded.stats,
            diff_truncated = excluded.diff_truncated, diff_bytes = excluded.diff_bytes,
            diff_sha256 = excluded.diff_sha256, diff_truncation = excluded.diff_truncation
      where pr_revisions.diff_bytes is null
     returning (xmax = 0) as inserted`,
    [
      pullRequestId,
      pr.headSha,
      pr.baseSha,
      JSON.stringify({ files: pr.changedFiles, additions: pr.additions, deletions: pr.deletions }),
      diff.truncation !== null,
      diff.bytes,
      diff.sha256,
      diff.truncation,
    ],
  );
  const row = rows[0];
  if (row === undefined) return "unchanged";
  return row.inserted ? "created" : "completed";
};

const MIRRORED_SQL = `
  select p.number, p.head_sha, p.forge_updated_at, (r.diff_bytes is not null) as head_diff_read
    from pull_requests p
    join repos rp on rp.org_id = p.org_id and rp.id = p.repo_id
    left join pr_revisions r
      on r.org_id = p.org_id and r.pull_request_id = p.id and r.head_sha = p.head_sha
   where rp.forge_repo_id = $1`;

const mirroredFromRow = (row: {
  number: number;
  head_sha: string;
  forge_updated_at: Date | null;
  head_diff_read: boolean;
}): MirroredPullRequest => ({
  number: row.number,
  headSha: row.head_sha,
  forgeUpdatedAt: row.forge_updated_at,
  headDiffRead: row.head_diff_read,
});

/** Every mirrored pull request of the repository with this forge id, by number. */
export const mirroredPullRequests = async (
  tx: TenantTx,
  forgeRepositoryId: number,
): Promise<MirroredPullRequest[]> => {
  if (!isId(forgeRepositoryId)) invalid("repository id");
  const { rows } = await tx.query<Parameters<typeof mirroredFromRow>[0]>(
    `${MIRRORED_SQL} order by p.number`,
    [forgeRepositoryId],
  );
  return rows.map(mirroredFromRow);
};

/** One mirrored pull request, or `undefined` when it is not in the mirror. */
export const mirroredPullRequest = async (
  tx: TenantTx,
  forgeRepositoryId: number,
  number: number,
): Promise<MirroredPullRequest | undefined> => {
  if (!isId(forgeRepositoryId)) invalid("repository id");
  if (!Number.isInteger(number) || number < 1 || number > MAX_INT) invalid("pull request number");
  const { rows } = await tx.query<Parameters<typeof mirroredFromRow>[0]>(
    `${MIRRORED_SQL} and p.number = $2`,
    [forgeRepositoryId, number],
  );
  return rows[0] === undefined ? undefined : mirroredFromRow(rows[0]);
};
