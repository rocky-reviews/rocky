import { createHash } from "node:crypto";
import {
  can,
  canonicalReviewPlan,
  composePostedComment,
  isReviewVerdict,
  validateReviewSubmission,
  type ReviewComment,
  type ReviewPlanItem,
  type ReviewSubmission,
  type ReviewVerdict,
} from "@rocky-reviews/core";
import { parseAnalysisDocument, type Finding } from "@rocky-reviews/schema";
import { audit } from "./audit.js";
import type { TenantTx } from "./client.js";

/**
 * Posting a review as the user: the tenant side (P3-5, migration 0016, ADR 0026).
 *
 * `loadReviewPlan` builds the exact list a person can post on a pull request **now**, from the
 * latest finished analysis of the head revision and that person's rows of P6-4's tables
 * (ADR 0027): the drafts they accepted (`findings_state`, posted as `composePostedComment` of
 * the finding and their `ai`/`ai_edited` pending row, which is what the accepted card shows),
 * and their own pending comments (`comments_pending` with `source = 'own'`), minus anything
 * already carried by a submission in flight or posted. The plan's canonical form (packages/core) is hashed; the web app shows the plan and
 * echoes the hash, so `beginReviewSubmission` can refuse (`stale`) when the list changed in
 * between, instead of posting something the person did not see.
 *
 * `beginReviewSubmission` runs inside the caller's `withOrg` transaction and, in this order:
 * takes a per (pull request, member) advisory lock; re-checks the actor (active member whose
 * role holds `pull_requests.review`, `FOR SHARE`); answers an earlier attempt with the same
 * idempotency key instead of starting another; rebuilds the plan and compares digests and the
 * head; refuses while another attempt is in flight; then records the attempt as `posting` with
 * its items. Only after that commit does the server call the forge; `finishReviewSubmission`
 * records the answer. An attempt that never finishes (a lost answer) keeps its items off the
 * next plan until the server reconciles it with the forge.
 *
 * Never a body or a token in a result, an error or the database beyond what the tables hold
 * (digests, counts, ids). Results are fixed codes.
 */

export class ReviewStoreError extends Error {
  override readonly name = "ReviewStoreError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/i;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const assertUuid = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ReviewStoreError(`reviews: ${what} must be a uuid`);
  }
  return value.toLowerCase();
};

export const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

export interface ReviewPlan {
  readonly pullRequestId: string;
  /** The head revision's id, or `null` when the mirror holds no revision for the head yet. */
  readonly revisionId: string | null;
  readonly headSha: string;
  readonly number: number;
  readonly repositoryFullName: string;
  readonly forgeRepoId: number;
  readonly items: readonly ReviewPlanItem[];
  /** sha256 of `canonicalReviewPlan(headSha, items)`. */
  readonly contentSha256: Buffer;
  /** The member's attempt still being posted, if any (its items are not in `items`). */
  readonly inFlight: ReviewSubmissionRecord | null;
  /** The member's most recent attempt on this pull request, any status. */
  readonly latest: ReviewSubmissionRecord | null;
}

interface PullRequestRow {
  id: string;
  number: number;
  head_sha: string;
  full_name: string;
  forge_repo_id: string;
}

/**
 * The plan for `memberId` on this pull request, or `null` when the org has no such pull request
 * (RLS hides other orgs'). Drafts in the plan are the member's own decisions; comments are the
 * member's own; items of a `posting` or `posted` submission are left out.
 */
