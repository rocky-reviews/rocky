import type { StoredAnalysisStatus } from "@rocky-reviews/core";
import type { TenantTx } from "./client.js";

/**
 * What the PR review page reads (H4-2, ADR 0019 §3 amendment): one pull request of an enabled
 * repository, found by the repository's `owner/name` (case-insensitively, as GitHub treats it)
 * and its number, from the mirror (ADR 0010), with
 *
 * - the head revision's size (`pr_revisions.stats`), or `null` before the head is recorded;
 * - the head revision's latest analysis row, any status (`headRun`): where the analysis of the
 *   current head stands, with the fixed error code and the token estimate the row carries;
 * - the latest finished analysis (`done`): the head's (ordered as the drafts and posting code
 *   orders it, `reviews.ts`), else an older push's, whose briefing the page shows as out of date;
 * - the member's latest review posted from Rocky on this pull request (`myVerdict`).
 *
 * Read inside the caller's `withOrg` (RLS); the explicit org filters are defence in depth, as
 * elsewhere. The document is returned as stored (unchecked JSON): the caller validates it before
 * using any of it. Titles and logins are untrusted text; nothing here logs them.
 */

export interface PullRequestPageRow {
  readonly pullRequestId: string;
  /** The repository's forge id: what the repository access check (P3-6) is asked about. */
  readonly forgeRepoId: number;
  /** As stored (the forge's spelling), not as the caller typed it. */
  readonly repoFullName: string;
  readonly number: number;
  readonly title: string;
  readonly authorLogin: string | null;
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string;
  /** The forge's last update, or the mirror's when the forge's is unknown. */
  readonly updatedAt: Date;
  readonly size: {
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
  } | null;
  readonly headRun: {
    readonly analysisId: string;
    readonly status: StoredAnalysisStatus;
    readonly errorCode: string | null;
    readonly estimatedTokens: number | null;
    readonly limitTokens: number | null;
  } | null;
  readonly done: {
    readonly analysisId: string;
    readonly headSha: string;
    readonly document: unknown;
  } | null;
  readonly myVerdict: "approve" | "request_changes" | "comment" | null;
}

export class PullRequestPageError extends Error {
  override readonly name = "PullRequestPageError";
}

/** The mirror's repository name rule (`mirror.ts`). */
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INT = 2_147_483_647;

/** Messages name the field, never the value. */
const invalid = (field: string): never => {
  throw new PullRequestPageError(`pull request page: invalid ${field}`);
};

interface Raw {
  id: string;
  forge_repo_id: string;
  full_name: string;
  number: number;
  title: string;
  author_login: string | null;
  state: PullRequestPageRow["state"];
  head_sha: string;
  updated_at: Date;
  stats: { additions?: unknown; deletions?: unknown; files?: unknown } | null;
  run_id: string | null;
  run_status: StoredAnalysisStatus | null;
  run_error_code: string | null;
  run_estimated_tokens: number | null;
  run_limit_tokens: number | null;
  done_id: string | null;
  done_head_sha: string | null;
  done_document: unknown;
  my_verdict: PullRequestPageRow["myVerdict"];
}

const SELECT = `
  select p.id, r.forge_repo_id::text as forge_repo_id, r.full_name, p.number, p.title,
         p.author_login, p.state, p.head_sha,
         coalesce(p.forge_updated_at, p.updated_at) as updated_at,
         v.stats,
         run.id as run_id, run.status as run_status, run.error_code as run_error_code,
         run.estimated_tokens as run_estimated_tokens, run.limit_tokens as run_limit_tokens,
         done.id as done_id, done.head_sha as done_head_sha, done.document as done_document,
         mine.verdict as my_verdict
    from pull_requests p
    join repos r on r.org_id = p.org_id and r.id = p.repo_id
    left join pr_revisions v
      on v.org_id = p.org_id and v.pull_request_id = p.id and v.head_sha = p.head_sha
    left join lateral (
      select x.id, x.status, x.error_code, x.estimated_tokens, x.limit_tokens
        from analyses x
       where x.org_id = p.org_id and x.revision_id = v.id
       order by x.created_at desc, x.id desc
       limit 1
    ) run on true
    left join lateral (
      select x.id, xv.head_sha, x.document
        from analyses x
        join pr_revisions xv on xv.org_id = x.org_id and xv.id = x.revision_id
       where x.org_id = p.org_id and xv.pull_request_id = p.id and x.status = 'done'
       order by (xv.head_sha = p.head_sha) desc, x.completed_at desc nulls last,
                x.created_at desc, x.id
       limit 1
    ) done on true
    left join lateral (
      select s.verdict
        from review_submissions s
       where s.org_id = p.org_id and s.pull_request_id = p.id and s.submitted_by = $4
         and s.status = 'posted'
       order by s.created_at desc, s.id desc
       limit 1
    ) mine on true
   where p.org_id = $1 and lower(r.full_name) = lower($2) and p.number = $3 and r.enabled
   order by r.updated_at desc, r.id
   limit 1`;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const sizeOf = (stats: Raw["stats"]): PullRequestPageRow["size"] => {
  if (stats === null) return null;
  const additions = count(stats.additions);
  const deletions = count(stats.deletions);
  const files = count(stats.files);
  return additions === null || deletions === null || files === null
    ? null
    : { additions, deletions, files };
};

