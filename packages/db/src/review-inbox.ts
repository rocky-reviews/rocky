import type { StoredAnalysisStatus } from "@rocky-reviews/core";
import type { TenantTx } from "./client.js";

/**
 * What the review inbox (P6-7, ADR 0029) reads: open pull requests of the org's enabled
 * repositories from the mirror (ADR 0010), each with its head revision's size and diff reading
 * and its latest analysis. Read inside the caller's `withOrg` (RLS); the explicit org filters are
 * defence in depth, as elsewhere. The analysis document is returned as stored (unchecked JSON):
 * the caller validates it with `parseAnalysisDocument` before using any of it.
 *
 * Titles and logins are untrusted text; nothing here logs them.
 */

export interface InboxRow {
  readonly pullRequestId: string;
  /** The repository's forge id: what the repository access check (P3-6) is asked about. */
  readonly forgeRepoId: number;
  readonly repoFullName: string;
  readonly number: number;
  readonly title: string;
  readonly authorLogin: string | null;
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string;
  /** The forge's last update, or the mirror's when the forge's is unknown. */
  readonly updatedAt: Date;
  /** The head revision's size; `null` when the head has no revision yet. */
  readonly size: {
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
  } | null;
  /** The head's diff was cut short, or was never read. */
  readonly diffIncomplete: boolean;
  /** The head's latest analysis; else the latest of an older push; else `null`. */
  readonly analysis: {
    readonly status: StoredAnalysisStatus;
    readonly headSha: string;
    readonly document: unknown;
  } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 1000;

const invalid = (field: string): never => {
  throw new Error(`inbox: invalid ${field}`);
};

const SELECT = `
  select p.id, r.forge_repo_id::text as forge_repo_id, r.full_name, p.number, p.title,
         p.author_login, p.state, p.head_sha,
         coalesce(p.forge_updated_at, p.updated_at) as updated_at,
         v.stats, v.id is not null as has_head_revision,
         coalesce(v.diff_truncated, true) or v.diff_bytes is null as diff_incomplete,
         a.status as analysis_status, a.head_sha as analysis_head_sha, a.document
    from pull_requests p
    join repos r on r.org_id = p.org_id and r.id = p.repo_id
    left join pr_revisions v
      on v.org_id = p.org_id and v.pull_request_id = p.id and v.head_sha = p.head_sha
    left join lateral (
      select x.status, xv.head_sha, x.document
        from analyses x
        join pr_revisions xv on xv.org_id = x.org_id and xv.id = x.revision_id
       where x.org_id = p.org_id and xv.pull_request_id = p.id
       order by (xv.head_sha = p.head_sha) desc, x.created_at desc, x.id desc
       limit 1
    ) a on true
   where p.org_id = $1`;

interface Raw {
  id: string;
  forge_repo_id: string;
  full_name: string;
  number: number;
  title: string;
  author_login: string | null;
  state: InboxRow["state"];
  head_sha: string;
  updated_at: Date;
  stats: { additions?: unknown; deletions?: unknown; files?: unknown } | null;
  has_head_revision: boolean;
  diff_incomplete: boolean;
  analysis_status: StoredAnalysisStatus | null;
  analysis_head_sha: string | null;
  document: unknown;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const sizeOf = (row: Raw): InboxRow["size"] => {
  if (!row.has_head_revision || row.stats === null) return null;
  const additions = count(row.stats.additions);
  const deletions = count(row.stats.deletions);
  const files = count(row.stats.files);
  return additions === null || deletions === null || files === null
    ? null
    : { additions, deletions, files };
};

const fromRaw = (row: Raw): InboxRow => ({
  pullRequestId: row.id,
  forgeRepoId: Number(row.forge_repo_id),
  repoFullName: row.full_name,
  number: row.number,
  title: row.title,
  authorLogin: row.author_login,
  state: row.state,
  headSha: row.head_sha,
  updatedAt: row.updated_at,
  size: sizeOf(row),
  diffIncomplete: row.diff_incomplete,
  analysis:
    row.analysis_status === null || row.analysis_head_sha === null
      ? null
      : { status: row.analysis_status, headSha: row.analysis_head_sha, document: row.document },
});

/**
 * Up to `limit` open pull requests of enabled repositories, most recently updated first, and
 * whether more exist. The page sorts them by risk; the limit keeps the newest.
 */
export const listInboxRows = async (
  tx: TenantTx,
  options: { readonly limit: number },
): Promise<{ readonly rows: InboxRow[]; readonly truncated: boolean }> => {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) invalid("limit");
  const { rows } = await tx.query<Raw>(
    `${SELECT} and p.state = 'open' and r.enabled
      order by coalesce(p.forge_updated_at, p.updated_at) desc, p.id
      limit $2`,
    [tx.orgId, limit + 1],
  );
  return { rows: rows.slice(0, limit).map(fromRaw), truncated: rows.length > limit };
};

/**
 * The named pull requests of this org, whatever their state (the approvals route re-checks each
 * one); another org's ids are simply absent (RLS).
 */
export const loadInboxRows = async (
  tx: TenantTx,
  pullRequestIds: readonly string[],
): Promise<InboxRow[]> => {
  if (pullRequestIds.length > MAX_LIMIT) invalid("pull request ids");
  for (const id of pullRequestIds) {
    if (typeof id !== "string" || !UUID.test(id)) invalid("pull request id");
  }
  if (pullRequestIds.length === 0) return [];
  const { rows } = await tx.query<Raw>(`${SELECT} and r.enabled and p.id = any($2::uuid[])`, [
    tx.orgId,
    pullRequestIds,
  ]);
  return rows.map(fromRaw);
};

/** The member's forge login in this org (display data), or `null`. */
export const memberLogin = async (tx: TenantTx, memberId: string): Promise<string | null> => {
  if (typeof memberId !== "string" || !UUID.test(memberId)) invalid("member id");
  const { rows } = await tx.query<{ login: string | null }>(
    "select login from members where org_id = $1 and id = $2",
    [tx.orgId, memberId],
  );
  return rows[0]?.login ?? null;
};