export const loadReviewPlan = async (
  tx: TenantTx,
  target: { readonly pullRequestId: string; readonly memberId: string },
): Promise<ReviewPlan | null> => {
  const pullRequestId = assertUuid(target.pullRequestId, "pull request id");
  const memberId = assertUuid(target.memberId, "member id");
  const { rows: prs } = await tx.query<PullRequestRow>(
    `select p.id, p.number, p.head_sha, r.full_name, r.forge_repo_id::text as forge_repo_id
       from pull_requests p join repos r on r.org_id = p.org_id and r.id = p.repo_id
      where p.org_id = $1 and p.id = $2`,
    [tx.orgId, pullRequestId],
  );
  const pr = prs[0];
  if (pr === undefined) return null;
  const { rows: revisions } = await tx.query<{ id: string }>(
    `select id from pr_revisions
      where org_id = $1 and pull_request_id = $2 and head_sha = $3
      order by created_at desc, id limit 1`,
    [tx.orgId, pr.id, pr.head_sha],
  );
  const revisionId = revisions[0]?.id ?? null;
  const items: ReviewPlanItem[] = [];
  const analysis = revisionId === null ? null : await latestDoneAnalysis(tx, revisionId);
  if (revisionId !== null && analysis !== null) {
    items.push(...(await acceptedDrafts(tx, revisionId, analysis, memberId)));
    items.push(...(await ownComments(tx, pr.id, revisionId, analysis.id, memberId)));
  }
  const { rows: latest } = await tx.query<SubmissionRow>(
    `select ${SUBMISSION_COLUMNS} from review_submissions
      where org_id = $1 and pull_request_id = $2 and submitted_by = $3
      order by created_at desc, id desc limit 1`,
    [tx.orgId, pr.id, memberId],
  );
  const { rows: inFlight } = await tx.query<SubmissionRow>(
    `select ${SUBMISSION_COLUMNS} from review_submissions
      where org_id = $1 and pull_request_id = $2 and submitted_by = $3 and status = 'posting'`,
    [tx.orgId, pr.id, memberId],
  );
  return {
    pullRequestId: pr.id,
    revisionId,
    headSha: pr.head_sha,
    number: pr.number,
    repositoryFullName: pr.full_name,
    forgeRepoId: Number(pr.forge_repo_id),
    items,
    contentSha256: sha256(canonicalReviewPlan(pr.head_sha, items)),
    inFlight: inFlight[0] === undefined ? null : record(inFlight[0]),
    latest: latest[0] === undefined ? null : record(latest[0]),
  };
};

/**
 * The attempts carrying item `ITEM` of kind `KIND` for org `ORG` (tokens): posting or posted.
 * The one definition of "carried" (the plan, `isCarried`, the drafts view's `posted` flag).
 */
const CARRIED_FROM = `from review_submission_items i
    join review_submissions s on s.org_id = i.org_id and s.id = i.submission_id
   where i.org_id = ORG and i.kind = KIND and i.item_id = ITEM and s.status in ('posting', 'posted')`;

/** Items carried by a submission that is posting or posted: never offered again. */
const CARRIED_SQL = `exists (select 1 ${CARRIED_FROM.replace("ORG", "$1").replace("KIND", "$2")})`;
const NOT_CARRIED = `not ${CARRIED_SQL}`;

/**
 * A scalar subquery: the status of the attempt carrying the item (`posted` wins over
 * `posting`), or null. `org`, `kind` and `item` are SQL expressions or placeholders.
 */
export const carriedStatusSql = (org: string, kind: string, item: string): string =>
  `(select s.status ${CARRIED_FROM.replace("ORG", org).replace("KIND", kind).replace("ITEM", item)}
    order by s.status = 'posted' desc limit 1)`;

/**
 * Whether one item (a `findings_state` id for a draft, a `comments_pending` id for a comment) is
 * carried by a submission that is posting or posted. P6-4's draft routes refuse to change such an
 * item (`already_posted`, review fix S2); call it after `lockReviewPlan`, so a submission that
 * starts concurrently is either seen here or sees the change (and answers `stale`).
 */
export const isCarried = async (
  tx: TenantTx,
  kind: "draft" | "comment",
  itemId: string,
): Promise<boolean> => {
  const { rows } = await tx.query(`select 1 where ${CARRIED_SQL.replace("ITEM", "$3")}`, [
    tx.orgId,
    kind,
    itemId,
  ]);
  return rows.length > 0;
};

