import {
  applyDraftAction,
  composePostedComment,
  DRAFT,
  isDismissReason,
  MAX_COMMENT_BODY,
  normaliseCommentBody,
  type DismissReason,
  type DraftAction,
  type DraftDecision,
  type DraftState,
} from "@rocky-reviews/core";
import { parseAnalysisDocument, type AnalysisDocument } from "@rocky-reviews/schema";
import type { TenantTx } from "./client.js";
import { carriedDraftContent, isCarried, lockReviewPlan, postedDraftContent } from "./reviews.js";

/**
 * Draft decisions and pending comments (P6-4, migration 0015, ADR 0027). Every function runs in
 * the caller's `withOrg` transaction (RLS keeps it to that org) and acts for one reviewer, whose
 * member id comes from the server's session, never from the request.
 *
 * A draft's location and body come from the stored, validated analysis document, never from the
 * client: the client names a finding id, and the server looks it up. An accepted draft is written
 * as the reviewer's pending comment (`comments_pending`) in the same transaction as its decision,
 * and its undo deletes it, so `comments_pending` has one row per comment Finish review would
 * post; a draft's posted text is `composePostedComment(finding, row)` (core), as the card shows.
 *
 * Results are fixed codes; errors carry no values (bodies are the reviewer's text and findings
 * are PR-derived: neither belongs in an error or a log).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DraftStoreError extends Error {
  override readonly name = "DraftStoreError";
}

const uuid = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new DraftStoreError(`drafts: ${what} must be a uuid`);
  }
  return value.toLowerCase();
};

/** One reviewer's decision about one draft, as the page shows it after a reload. */
export interface DraftView {
  readonly findingId: string;
  readonly state: DraftState;
  readonly reason: DismissReason | null;
  /** The accepted comment was rewritten by the reviewer. */
  readonly edited: boolean;
  /** The pending comment's body, when accepted. */
  readonly body: string | null;
  readonly agentPromptCopiedAt: Date | null;
  readonly updatedAt: Date;
}

/** A comment the reviewer wrote on a line (not from a draft). */
export interface OwnCommentView {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly body: string;
  readonly createdAt: Date;
}

export interface ReviewDraftsView {
  /** Drafts that are decided or were sent to an agent; every other finding is a plain draft. */
  readonly drafts: readonly DraftView[];
  readonly comments: readonly OwnCommentView[];
}

interface ReviewTarget {
  readonly analysisId: string;
  readonly revisionId: string;
  readonly pullRequestId: string;
  readonly document: AnalysisDocument;
}

