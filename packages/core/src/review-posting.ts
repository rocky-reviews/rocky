import type { Finding } from "@rocky-reviews/schema";
import type { ForgeKind, ForgeNumericId, ForgeUserCredential } from "./forge.js";

/**
 * Posting a review as the user (P3-5, ADR 0026): the forge-neutral port and the pure parts.
 *
 * Only a human posts. The server builds the exact list the person saw (accepted drafts, their
 * own pending comments), the person adds a verdict and a summary, and everything goes to the
 * forge as **one** review with the person's own credential. Nothing here does I/O; the adapter
 * (`packages/forge-github`) implements `ReviewPoster`, and the server is the only caller.
 *
 * The plan is the contract between "what was shown" and "what is posted": `canonicalReviewPlan`
 * turns the list into one canonical string whose hash the client echoes back, so a list that
 * changed in between (a draft dismissed, a comment edited, the head moved) is refused instead
 * of posted. Everything in a plan is untrusted PR-shaped content: it is validated and bounded
 * here, and JSON-encoded (never concatenated) wherever it is serialised.
 */

export const REVIEW_VERDICTS = ["approve", "request_changes", "comment"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const isReviewVerdict = (value: unknown): value is ReviewVerdict =>
  typeof value === "string" && (REVIEW_VERDICTS as readonly string[]).includes(value);

/** GitHub's limit for a review or comment body. */
export const MAX_REVIEW_BODY_CHARS = 65_536;
/** More than this in one review is a mistake, not a review. */
export const MAX_REVIEW_COMMENTS = 100;
/** Mirrors `MAX_LINE_NUMBER` in packages/schema. */
export const MAX_REVIEW_LINE = 10_000_000;

const HEAD_SHA = /^[0-9a-f]{40}$/;
/** A repository-relative POSIX path: no leading slash, no `.`/`..` segments, no empty segment. */
const PATH_SEGMENT = /^(?!\.\.?$)[^/\0]+$/;

export type ReviewPlanItemKind = "draft" | "comment";

/** One thing the person saw in the list to post: a comment on a line (or range) of a file. */
export interface ReviewPlanItem {
  readonly kind: ReviewPlanItemKind;
  /** The Rocky id of the draft state or pending comment (a uuid). */
  readonly id: string;
  readonly path: string;
  /** New-side line (the last line of a range). */
  readonly line: number;
  /** First line of a multi-line range, or `null` for a single line. */
  readonly startLine: number | null;
  /** The comment exactly as it will be posted. */
  readonly body: string;
}

/** An inline comment of the review, on the new side of the diff. */
export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly startLine: number | null;
  readonly body: string;
}

export interface ReviewSubmission {
  /** The commit the review is for (the mirrored head). */
  readonly headSha: string;
  readonly verdict: ReviewVerdict;
  /** The summary; may be empty for an approval. */
  readonly body: string;
  readonly comments: readonly ReviewComment[];
}

export interface PullRequestLocator {
  /** `owner/name` as mirrored (addresses the request only). */
  readonly fullName: string;
  readonly number: number;
}

/** A review the forge holds, as the poster reports it. */
export interface PostedReview {
  readonly id: ForgeNumericId;
  /** The verdict the forge shows for it; `null` for a pending, dismissed or unknown state. */
  readonly state: ReviewVerdict | null;
  /** The commit the review was made on; `null` when the forge reports none. */
  readonly headSha: string | null;
  /** The summary body as the forge holds it (PR content: never logged). */
  readonly body: string;
  readonly submittedAt: Date | null;
}

/** Why the forge did not take the review. Fixed codes: safe to log. */
export type ReviewPostDenial =
  /** The credential is not accepted (expired, revoked, malformed). */
  | "token_rejected"
  /** The forge refuses the request (SSO enforcement, no write access, rate limit). */
  | "forbidden"
  /** The forge says there is no such pull request for this user. */
  | "not_found"
  /** The forge validated the review and refused it (own approval, a line not in the diff). */
  | "rejected";

export type ReviewPostOutcome =
  | { readonly posted: true; readonly review: PostedReview }
  | { readonly posted: false; readonly reason: ReviewPostDenial };

/**
 * Posts one review as the user (P3-5). The credential goes into the request's authorization
 * header and nowhere else. Documented denials come back as outcomes; anything else (timeout,
 * network, unexpected status, malformed answer) throws `ForgeReadError`, and the caller must
 * treat that as "unknown" (the review may or may not exist), never as "not posted".
 */