/** Where and what a draft posts: the location and the posted markdown (S1, matched by content). */
export interface PostedDraftContent {
  readonly path: string;
  readonly line: number;
  readonly startLine: number | null;
  /** `composePostedComment(finding, pending)`, exactly as posted. */
  readonly body: string;
}

/** What an accepted draft posts: the finding's location and `composePostedComment`. */
export const postedDraftContent = (finding: Finding, pendingBody: string): PostedDraftContent => ({
  path: finding.path,
  line: finding.range.end,
  startLine: finding.range.start === finding.range.end ? null : finding.range.start,
  body: composePostedComment(finding, { body: pendingBody }),
});

/**
 * What the member's posting or posted submissions on one revision carried as drafts, by content
 * (review fix S1, #39 SF1). Finding ids are positional (`F1`, `F2`, ... per analysis), so a re-run
 * of the same head renumbers them: matching by id would both refuse unrelated findings and miss a
 * posted one that came back under another id. A carried draft is identified instead by what was
 * posted: its location (from its pending row, written from the validated finding) and the sha256
 * of the posted body (`review_submission_items.body_sha256`). A carried draft whose pending row is
 * gone matches on the body digest alone (fails closed). Scoped to the member's own submissions
 * and to the revision (a new push is a new revision: its findings may be posted again).
 */
export const carriedDraftContent = async (
  tx: TenantTx,
  memberId: string,
  revisionId: string,
): Promise<(draft: PostedDraftContent) => boolean> => {
  const { rows } = await tx.query<{
    body_sha256: Buffer;
    path: string | null;
    line: number | null;
    start_line: number | null;
  }>(
    `select i.body_sha256, c.path, c.line, c.start_line
       from review_submission_items i
       join review_submissions s on s.org_id = i.org_id and s.id = i.submission_id
       left join findings_state g on g.org_id = i.org_id and g.id = i.item_id
       left join comments_pending c
         on c.org_id = g.org_id and c.analysis_id = g.analysis_id and c.author_id = g.member_id
        and c.finding_id = g.finding_id and c.source in ('ai', 'ai_edited')
      where i.org_id = $1 and i.kind = 'draft' and s.status in ('posting', 'posted')
        and s.submitted_by = $2 and s.revision_id = $3`,
    [tx.orgId, memberId, revisionId],
  );
  const key = (path: string, line: number, startLine: number | null, digest: string) =>
    JSON.stringify([path, line, startLine, digest]);
  const located = new Set<string>();
  const anywhere = new Set<string>();
  for (const row of rows) {
    const digest = row.body_sha256.toString("hex");
    if (row.path === null || row.line === null) anywhere.add(digest);
    else located.add(key(row.path, row.line, row.start_line, digest));
  }
  return (draft) => {
    const digest = sha256(draft.body).toString("hex");
    return (
      anywhere.has(digest) || located.has(key(draft.path, draft.line, draft.startLine, digest))
    );
  };
};

interface DoneAnalysis {
  readonly id: string;
  readonly document: unknown;
}

/** The head revision's latest finished analysis: the one the page shows and drafts belong to. */
const latestDoneAnalysis = async (
  tx: TenantTx,
  revisionId: string,
): Promise<DoneAnalysis | null> => {
  const { rows } = await tx.query<{ id: string; document: unknown }>(
    `select id, document from analyses
      where org_id = $1 and revision_id = $2 and status = 'done'
      order by completed_at desc nulls last, created_at desc, id limit 1`,
    [tx.orgId, revisionId],
  );
  return rows[0] ?? null;
};

/**
 * The member's accepted drafts on `analysis`: their own decision (P6-4 keeps one row per
 * reviewer; `decided_by` is checked too) joined with the pending row written with it. The body
 * posted is `composePostedComment(finding, pending)`: the finding's title and suggestion with the
 * pending body, the finding's or the member's edit (`ai_edited`), exactly as the accepted card
 * shows it. Location and title come from the stored document, validated again here.
 */
