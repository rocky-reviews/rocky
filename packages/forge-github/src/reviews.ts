import {
  ForgeReadError,
  validateReviewSubmission,
  type ForgeUserCredential,
  type PostedReview,
  type PullRequestLocator,
  type ReviewPostDenial,
  type ReviewPostOutcome,
  type ReviewPoster,
  type ReviewSubmission,
  type ReviewVerdict,
} from "@rocky-reviews/core";
import { z } from "zod";
import { isAbort, readCapped } from "./http.js";
import { isRepositoryFullName } from "./repositories.js";

/**
 * Posting a review as the user (P3-5, ADR 0026): `POST /repos/{owner}/{repo}/pulls/{number}/reviews`
 * with the user's token, as one review (`event` set, so it is submitted, never left pending):
 *
 *   { commit_id, event: APPROVE | REQUEST_CHANGES | COMMENT, body, comments: [{ path, line,
 *     side: "RIGHT", start_line?, start_side?, body }] }
 *
 * Every comment is on the new side of the diff (the schema's line references are new-side).
 * The body is JSON-encoded, never built from strings, so PR content cannot change the request.
 *
 * Refusals GitHub documents are outcomes: 401 `token_rejected`, 403 `forbidden`, 404
 * `not_found` (no such pull request for this user), 422 `rejected` (an approval of one's own
 * pull request, a line outside the diff, an empty review). Any other status, a timeout, a
 * network failure, a redirect (refused, not followed) or a malformed answer throws
 * `ForgeReadError`: the review may or may not exist, and the caller must not post again without
 * asking (`listOwnReviews`). The token goes into the `authorization` header of these requests
 * and nowhere else; a token that is not a plausible bearer value is refused without a request.
 */

/** Under the server's 30 s request timeout, so a slow forge answers the client, not Node. */
export const REVIEW_POST_TIMEOUT_MS = 20_000;
export const MAX_REVIEW_RESPONSE_BYTES = 1024 * 1024;
/**
 * Pages of 100 read when reconciling. GitHub lists oldest first, so a pull request with more
 * reviews than this could hide the newest, the one looked for: the listing then throws instead
 * of answering a partial list (review round 1, S2).
 */
export const MAX_REVIEW_LIST_PAGES = 10;
const PAGE_SIZE = 100;

const EVENT: Readonly<Record<ReviewVerdict, string>> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const ReviewJson = z.object({
  id: ForgeId,
  user: z.object({ id: ForgeId }).nullable(),
  body: z.string().nullable(),
  state: z.string().max(32).nullable().optional(),
  commit_id: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});
const ReviewListJson = z.array(ReviewJson);
const CommentListJson = z.array(z.object({ id: ForgeId }));
const STATE: Readonly<Record<string, ReviewVerdict>> = {
  APPROVED: "approve",
  CHANGES_REQUESTED: "request_changes",
  COMMENTED: "comment",
};
const TOKEN = /^[\x21-\x7e]{16,512}$/;
const JSON_TYPE = /^application\/(?:vnd\.github\+)?json\b/i;
const HEAD_SHA = /^[0-9a-f]{40}$/;

const DENIAL_BY_STATUS: Readonly<Record<number, ReviewPostDenial>> = {
  401: "token_rejected",
  403: "forbidden",
  404: "not_found",
  422: "rejected",
};