/** The analysis, when it is this org's and done; its document is validated again on the way out. */
const loadTarget = async (tx: TenantTx, analysisId: string): Promise<ReviewTarget | null> => {
  const { rows } = await tx.query<{
    revision_id: string;
    pull_request_id: string;
    document: unknown;
  }>(
    `select a.revision_id, v.pull_request_id, a.document
       from analyses a
       join pr_revisions v on v.org_id = a.org_id and v.id = a.revision_id
      where a.org_id = $1 and a.id = $2 and a.status = 'done'`,
    [tx.orgId, analysisId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const parsed = parseAnalysisDocument(row.document);
  if (!parsed.ok) return null;
  return {
    analysisId,
    revisionId: row.revision_id,
    pullRequestId: row.pull_request_id,
    document: parsed.value,
  };
};

interface DraftRow {
  finding_id: string;
  state: string;
  reason: string | null;
  agent_prompt_copied_at: Date | null;
  updated_at: Date;
  source: string | null;
  body: string | null;
}

const DRAFT_COLUMNS = `f.finding_id, f.state, f.reason, f.agent_prompt_copied_at, f.updated_at,
       c.source, c.body`;
const DRAFT_JOIN = `findings_state f
  left join comments_pending c
    on c.org_id = f.org_id and c.analysis_id = f.analysis_id
   and c.author_id = f.member_id and c.finding_id = f.finding_id`;

const decisionOf = (row: DraftRow, findingBody: string): DraftDecision => {
  if (row.state === "accepted")
    return { state: "accepted", edited: row.source === "ai_edited", body: row.body ?? findingBody };
  if (row.state === "dismissed" && isDismissReason(row.reason))
    return { state: "dismissed", reason: row.reason };
  return DRAFT;
};

const viewOf = (row: DraftRow): DraftView => {
  if (row.state !== "draft" && row.state !== "accepted" && row.state !== "dismissed") {
    throw new DraftStoreError("drafts: unknown state in a row");
  }
  const accepted = row.state === "accepted";
  return {
    findingId: row.finding_id,
    state: row.state,
    reason: row.state === "dismissed" && isDismissReason(row.reason) ? row.reason : null,
    edited: accepted && row.source === "ai_edited",
    body: accepted ? row.body : null,
    agentPromptCopiedAt: row.agent_prompt_copied_at,
    updatedAt: row.updated_at,
  };
};

/**
 * The reviewer's drafts and own comments for one analysis; `null` when the analysis is not this
 * org's or not done.
 */
export const listReviewDrafts = async (
  tx: TenantTx,
  input: { readonly analysisId: string; readonly memberId: string },
): Promise<ReviewDraftsView | null> => {
  const analysisId = uuid(input.analysisId, "analysis id");
  const memberId = uuid(input.memberId, "member id");
  const exists = await tx.query(
    "select 1 from analyses where org_id = $1 and id = $2 and status = 'done'",
    [tx.orgId, analysisId],
  );
  if (exists.rowCount === 0) return null;
  const drafts = await tx.query<DraftRow>(
    `select ${DRAFT_COLUMNS}
       from ${DRAFT_JOIN}
      where f.org_id = $1 and f.analysis_id = $2 and f.member_id = $3
        and (f.state <> 'draft' or f.agent_prompt_copied_at is not null)
      order by f.finding_id`,
    [tx.orgId, analysisId, memberId],
  );
  const comments = await tx.query<{
    id: string;
    path: string;
    line: number;
    body: string;
    created_at: Date;
  }>(
    `select id, path, line, body, created_at
       from comments_pending
      where org_id = $1 and analysis_id = $2 and author_id = $3 and source = 'own'
      order by created_at, id`,
    [tx.orgId, analysisId, memberId],
  );
  return {
    drafts: drafts.rows.map(viewOf),
    comments: comments.rows.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line,
      body: c.body,
      createdAt: c.created_at,
    })),
  };
};

export type DecideDraftResult =
  | { readonly outcome: "ok"; readonly draft: DraftView }
  | { readonly outcome: "invalid_transition"; readonly draft: DraftView }
  /**
   * The draft was carried by a review being posted or already posted as the member (P3-5): it
   * cannot change any more (ADR 0026 S2). Carries the current state, like a conflict.
   */
  | { readonly outcome: "already_posted"; readonly draft: DraftView }
  /** Accepting would post a comment longer than GitHub's per-comment limit (title + body + suggestion). */
  | { readonly outcome: "comment_too_long" }
  | { readonly outcome: "invalid_body" }
  | { readonly outcome: "unknown_finding" }
  | { readonly outcome: "not_found" };

/**
 * Applies one reviewer action to one draft (core `applyDraftAction`), with the decision row
 * locked, so two tabs (or two requests) acting at once resolve one after the other and the loser
 * gets `invalid_transition` with the current state.
 */