/**
 * What the diff endpoint needs before it asks GitHub (H4-3, ADR 0034): the pull request's id,
 * its repository's forge id (for the access check and the token), the org's installation (on
 * whose behalf the token is minted), the mirror's head and, when the head's revision is
 * recorded, the base the mirror diffed it against (the analysis read that same diff). No
 * content: titles and names stay in the row.
 */
export interface PullRequestDiffTargetRow {
  readonly pullRequestId: string;
  readonly forgeRepoId: number;
  /** `null` when the org row holds no installation (nothing can be read on its behalf). */
  readonly installationId: number | null;
  readonly headSha: string;
  readonly baseSha: string | null;
}

const SELECT_DIFF_TARGET = `
  select p.id, r.forge_repo_id::text as forge_repo_id, o.installation_id::text as installation_id,
         p.head_sha, v.base_sha
    from pull_requests p
    join repos r on r.org_id = p.org_id and r.id = p.repo_id
    join orgs o on o.id = p.org_id
    left join pr_revisions v
      on v.org_id = p.org_id and v.pull_request_id = p.id and v.head_sha = p.head_sha
   where p.org_id = $1 and lower(r.full_name) = lower($2) and p.number = $3 and r.enabled
   order by r.updated_at desc, r.id
   limit 1`;

const forgeId = (value: string | null): number | null => {
  const id = value === null ? NaN : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/**
 * The diff target of `owner/repo#number` in this org, or `null` as `loadPullRequestPage`
 * answers it (unknown, disabled, another org's, impossible names).
 */
export const loadPullRequestDiffTarget = async (
  tx: TenantTx,
  target: { readonly owner: string; readonly repo: string; readonly number: number },
): Promise<PullRequestDiffTargetRow | null> => {
  const { owner, repo, number } = target;
  if (!Number.isInteger(number) || number < 1 || number > MAX_INT) invalid("number");
  if (typeof owner !== "string" || typeof repo !== "string") invalid("repository");
  const fullName = `${owner}/${repo}`;
  if (!FULL_NAME.test(fullName)) return null;
  const { rows } = await tx.query<{
    id: string;
    forge_repo_id: string;
    installation_id: string | null;
    head_sha: string;
    base_sha: string | null;
  }>(SELECT_DIFF_TARGET, [tx.orgId, fullName, number]);
  const row = rows[0];
  if (row === undefined) return null;
  const repoId = forgeId(row.forge_repo_id);
  if (repoId === null) return invalid("repository id");
  return {
    pullRequestId: row.id,
    forgeRepoId: repoId,
    installationId: forgeId(row.installation_id),
    headSha: row.head_sha,
    baseSha: row.base_sha,
  };
};

/**
 * The pull request `owner/repo#number` of this org, or `null` when the org has none (RLS hides
 * other orgs'), its repository is disabled, or the names cannot be a repository's.
 */
export const loadPullRequestPage = async (
  tx: TenantTx,
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly memberId: string;
  },
): Promise<PullRequestPageRow | null> => {
  const { owner, repo, number, memberId } = target;
  if (typeof memberId !== "string" || !UUID.test(memberId)) invalid("member id");
  if (!Number.isInteger(number) || number < 1 || number > MAX_INT) invalid("number");
  if (typeof owner !== "string" || typeof repo !== "string") invalid("repository");
  const fullName = `${owner}/${repo}`;
  if (!FULL_NAME.test(fullName)) return null;
  const { rows } = await tx.query<Raw>(SELECT, [tx.orgId, fullName, number, memberId]);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    pullRequestId: row.id,
    forgeRepoId: Number(row.forge_repo_id),
    repoFullName: row.full_name,
    number: row.number,
    title: row.title,
    authorLogin: row.author_login,
    state: row.state,
    headSha: row.head_sha,
    updatedAt: row.updated_at,
    size: sizeOf(row.stats),
    headRun:
      row.run_id === null || row.run_status === null
        ? null
        : {
            analysisId: row.run_id,
            status: row.run_status,
            errorCode: row.run_error_code,
            estimatedTokens: row.run_estimated_tokens,
            limitTokens: row.run_limit_tokens,
          },
    done:
      row.done_id === null || row.done_head_sha === null
        ? null
        : { analysisId: row.done_id, headSha: row.done_head_sha, document: row.done_document },
    myVerdict: row.my_verdict,
  };
};