export interface ReviewPoster {
  readonly kind: ForgeKind;
  postReview(
    credential: ForgeUserCredential,
    pullRequest: PullRequestLocator,
    review: ReviewSubmission,
  ): Promise<ReviewPostOutcome>;
  /**
   * The user's own reviews on the pull request, newest first (reconciliation after a lost
   * answer). Throws `ForgeReadError` on any failure, and when the pull request has more reviews
   * than the adapter reads (the newest could be unseen: never answer "not there" on a partial
   * list); a denial is an empty list only when the forge positively says there is no such pull
   * request.
   */
  listOwnReviews(
    credential: ForgeUserCredential,
    pullRequest: PullRequestLocator,
  ): Promise<readonly PostedReview[]>;
  /**
   * How many inline comments one review of the pull request carries (reconciliation confirms
   * the attempt's count). Throws `ForgeReadError` on any failure, including a review that the
   * forge says does not exist.
   */
  countReviewComments(
    credential: ForgeUserCredential,
    pullRequest: PullRequestLocator,
    reviewId: ForgeNumericId,
  ): Promise<number>;
}

/**
 * The canonical form of a plan: the head commit and every item with every field, in order, as
 * JSON. Hash this (sha256) to get the content digest the client echoes back. JSON, never
 * joined strings, so a body cannot imitate a separator.
 */
export const canonicalReviewPlan = (headSha: string, items: readonly ReviewPlanItem[]): string =>
  JSON.stringify({
    v: 1,
    headSha,
    items: items.map((i) => [i.kind, i.id, i.path, i.line, i.startLine, i.body]),
  });

/** The longest run of backticks in `lines`, so a fence can be chosen that none of them closes. */
const longestBacktickRun = (lines: readonly string[]): number =>
  Math.max(0, ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length))));

/**
 * How an accepted draft reads once posted: its title, its body, and its suggestion as a
 * suggestion block the forge can apply. Nothing the person did not see: no severity, no
 * confidence, no agent prompt. The fence is longer than any backtick run inside the suggestion
 * so the block cannot be closed early by its content.
 */
export const findingCommentBody = (finding: Finding): string => {
  const parts = [`**${finding.title}**`, finding.body];
  if (finding.suggestion !== undefined) {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(finding.suggestion.lines) + 1));
    const lines = finding.suggestion.lines.map((l) => `${l}\n`).join("");
    parts.push(`${fence}suggestion\n${lines}${fence}`);
  }
  return parts.join("\n\n");
};

export type ReviewSubmissionProblem =
  | "invalid_submission"
  | "invalid_head"
  | "invalid_verdict"
  | "invalid_body"
  | "body_too_long"
  | "invalid_comments"
  | "too_many_comments"
  | "empty_comment"
  | "comment_too_long"
  | "invalid_path"
  | "invalid_line"
  | "empty_review";

export type ReviewSubmissionValidation =
  { readonly ok: true } | { readonly ok: false; readonly reason: ReviewSubmissionProblem };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isReviewPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  !value.includes("\\") &&
  value.split("/").every((segment) => PATH_SEGMENT.test(segment));

const isLine = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_REVIEW_LINE;

const isBlank = (value: string): boolean => value.trim().length === 0;

const problem = (reason: ReviewSubmissionProblem): ReviewSubmissionValidation => ({
  ok: false,
  reason,
});

/**
 * Whether a submission is one the forge can take and one that says something. Never throws;
 * the caller refuses with the fixed reason. Shape and bounds only: whether a line is in the diff
 * is the forge's call (it answers `rejected`).
 */
export const validateReviewSubmission = (value: unknown): ReviewSubmissionValidation => {
  if (!isRecord(value)) return problem("invalid_submission");
  const { headSha, verdict, body, comments } = value;
  if (typeof headSha !== "string" || !HEAD_SHA.test(headSha)) return problem("invalid_head");
  if (!isReviewVerdict(verdict)) return problem("invalid_verdict");
  if (typeof body !== "string") return problem("invalid_body");
  if (body.length > MAX_REVIEW_BODY_CHARS) return problem("body_too_long");
  if (!Array.isArray(comments)) return problem("invalid_comments");
  if (comments.length > MAX_REVIEW_COMMENTS) return problem("too_many_comments");
  for (const comment of comments as unknown[]) {
    if (!isRecord(comment)) return problem("invalid_comments");
    if (typeof comment["body"] !== "string") return problem("invalid_comments");
    if (isBlank(comment["body"])) return problem("empty_comment");
    if (comment["body"].length > MAX_REVIEW_BODY_CHARS) return problem("comment_too_long");
    if (!isReviewPath(comment["path"])) return problem("invalid_path");
    if (!isLine(comment["line"])) return problem("invalid_line");
    const start = comment["startLine"];
    if (start !== null && start !== undefined) {
      if (!isLine(start) || start >= comment["line"]) return problem("invalid_line");
    }
  }
  if (verdict !== "approve" && isBlank(body) && comments.length === 0) {
    return problem("empty_review");
  }
  return { ok: true };
};
