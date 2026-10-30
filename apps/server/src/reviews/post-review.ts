import {
  ForgeReadError,
  type ForgeUserCredential,
  type OrgId,
  type RepositoryAccessCheck,
  type ReviewPoster,
  type ReviewVerdict,
} from "@rocky-reviews/core";
import type { KeyWrapper } from "@rocky-reviews/crypto";
import {
  beginReviewSubmission,
  finishReviewSubmission,
  loadReviewPlan,
  recordedReviewIds,
  resolveRepositoryForAccess,
  reviewSha256,
  type Db,
  type ReviewPlan,
  type ReviewSubmissionRecord,
} from "@rocky-reviews/db";
import type { Logger } from "@rocky-reviews/log";
import { readMemberCredential } from "../member-token.js";

/**
 * Posting a review as the user (P3-5, ADR 0026): the service the routes (and P6-6's finish
 * modal) call. Two operations, both for a member the access policy already resolved:
 *
 * - `preview`: the exact list that would be posted now (packages/db `loadReviewPlan`) and its
 *   digest, for the person to look at;
 * - `submit`: the person's click. In order: the P3-6 repository access check (deny → the same
 *   answer as an unknown pull request; refused outright without the check), the member's own
 *   credential (decrypted for this call), one transaction that records the attempt as `posting`
 *   only if the digest and head still match what was shown (`beginReviewSubmission`), the one
 *   forge call with the person's token, and one transaction that records the answer. A lost
 *   answer leaves the attempt `posting`; the next attempt after `postingTimeoutMs` reconciles
 *   it from the person's own reviews on the forge, so nothing is ever posted twice on a guess.
 *
 * No other code path reaches `ReviewPoster`: the worker never constructs one, and the
 * installation-token `Forge` has no posting method. Logs carry ids, counts and fixed codes.
 */

/** An attempt older than this with no answer is reconciled with the forge before anything else. */
export const REVIEW_POSTING_TIMEOUT_MS = 60_000;
/**
 * A review found on the forge counts as the attempt's only if the forge submitted it no earlier
 * than this before the attempt was recorded (the two clocks differ: review round 1, S1/S3).
 */
export const RECONCILE_CLOCK_MARGIN_MS = 5 * 60_000;

export interface ReviewPostingDeps {
  readonly db: Pick<Db, "withOrg">;
  readonly keys: KeyWrapper;
  readonly poster: ReviewPoster;
  /** The P3-6 check. Without it every operation answers `unavailable` (fail closed). */
  readonly repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
  readonly log: Pick<Logger, "info" | "warn">;
  readonly now?: () => number;
  readonly postingTimeoutMs?: number;
}

/** The caller, as the access policy resolved it (ids from the session only). */
export interface ReviewActor {
  readonly orgId: OrgId;
  readonly memberId: string;
}

export interface ReviewSubmitInput {
  readonly idempotencyKey: string;
  /** Hex sha256 of the plan the client showed. */
  readonly contentSha256: string;
  readonly headSha: string;
  readonly verdict: ReviewVerdict;
  readonly body: string;
}

export type ReviewPreviewResult =
  | { readonly outcome: "ok"; readonly plan: ReviewPlan }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable" };

export type ReviewSubmitResult =
  | {
      readonly outcome: "posted";
      readonly submissionId: string;
      readonly reviewId: number;
      /** The same key was answered before: nothing was posted this time. */
      readonly repeated: boolean;
    }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "invalid"; readonly reason: string }
  | {
      readonly outcome:
        "stale" | "head_moved" | "in_progress" | "key_reused" | "no_revision" | "token_unavailable";
    }
  /** The forge refused, or an earlier attempt with this key did: the attempt is `failed`. */
  | { readonly outcome: "post_failed"; readonly submissionId: string; readonly reason: string }
  /** The forge gave no usable answer: the attempt stays `posting` until reconciled. */
  | { readonly outcome: "post_unknown"; readonly submissionId: string };

type Reconciled = "posted" | "failed" | "pending";

export interface ReviewPostingService {
  preview(actor: ReviewActor, pullRequestId: string): Promise<ReviewPreviewResult>;
  submit(
    actor: ReviewActor,
    pullRequestId: string,
    input: ReviewSubmitInput,
  ): Promise<ReviewSubmitResult>;
}

const RECONCILE_ACTOR = { type: "system", id: "review_reconcile" } as const;