const acceptedDrafts = async (
  tx: TenantTx,
  revisionId: string,
  analysis: DoneAnalysis,
  memberId: string,
): Promise<ReviewPlanItem[]> => {
  // The document is validated again at the read (never trust a row's shape); a document that
  // does not parse offers nothing to post.
  const parsed = parseAnalysisDocument(analysis.document);
  if (!parsed.ok) return [];
  const { rows: accepted } = await tx.query<{ id: string; finding_id: string; body: string }>(
    `select f.id, f.finding_id, c.body from findings_state f
       join comments_pending c
         on c.org_id = f.org_id and c.analysis_id = f.analysis_id
        and c.author_id = f.member_id and c.finding_id = f.finding_id
        and c.source in ('ai', 'ai_edited')
      where f.org_id = $1 and f.analysis_id = $3 and f.state = 'accepted'
        and f.member_id = $4 and f.decided_by = $4
        and ${NOT_CARRIED.replace("ITEM", "f.id")}`,
    [tx.orgId, "draft", analysis.id, memberId],
  );
  const byFinding = new Map(accepted.map((row) => [row.finding_id, row]));
  const carried = await carriedDraftContent(tx, memberId, revisionId);
  const items: ReviewPlanItem[] = [];
  // Document order: the order the person saw the drafts in.
  for (const finding of parsed.value.findings) {
    const row = byFinding.get(finding.id);
    if (row === undefined) continue;
    const content = postedDraftContent(finding, row.body);
    // Already posted from another analysis of this revision (a re-run), whatever its id there.
    if (carried(content)) continue;
    items.push({ kind: "draft", id: row.id, ...content });
  }
  return items;
};

/**
 * The member's own pending comments on `analysis` (`source = 'own'`). Accepted drafts also have
 * a pending row (`ai`/`ai_edited`); they are posted once, as drafts, above.
 */
const ownComments = async (
  tx: TenantTx,
  pullRequestId: string,
  revisionId: string,
  analysisId: string,
  memberId: string,
): Promise<ReviewPlanItem[]> => {
  // A comment without a line cannot be an inline review comment: it is not offered.
  const { rows } = await tx.query<{
    id: string;
    path: string;
    line: number;
    start_line: number | null;
    body: string;
  }>(
    `select c.id, c.path, c.line, c.start_line, c.body from comments_pending c
      where c.org_id = $1 and c.pull_request_id = $3 and c.revision_id = $4
        and c.analysis_id = $5 and c.author_id = $6 and c.source = 'own'
        and c.path is not null and c.line is not null
        and ${NOT_CARRIED.replace("ITEM", "c.id")}
      order by c.created_at, c.id`,
    [tx.orgId, "comment", pullRequestId, revisionId, analysisId, memberId],
  );
  return rows.map((row) => ({
    kind: "comment",
    id: row.id,
    path: row.path,
    line: row.line,
    startLine: row.start_line,
    body: row.body,
  }));
};

export type ReviewSubmissionStatus = "posting" | "posted" | "failed";

/** One attempt as stored: digests, counts, ids and times. Never content. */
export interface ReviewSubmissionRecord {
  readonly submissionId: string;
  readonly pullRequestId: string;
  readonly revisionId: string;
  readonly submittedBy: string;
  readonly idempotencyKey: string;
  readonly headSha: string;
  readonly verdict: ReviewVerdict;
  readonly contentSha256: Buffer;
  readonly bodySha256: Buffer;
  readonly draftCount: number;
  readonly commentCount: number;
  readonly status: ReviewSubmissionStatus;
  readonly forgeReviewId: number | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  /**
   * How old the attempt was when this row was read, by the database's clock (review round 1,
   * S3): the server's clock is never compared with `createdAt`.
   */
  readonly ageMs: number;
}

interface SubmissionRow {
  id: string;
  pull_request_id: string;
  revision_id: string;
  submitted_by: string;
  idempotency_key: string;
  head_sha: string;
  verdict: string;
  content_sha256: Buffer;
  body_sha256: Buffer;
  draft_count: number;
  comment_count: number;
  status: string;
  forge_review_id: string | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
  age_ms: number;
}