export const decideDraft = async (
  tx: TenantTx,
  input: {
    readonly analysisId: string;
    readonly memberId: string;
    readonly findingId: string;
    readonly action: DraftAction;
  },
): Promise<DecideDraftResult> => {
  const analysisId = uuid(input.analysisId, "analysis id");
  const memberId = uuid(input.memberId, "member id");
  const target = await loadTarget(tx, analysisId);
  if (target === null) return { outcome: "not_found" };
  // Looked up by exact id among the document's findings: the client cannot invent a draft.
  const finding = target.document.findings.find((f) => f.id === input.findingId);
  if (finding === undefined) return { outcome: "unknown_finding" };

  // The posting lock first (ADR 0026 S2): a submission starting now either carries the state
  // this action leaves, or sees it changed and answers `stale`.
  await lockReviewPlan(tx, target.pullRequestId, memberId);
  await tx.query(
    `insert into findings_state (analysis_id, member_id, finding_id)
     values ($1, $2, $3)
     on conflict (org_id, analysis_id, member_id, finding_id) do nothing`,
    [analysisId, memberId, finding.id],
  );
  // Lock first, then read in a new statement: a statement that waited for the lock re-reads
  // the locked row at its newest version but the joined pending comment from its own (older)
  // snapshot, so the loser of a race would be told "accepted" without the winner's body.
  const locked = await tx.query<{ id: string }>(
    `select id from findings_state
      where org_id = $1 and analysis_id = $2 and member_id = $3 and finding_id = $4
        for update`,
    [tx.orgId, analysisId, memberId, finding.id],
  );
  const findingStateId = locked.rows[0]?.id;
  if (findingStateId === undefined) throw new DraftStoreError("drafts: decision row missing");
  const { rows } = await tx.query<DraftRow>(
    `select ${DRAFT_COLUMNS}
       from ${DRAFT_JOIN}
      where f.org_id = $1 and f.analysis_id = $2 and f.member_id = $3 and f.finding_id = $4`,
    [tx.orgId, analysisId, memberId, finding.id],
  );
  const row = rows[0];
  if (row === undefined) throw new DraftStoreError("drafts: decision row missing");
  // This very decision was posted (or is being posted): it cannot change (S2). Copying the
  // agent prompt changes nothing that was posted, so it is never refused here (#39 SF2).
  if (input.action.kind !== "send_to_agent" && (await isCarried(tx, "draft", findingStateId))) {
    return { outcome: "already_posted", draft: viewOf(row) };
  }

  const transition = applyDraftAction(decisionOf(row, finding.body), input.action, finding);
  if (!transition.ok) {
    return transition.error === "invalid_body"
      ? { outcome: "invalid_body" }
      : { outcome: "invalid_transition", draft: viewOf(row) };
  }
  const next = transition.next;
  // What the accepted card shows is what is posted (composePostedComment): it must fit one
  // review comment, or the post would be refused after the reviewer accepted it.
  if (
    next.state === "accepted" &&
    composePostedComment(finding, { body: next.body }).length > MAX_COMMENT_BODY
  ) {
    return { outcome: "comment_too_long" };
  }
  // Accepting what this member already posted on this revision, from another analysis (a re-run
  // renumbers findings), would post it twice: refused by content, not by id (S1, #39 SF1).
  if (next.state === "accepted") {
    const carried = await carriedDraftContent(tx, memberId, target.revisionId);
    if (carried(postedDraftContent(finding, next.body))) {
      return { outcome: "already_posted", draft: viewOf(row) };
    }
  }
  const key = [tx.orgId, analysisId, memberId, finding.id];

  if (transition.agentPromptCopied) {
    await tx.query(
      `update findings_state set agent_prompt_copied_at = now(), updated_at = now()
        where org_id = $1 and analysis_id = $2 and member_id = $3 and finding_id = $4`,
      key,
    );
  } else {
    await tx.query(
      `update findings_state
          set state = $5, reason = $6, updated_at = now(),
              decided_by = case when $5 = 'draft' then null else member_id end,
              decided_at = case when $5 = 'draft' then null else now() end
        where org_id = $1 and analysis_id = $2 and member_id = $3 and finding_id = $4`,
      [...key, next.state, next.state === "dismissed" ? next.reason : null],
    );
    await tx.query(
      `delete from comments_pending
        where org_id = $1 and analysis_id = $2 and author_id = $3 and finding_id = $4`,
      key,
    );
    if (next.state === "accepted") {
      const { start, end } = finding.range;
      await tx.query(
        `insert into comments_pending
           (pull_request_id, revision_id, author_id, analysis_id, finding_id, source,
            path, start_line, line, body)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          target.pullRequestId,
          target.revisionId,
          memberId,
          analysisId,
          finding.id,
          next.edited ? "ai_edited" : "ai",
          finding.path,
          start < end ? start : null,
          end,
          next.body,
        ],
      );
    }
  }

  const after = await tx.query<DraftRow>(
    `select ${DRAFT_COLUMNS}
       from ${DRAFT_JOIN}
      where f.org_id = $1 and f.analysis_id = $2 and f.member_id = $3 and f.finding_id = $4`,
    key,
  );
  const saved = after.rows[0];
  if (saved === undefined) throw new DraftStoreError("drafts: decision row missing");
  return { outcome: "ok", draft: viewOf(saved) };
};

/** Whether `line` is a new-side line of one of the file's hunks in the analysed diff. */
const onNewSide = (document: AnalysisDocument, path: string, line: number): boolean => {
  if (!Number.isSafeInteger(line) || line < 1) return false;
  const file = document.provenance.files.find((f) => f.path === path);
  return (
    file !== undefined &&
    file.hunks.some((h) => line >= h.newStart && line < h.newStart + h.newLines)
  );
};

export type AddCommentResult =
  | { readonly outcome: "created"; readonly comment: OwnCommentView }
  | { readonly outcome: "invalid_location" }
  | { readonly outcome: "invalid_body" }
  | { readonly outcome: "not_found" };

/** Stores the reviewer's own comment on a new-side line of the analysed diff. */
export const addOwnComment = async (
  tx: TenantTx,
  input: {
    readonly analysisId: string;
    readonly memberId: string;
    readonly path: unknown;
    readonly line: unknown;
    readonly body: unknown;
  },
): Promise<AddCommentResult> => {
  const analysisId = uuid(input.analysisId, "analysis id");
  const memberId = uuid(input.memberId, "member id");
  const target = await loadTarget(tx, analysisId);
  if (target === null) return { outcome: "not_found" };
  const { path, line } = input;
  if (
    typeof path !== "string" ||
    typeof line !== "number" ||
    !onNewSide(target.document, path, line)
  )
    return { outcome: "invalid_location" };
  const body = normaliseCommentBody(input.body);
  if (body === null) return { outcome: "invalid_body" };
  const { rows } = await tx.query<{ id: string; created_at: Date }>(
    `insert into comments_pending
       (pull_request_id, revision_id, author_id, analysis_id, source, path, line, body)
     values ($1, $2, $3, $4, 'own', $5, $6, $7)
     returning id, created_at`,
    [target.pullRequestId, target.revisionId, memberId, analysisId, path, line, body],
  );
  const row = rows[0];
  if (row === undefined) throw new DraftStoreError("drafts: comment not stored");
  return {
    outcome: "created",
    comment: { id: row.id, path, line, body, createdAt: row.created_at },
  };
};

/** Deletes one of the reviewer's own comments (never an accepted draft: its undo does that). */
export const deleteOwnComment = async (
  tx: TenantTx,
  input: { readonly analysisId: string; readonly memberId: string; readonly commentId: string },
): Promise<"deleted" | "not_found" | "already_posted"> => {
  const analysisId = uuid(input.analysisId, "analysis id");
  const memberId = uuid(input.memberId, "member id");
  const commentId = uuid(input.commentId, "comment id");
  const { rows } = await tx.query<{ pull_request_id: string }>(
    `select pull_request_id from comments_pending
      where org_id = $1 and analysis_id = $2 and author_id = $3 and id = $4 and source = 'own'`,
    [tx.orgId, analysisId, memberId, commentId],
  );
  const pullRequestId = rows[0]?.pull_request_id;
  if (pullRequestId === undefined) return "not_found";
  // Ordered with a submission (ADR 0026 S2): a comment being posted or posted stays.
  await lockReviewPlan(tx, pullRequestId, memberId);
  if (await isCarried(tx, "comment", commentId)) return "already_posted";
  const result = await tx.query(
    `delete from comments_pending
      where org_id = $1 and analysis_id = $2 and author_id = $3 and id = $4 and source = 'own'`,
    [tx.orgId, analysisId, memberId, commentId],
  );
  return result.rowCount === 1 ? "deleted" : "not_found";
};