export const createReviewPostingService = (deps: ReviewPostingDeps): ReviewPostingService => {
  const now = deps.now ?? Date.now;
  const timeout = deps.postingTimeoutMs ?? REVIEW_POSTING_TIMEOUT_MS;
  const { db } = deps;

  const log = (
    level: "info" | "warn",
    outcome: string,
    fields: Record<string, string | number | boolean>,
  ) => deps.log[level]({ review: { outcome, ...fields } }, "review posting");

  /**
   * Steps 3 and 4 of ADR 0011 §6: resolve only the repository's forge id, then ask the access
   * check outside any transaction. `null` for every deny (the route answers 404).
   */
  const authorize = async (
    actor: ReviewActor,
    pullRequestId: string,
  ): Promise<{ ok: true } | { ok: false; outcome: "not_found" | "unavailable" }> => {
    if (deps.repositoryAccess === undefined) {
      log("warn", "access_check_unavailable", { orgId: actor.orgId });
      return { ok: false, outcome: "unavailable" };
    }
    const target = await db.withOrg(actor.orgId, (tx) =>
      resolveRepositoryForAccess(tx, { pullRequestId }),
    );
    if (target === null) return { ok: false, outcome: "not_found" };
    const decision = await deps.repositoryAccess.check({
      orgId: actor.orgId,
      memberId: actor.memberId,
      repositoryId: target.forgeRepoId,
    });
    if (!decision.allowed) {
      log("info", "repository_access_denied", { orgId: actor.orgId, reason: decision.reason });
      return { ok: false, outcome: "not_found" };
    }
    return { ok: true };
  };

  const preview = async (
    actor: ReviewActor,
    pullRequestId: string,
  ): Promise<ReviewPreviewResult> => {
    const allowed = await authorize(actor, pullRequestId);
    if (!allowed.ok) return { outcome: allowed.outcome };
    const plan = await db.withOrg(actor.orgId, (tx) =>
      loadReviewPlan(tx, { pullRequestId, memberId: actor.memberId }),
    );
    if (plan === null) return { outcome: "not_found" };
    return { outcome: "ok", plan };
  };

  /**
   * An attempt whose answer was lost: once it is older than the timeout (by the database's
   * clock), ask the forge for the person's own reviews and look for this one. A review is the
   * attempt's only when all of these hold (review round 1, S1): its id is not one Rocky already
   * recorded, its commit is the attempt's head, its state is the attempt's verdict, its summary
   * digest is the attempt's, the forge submitted it no earlier than the margin before the attempt
   * was recorded, and it carries as many inline comments as the attempt did (asked from the
   * forge when the attempt carried any). Exactly one such review: it was posted. None: the forge
   * never took it, so it failed and its items are free again. More than one, or no usable
   * answer from the forge: it stays as it is (never decided on a guess).
   */
  const reconcile = async (
    actor: ReviewActor,
    credential: ForgeUserCredential,
    submission: ReviewSubmissionRecord,
    pullRequest: { fullName: string; number: number },
  ): Promise<Reconciled> => {
    if (submission.ageMs < timeout) return "pending";
    const fields = { orgId: actor.orgId, submissionId: submission.submissionId };
    let found: number | undefined;
    try {
      const recorded = new Set(
        await db.withOrg(actor.orgId, (tx) => recordedReviewIds(tx, submission.pullRequestId)),
      );
      const notBefore = submission.createdAt.getTime() - RECONCILE_CLOCK_MARGIN_MS;
      const carried = submission.draftCount + submission.commentCount;
      const own = await deps.poster.listOwnReviews(credential, pullRequest);
      const candidates: number[] = [];
      for (const r of own) {
        if (
          recorded.has(r.id) ||
          r.headSha !== submission.headSha ||
          r.state !== submission.verdict ||
          r.submittedAt === null ||
          r.submittedAt.getTime() < notBefore ||
          !reviewSha256(r.body).equals(submission.bodySha256)
        ) {
          continue;
        }
        const count =
          carried === 0 ? 0 : await deps.poster.countReviewComments(credential, pullRequest, r.id);
        if (count === carried) candidates.push(r.id);
      }
      if (candidates.length > 1) {
        log("warn", "reconcile_ambiguous", { ...fields, candidates: candidates.length });
        return "pending";
      }
      found = candidates[0];
    } catch (error) {
      log("warn", "reconcile_failed", {
        ...fields,
        errorCode: error instanceof ForgeReadError ? error.code : "error",
      });
      return "pending";
    }
    const result =
      found === undefined
        ? ({ posted: false, errorCode: "lost" } as const)
        : ({ posted: true, forgeReviewId: found } as const);
    const finished = await db.withOrg(actor.orgId, (tx) =>
      finishReviewSubmission(tx, submission.submissionId, result, RECONCILE_ACTOR),
    );
    if (finished === null) {
      // Finished meanwhile (a late answer landed): report what the row says now.
      log("warn", "reconcile_already_finished", fields);
      return "pending";
    }
    log("info", found === undefined ? "reconciled_lost" : "reconciled_posted", fields);
    return found === undefined ? "failed" : "posted";
  };

  const finish = (
    actor: ReviewActor,
    submissionId: string,
    result: { posted: true; forgeReviewId: number } | { posted: false; errorCode: string },
  ) =>
    db.withOrg(actor.orgId, (tx) =>
      finishReviewSubmission(tx, submissionId, result, { type: "user", id: actor.memberId }),
    );

  const submit = async (
    actor: ReviewActor,
    pullRequestId: string,
    input: ReviewSubmitInput,
    depth = 0,
  ): Promise<ReviewSubmitResult> => {
    const allowed = await authorize(actor, pullRequestId);
    if (!allowed.ok) return { outcome: allowed.outcome };

    // The person's own credential, decrypted for this call only (no attempt is recorded without it).
    const credential = await readMemberCredential(
      deps,
      actor.orgId,
      actor.memberId,
      new Date(now()),
    );
    if (!credential.ok) {
      log("info", "token_unavailable", { orgId: actor.orgId, reason: credential.reason });
      return { outcome: "token_unavailable" };
    }

    const begun = await db.withOrg(actor.orgId, (tx) =>
      beginReviewSubmission(tx, {
        memberId: actor.memberId,
        pullRequestId,
        idempotencyKey: input.idempotencyKey,
        contentSha256: input.contentSha256,
        headSha: input.headSha,
        verdict: input.verdict,
        body: input.body,
      }),
    );
    const ids = { orgId: actor.orgId, pullRequestId };
    switch (begun.outcome) {
      case "started":
        break;
      case "existing":
      case "in_progress": {
        const { submission } = begun;
        if (submission.status === "posted" && submission.forgeReviewId !== null) {
          log("info", "repeated", { ...ids, submissionId: submission.submissionId });
          return {
            outcome: "posted",
            submissionId: submission.submissionId,
            reviewId: submission.forgeReviewId,
            repeated: true,
          };
        }
        if (submission.status === "failed") {
          return {
            outcome: "post_failed",
            submissionId: submission.submissionId,
            reason: submission.errorCode ?? "failed",
          };
        }
        const plan = await db.withOrg(actor.orgId, (tx) =>
          loadReviewPlan(tx, { pullRequestId, memberId: actor.memberId }),
        );
        if (plan === null) return { outcome: "not_found" };
        const reconciled = await reconcile(actor, credential.credential, submission, {
          fullName: plan.repositoryFullName,
          number: plan.number,
        });
        if (reconciled === "pending") {
          log("info", "in_progress", { ...ids, submissionId: submission.submissionId });
          return { outcome: "in_progress" };
        }
        // Resolved: answer this click against the settled state (once).
        if (depth > 0) return { outcome: "in_progress" };
        return submit(actor, pullRequestId, input, depth + 1);
      }
      case "invalid":
        log("info", "invalid", { ...ids, reason: begun.reason });
        return { outcome: "invalid", reason: begun.reason };
      case "not_permitted":
        log("info", "not_permitted", ids);
        return { outcome: "not_found" };
      default:
        log("info", begun.outcome, ids);
        return { outcome: begun.outcome };
    }

    const { submission, plan, review } = begun;
    const submissionId = submission.submissionId;
    const counts = {
      ...ids,
      submissionId,
      draftCount: submission.draftCount,
      commentCount: submission.commentCount,
    };
    let answer;
    try {
      answer = await deps.poster.postReview(
        credential.credential,
        { fullName: plan.repositoryFullName, number: plan.number },
        review,
      );
    } catch (error) {
      if (error instanceof ForgeReadError) {
        // No usable answer: the review may exist. The attempt stays `posting` for reconciliation.
        log("warn", "post_unknown", { ...counts, errorCode: error.code });
        return { outcome: "post_unknown", submissionId };
      }
      // Refused before any request (a caller bug): definite, nothing reached the forge (N1).
      await finish(actor, submissionId, { posted: false, errorCode: "invalid" });
      log("warn", "post_failed", { ...counts, reason: "invalid" });
      return { outcome: "post_failed", submissionId, reason: "invalid" };
    }
    if (!answer.posted) {
      const finished = await finish(actor, submissionId, {
        posted: false,
        errorCode: answer.reason,
      });
      if (finished === null) log("warn", "finish_not_applied", counts);
      log("info", "post_failed", { ...counts, reason: answer.reason });
      return { outcome: "post_failed", submissionId, reason: answer.reason };
    }
    // The forge took it: recorded even over a reconciliation that called it lost meanwhile.
    const finished = await finish(actor, submissionId, {
      posted: true,
      forgeReviewId: answer.review.id,
    });
    if (finished === null) log("warn", "finish_not_applied", counts);
    log("info", "posted", { ...counts, reviewId: answer.review.id });
    return { outcome: "posted", submissionId, reviewId: answer.review.id, repeated: false };
  };

  return { preview, submit: (actor, pullRequestId, input) => submit(actor, pullRequestId, input) };
};