const SUBMISSION_COLUMNS = `id, pull_request_id, revision_id, submitted_by, idempotency_key, head_sha,
  verdict, content_sha256, body_sha256, draft_count, comment_count, status,
  forge_review_id::text as forge_review_id, error_code, created_at, finished_at,
  (extract(epoch from (clock_timestamp() - created_at)) * 1000)::float8 as age_ms`;

const record = (row: SubmissionRow): ReviewSubmissionRecord => {
  if (!isReviewVerdict(row.verdict))
    throw new ReviewStoreError("reviews: unknown verdict in a row");
  if (row.status !== "posting" && row.status !== "posted" && row.status !== "failed") {
    throw new ReviewStoreError("reviews: unknown status in a row");
  }
  return {
    submissionId: row.id,
    pullRequestId: row.pull_request_id,
    revisionId: row.revision_id,
    submittedBy: row.submitted_by,
    idempotencyKey: row.idempotency_key,
    headSha: row.head_sha,
    verdict: row.verdict,
    contentSha256: row.content_sha256,
    bodySha256: row.body_sha256,
    draftCount: row.draft_count,
    commentCount: row.comment_count,
    status: row.status,
    forgeReviewId: row.forge_review_id === null ? null : Number(row.forge_review_id),
    errorCode: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    ageMs: Math.max(0, Number(row.age_ms)),
  };
};

export const loadReviewSubmission = async (
  tx: TenantTx,
  submissionId: string,
): Promise<ReviewSubmissionRecord | null> => {
  const id = assertUuid(submissionId, "submission id");
  const { rows } = await tx.query<SubmissionRow>(
    `select ${SUBMISSION_COLUMNS} from review_submissions where org_id = $1 and id = $2`,
    [tx.orgId, id],
  );
  return rows[0] === undefined ? null : record(rows[0]);
};

/** Forge review ids this org already recorded for the pull request (reconciliation). */
export const recordedReviewIds = async (
  tx: TenantTx,
  pullRequestId: string,
): Promise<readonly number[]> => {
  const id = assertUuid(pullRequestId, "pull request id");
  const { rows } = await tx.query<{ forge_review_id: string }>(
    `select forge_review_id::text as forge_review_id from review_submissions
      where org_id = $1 and pull_request_id = $2 and forge_review_id is not null`,
    [tx.orgId, id],
  );
  return rows.map((r) => Number(r.forge_review_id));
};

export interface BeginReviewSubmissionInput {
  /** The actor, from the session. */
  readonly memberId: string;
  readonly pullRequestId: string;
  /** The client's key for this one click (a uuid). */
  readonly idempotencyKey: string;
  /** Hex sha256 of the plan the client showed. */
  readonly contentSha256: string;
  /** The head the client showed. */
  readonly headSha: string;
  readonly verdict: ReviewVerdict;
  /** The summary the person wrote. */
  readonly body: string;
}

export type BeginReviewSubmissionResult =
  /** Recorded as `posting`; the caller posts exactly `review` and then finishes the row. */
  | {
      readonly outcome: "started";
      readonly submission: ReviewSubmissionRecord;
      readonly plan: ReviewPlan;
      readonly review: ReviewSubmission;
    }
  /** The same key was used before: here is that attempt (any status). Nothing was written. */
  | { readonly outcome: "existing"; readonly submission: ReviewSubmissionRecord }
  /** Another attempt by this member on this pull request is still in flight. */
  | { readonly outcome: "in_progress"; readonly submission: ReviewSubmissionRecord }
  /** The same key with other content or another pull request. */
  | { readonly outcome: "key_reused" }
  | { readonly outcome: "not_found" }
  /** The mirror holds no revision for the head: nothing to post against. */
  | { readonly outcome: "no_revision" }
  /** The head moved since the plan was shown. */
  | { readonly outcome: "head_moved" }
  /** The list changed since it was shown (an item added, edited, dismissed or already posted). */
  | { readonly outcome: "stale" }
  /** The submission says nothing, or is malformed (fixed reason from packages/core). */
  | { readonly outcome: "invalid"; readonly reason: string }
  /** The actor is no longer an active member whose role may review. */
  | { readonly outcome: "not_permitted" };