export interface GitHubReviewPosterOptions {
  /** API base from `githubEndpoints` (https, ends with `/`). */
  readonly api: URL;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const decodeJson = (contentType: string, bytes: Buffer | undefined): unknown => {
  if (!JSON_TYPE.test(contentType) || bytes === undefined) {
    throw new ForgeReadError("invalid_response");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ForgeReadError("invalid_response");
  }
};

const toPosted = (value: z.infer<typeof ReviewJson>): PostedReview => {
  const at =
    value.submitted_at === null || value.submitted_at === undefined
      ? Number.NaN
      : Date.parse(value.submitted_at);
  return {
    id: value.id,
    state: typeof value.state === "string" ? (STATE[value.state] ?? null) : null,
    headSha:
      typeof value.commit_id === "string" && HEAD_SHA.test(value.commit_id)
        ? value.commit_id
        : null,
    body: value.body ?? "",
    submittedAt: Number.isFinite(at) ? new Date(at) : null,
  };
};

const segment = (value: string): string => encodeURIComponent(value);

const isPullRequestLocator = (value: PullRequestLocator): boolean =>
  isRepositoryFullName(value.fullName) &&
  typeof value.number === "number" &&
  Number.isSafeInteger(value.number) &&
  value.number >= 1;

export const createGitHubReviewPoster = (options: GitHubReviewPosterOptions): ReviewPoster => {
  if (options.api.protocol !== "https:") throw new Error("GitHub API base must be https");
  if (!options.api.pathname.endsWith("/")) throw new Error("GitHub API base must end with /");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REVIEW_POST_TIMEOUT_MS;

  /**
   * One request as the user. 200 answers come back decoded; the documented refusal statuses
   * come back with no body; anything else throws.
   */
  const send = async (
    method: "GET" | "POST",
    path: string,
    token: string,
    body?: unknown,
  ): Promise<Answer> => {
    const url = new URL(path, options.api);
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url.href, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "rocky-reviews",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
    const status = response.status;
    if (status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      if (DENIAL_BY_STATUS[status] !== undefined) return { status, body: undefined };
      throw new ForgeReadError("http_status", status);
    }
    let bytes: Buffer | undefined;
    try {
      bytes = await readCapped(response, MAX_REVIEW_RESPONSE_BYTES);
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
    return { status, body: decodeJson(response.headers.get("content-type") ?? "", bytes) };
  };

  const checkInputs = (credential: ForgeUserCredential, pullRequest: PullRequestLocator) => {
    if (!isPullRequestLocator(pullRequest)) throw new Error("reviews: invalid pull request");
    const { userId } = credential;
    if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId < 1) {
      throw new Error("reviews: invalid user");
    }
  };

  const reviewsPath = (pullRequest: PullRequestLocator): string =>
    `repos/${pullRequest.fullName.split("/").map(segment).join("/")}/pulls/${pullRequest.number}/reviews`;

  const postReview = async (
    credential: ForgeUserCredential,
    pullRequest: PullRequestLocator,
    review: ReviewSubmission,
  ): Promise<ReviewPostOutcome> => {
    checkInputs(credential, pullRequest);
    const valid = validateReviewSubmission(review);
    if (!valid.ok) throw new Error(`reviews: invalid review (${valid.reason})`);
    if (typeof credential.token !== "string" || !TOKEN.test(credential.token)) {
      return { posted: false, reason: "token_rejected" };
    }
    const payload = {
      commit_id: review.headSha,
      event: EVENT[review.verdict],
      body: review.body,
      comments: review.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: "RIGHT",
        ...(c.startLine === null ? {} : { start_line: c.startLine, start_side: "RIGHT" }),
        body: c.body,
      })),
    };
    const answer = await send("POST", reviewsPath(pullRequest), credential.token, payload);
    const denial = DENIAL_BY_STATUS[answer.status];
    if (denial !== undefined) return { posted: false, reason: denial };
    const parsed = ReviewJson.safeParse(answer.body);
    if (!parsed.success) throw new ForgeReadError("invalid_response");
    return { posted: true, review: toPosted(parsed.data) };
  };

  const listOwnReviews = async (
    credential: ForgeUserCredential,
    pullRequest: PullRequestLocator,
  ): Promise<readonly PostedReview[]> => {
    checkInputs(credential, pullRequest);
    if (typeof credential.token !== "string" || !TOKEN.test(credential.token)) {
      throw new ForgeReadError("http_status", 401);
    }
    const own: PostedReview[] = [];
    for (let page = 1; page <= MAX_REVIEW_LIST_PAGES; page++) {
      const answer = await send(
        "GET",
        `${reviewsPath(pullRequest)}?per_page=${PAGE_SIZE}&page=${page}`,
        credential.token,
      );
      if (answer.status === 404) return [];
      if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
      const parsed = ReviewListJson.safeParse(answer.body);
      if (!parsed.success) throw new ForgeReadError("invalid_response");
      for (const item of parsed.data) {
        if (item.user?.id === credential.userId) own.push(toPosted(item));
      }
      if (parsed.data.length < PAGE_SIZE) return own.sort((a, b) => b.id - a.id);
    }
    // Every page was full: there may be newer reviews unseen. Not a usable list.
    throw new ForgeReadError("invalid_response");
  };

  const countReviewComments = async (
    credential: ForgeUserCredential,
    pullRequest: PullRequestLocator,
    reviewId: number,
  ): Promise<number> => {
    checkInputs(credential, pullRequest);
    if (!Number.isSafeInteger(reviewId) || reviewId < 1)
      throw new Error("reviews: invalid review id");
    if (typeof credential.token !== "string" || !TOKEN.test(credential.token)) {
      throw new ForgeReadError("http_status", 401);
    }
    let count = 0;
    for (let page = 1; page <= MAX_REVIEW_LIST_PAGES; page++) {
      const answer = await send(
        "GET",
        `${reviewsPath(pullRequest)}/${reviewId}/comments?per_page=${PAGE_SIZE}&page=${page}`,
        credential.token,
      );
      if (answer.status !== 200) throw new ForgeReadError("http_status", answer.status);
      const parsed = CommentListJson.safeParse(answer.body);
      if (!parsed.success) throw new ForgeReadError("invalid_response");
      count += parsed.data.length;
      if (parsed.data.length < PAGE_SIZE) return count;
    }
    throw new ForgeReadError("invalid_response");
  };

  return { kind: "github", postReview, listOwnReviews, countReviewComments };
};