/**
 * The per (pull request, member) lock `beginReviewSubmission` holds while it rebuilds and records
 * the plan. P6-4's draft writes take it too (review fix S2), so a change and a submission are
 * ordered: whichever comes second sees the other.
 */
export const lockReviewPlan = (tx: TenantTx, pullRequestId: string, memberId: string) =>
  tx.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
    `rocky.review:${tx.orgId}:${pullRequestId}:${memberId}`,
  ]);

const actorMayReview = async (tx: TenantTx, memberId: string): Promise<boolean> => {
  const { rows } = await tx.query<{ role: string }>(
    `select role from members where org_id = $1 and id = $2 and removed_at is null for share`,
    [tx.orgId, memberId],
  );
  return can(rows[0]?.role, "pull_requests.review");
};

const toComment = (item: ReviewPlanItem): ReviewComment => ({
  path: item.path,
  line: item.line,
  startLine: item.startLine,
  body: item.body,
});

export const beginReviewSubmission = async (
  tx: TenantTx,
  input: BeginReviewSubmissionInput,
): Promise<BeginReviewSubmissionResult> => {
  const memberId = assertUuid(input.memberId, "member id");
  const pullRequestId = assertUuid(input.pullRequestId, "pull request id");
  const idempotencyKey = assertUuid(input.idempotencyKey, "idempotency key");
  if (typeof input.contentSha256 !== "string" || !HEX_64.test(input.contentSha256)) {
    throw new ReviewStoreError("reviews: content digest must be 64 hex characters");
  }
  if (typeof input.headSha !== "string" || !HEAD_SHA.test(input.headSha)) {
    return { outcome: "invalid", reason: "invalid_head" };
  }
  if (!isReviewVerdict(input.verdict)) return { outcome: "invalid", reason: "invalid_verdict" };
  if (typeof input.body !== "string") return { outcome: "invalid", reason: "invalid_body" };
  const expected = Buffer.from(input.contentSha256, "hex");

  await lockReviewPlan(tx, pullRequestId, memberId);
  if (!(await actorMayReview(tx, memberId))) return { outcome: "not_permitted" };

  const { rows: earlier } = await tx.query<SubmissionRow>(
    `select ${SUBMISSION_COLUMNS} from review_submissions
      where org_id = $1 and idempotency_key = $2`,
    [tx.orgId, idempotencyKey],
  );
  if (earlier[0] !== undefined) {
    const found = record(earlier[0]);
    const same =
      found.pullRequestId === pullRequestId &&
      found.submittedBy === memberId &&
      found.contentSha256.equals(expected) &&
      found.verdict === input.verdict &&
      found.bodySha256.equals(sha256(input.body));
    return same ? { outcome: "existing", submission: found } : { outcome: "key_reused" };
  }

  const plan = await loadReviewPlan(tx, { pullRequestId, memberId });
  if (plan === null) return { outcome: "not_found" };
  if (plan.revisionId === null) return { outcome: "no_revision" };
  if (plan.headSha !== input.headSha) return { outcome: "head_moved" };
  if (!plan.contentSha256.equals(expected)) return { outcome: "stale" };

  const review: ReviewSubmission = {
    headSha: plan.headSha,
    verdict: input.verdict,
    body: input.body,
    comments: plan.items.map(toComment),
  };
  const valid = validateReviewSubmission(review);
  if (!valid.ok) return { outcome: "invalid", reason: valid.reason };

  const { rows: inFlight } = await tx.query<SubmissionRow>(
    `select ${SUBMISSION_COLUMNS} from review_submissions
      where org_id = $1 and pull_request_id = $2 and submitted_by = $3 and status = 'posting'`,
    [tx.orgId, pullRequestId, memberId],
  );
  if (inFlight[0] !== undefined) return { outcome: "in_progress", submission: record(inFlight[0]) };

  const drafts = plan.items.filter((i) => i.kind === "draft").length;
  const { rows: inserted } = await tx.query<SubmissionRow>(
    `insert into review_submissions
       (pull_request_id, revision_id, submitted_by, idempotency_key, head_sha, verdict,
        content_sha256, body_sha256, draft_count, comment_count)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${SUBMISSION_COLUMNS}`,
    [
      pullRequestId,
      plan.revisionId,
      memberId,
      idempotencyKey,
      plan.headSha,
      input.verdict,
      plan.contentSha256,
      sha256(input.body),
      drafts,
      plan.items.length - drafts,
    ],
  );
  const row = inserted[0];
  if (row === undefined) throw new ReviewStoreError("reviews: insert returned no row");
  for (const [seq, item] of plan.items.entries()) {
    await tx.query(
      `insert into review_submission_items (submission_id, seq, kind, item_id, body_sha256)
       values ($1, $2, $3, $4, $5)`,
      [row.id, seq, item.kind, item.id, sha256(item.body)],
    );
  }
  const submission = record(row);
  await audit(
    tx,
    { type: "user", id: memberId },
    "review.submission_started",
    { type: "pull_request", id: pullRequestId },
    {
      submissionId: submission.submissionId,
      verdict: submission.verdict,
      draftCount: submission.draftCount,
      commentCount: submission.commentCount,
      contentSha256: submission.contentSha256.toString("hex"),
    },
  );
  return { outcome: "started", submission, plan, review };
};

export type FinishReviewSubmissionInput =
  | { readonly posted: true; readonly forgeReviewId: number }
  | { readonly posted: false; readonly errorCode: string };

/**
 * Records the forge's answer. A `posted` answer applies to an attempt that is `posting` **or**
 * `failed` (review round 1, S3: the forge is authoritative; a late answer after a reconciliation
 * called it lost marks the items carried again, so they are not offered twice). A `failed`
 * answer applies to a `posting` attempt only. `null` when the row is not in an applicable state
 * (already posted): nothing changes, and the caller must say so in its log. `actor` is who
 * finished it: the member, or `system` for a reconciliation.
 */
export const finishReviewSubmission = async (
  tx: TenantTx,
  submissionId: string,
  result: FinishReviewSubmissionInput,
  actor: { readonly type: "user" | "system"; readonly id: string },
): Promise<ReviewSubmissionRecord | null> => {
  const id = assertUuid(submissionId, "submission id");
  if (result.posted) {
    const reviewId = result.forgeReviewId;
    if (typeof reviewId !== "number" || !Number.isSafeInteger(reviewId) || reviewId < 1) {
      throw new ReviewStoreError("reviews: forge review id must be a positive integer");
    }
  } else if (typeof result.errorCode !== "string" || !ERROR_CODE.test(result.errorCode)) {
    throw new ReviewStoreError("reviews: error code must be a short snake_case code");
  }
  const { rows } = await tx.query<SubmissionRow>(
    result.posted
      ? `update review_submissions
            set status = 'posted', forge_review_id = $3, error_code = null, finished_at = now()
          where org_id = $1 and id = $2 and status in ('posting', 'failed')
          returning ${SUBMISSION_COLUMNS}`
      : `update review_submissions
            set status = 'failed', error_code = $3, finished_at = now()
          where org_id = $1 and id = $2 and status = 'posting'
          returning ${SUBMISSION_COLUMNS}`,
    [tx.orgId, id, result.posted ? result.forgeReviewId : result.errorCode],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const submission = record(row);
  await audit(
    tx,
    actor,
    result.posted ? "review.posted" : "review.post_failed",
    { type: "pull_request", id: submission.pullRequestId },
    {
      submissionId: submission.submissionId,
      submittedBy: submission.submittedBy,
      verdict: submission.verdict,
      draftCount: submission.draftCount,
      commentCount: submission.commentCount,
      ...(result.posted
        ? { forgeReviewId: result.forgeReviewId }
        : { errorCode: result.errorCode }),
    },
  );
  return submission;
};
