import { isReviewVerdict, MAX_REVIEW_BODY_CHARS } from "@rocky-reviews/core";
import type { ReviewSubmissionRecord } from "@rocky-reviews/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";
import type { ReviewPostingService, ReviewSubmitInput } from "./post-review.js";

/**
 * Posting a review as the user (P3-5, ADR 0026): the two routes behind the policy
 * `pull_requests.review` (any active member; roles never widen GitHub access, so both also run
 * the P3-6 access check inside the service).
 *
 *   GET  /api/pull-requests/:pullRequestId/review   the exact list that would be posted now, its
 *                                                   digest, the attempt in flight and the latest
 *                                                   attempt (no side effects)
 *   POST /api/pull-requests/:pullRequestId/review   (CSRF) the person's click: posts that list,
 *        { idempotencyKey, contentSha256, headSha, verdict, body }
 *
 * Who posts comes from the session (`request.access.member`), never from the body: fields such
 * as `orgId`, `memberId` or `submittedBy` in a body are ignored. Every refusal is a fixed JSON
 * code; the service logs ids, counts and codes only.
 */

export const POST_REVIEW_PATH = "/api/pull-requests/:pullRequestId/review";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/i;
const HEAD_SHA = /^[0-9a-f]{40}$/;

const json = (reply: FastifyReply, status: number, body?: unknown) =>
  reply.code(status).header("cache-control", "no-store").send(body);

/** The caller, as the policy resolved it. Absent only if a route lost its policy: fail closed. */
const callerOf = (request: FastifyRequest): ActiveMember => {
  const member = request.access?.member;
  if (member === undefined) throw Object.assign(new Error("no member"), { statusCode: 401 });
  return member;
};

const pullRequestIdOf = (request: FastifyRequest): string | null => {
  const value = (request.params as Record<string, unknown> | undefined)?.["pullRequestId"];
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
};

/** The documented fields, validated by shape here (the service validates the content). */
const submitInputOf = (body: unknown): ReviewSubmitInput | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  const { idempotencyKey, contentSha256, headSha, verdict } = fields;
  const text = fields["body"];
  if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) return null;
  if (typeof contentSha256 !== "string" || !HEX_64.test(contentSha256)) return null;
  if (typeof headSha !== "string" || !HEAD_SHA.test(headSha)) return null;
  if (!isReviewVerdict(verdict)) return null;
  if (typeof text !== "string" || text.length > MAX_REVIEW_BODY_CHARS) return null;
  return {
    idempotencyKey: idempotencyKey.toLowerCase(),
    contentSha256: contentSha256.toLowerCase(),
    headSha,
    verdict,
    body: text,
  };
};

/** An attempt as the client sees it: ids, status, counts and times; never content. */
const summary = (submission: ReviewSubmissionRecord | null) =>
  submission === null
    ? null
    : {
        submissionId: submission.submissionId,
        status: submission.status,
        verdict: submission.verdict,
        draftCount: submission.draftCount,
        commentCount: submission.commentCount,
        reviewId: submission.forgeReviewId,
        errorCode: submission.errorCode,
        createdAt: submission.createdAt.toISOString(),
        finishedAt: submission.finishedAt?.toISOString() ?? null,
      };

export const registerReviewPostingRoutes = (
  app: FastifyInstance,
  service: ReviewPostingService,
): void => {
  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      request.log[status >= 500 ? "error" : "warn"](
        { review: { outcome: "request_failed", status } },
        "review posting",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : status === 401 ? "unauthenticated" : "bad_request",
      });
    });

    scope.get(
      POST_REVIEW_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const me = callerOf(request);
        const pullRequestId = pullRequestIdOf(request);
        if (pullRequestId === null) return json(reply, 400, { error: "invalid_pull_request" });
        const result = await service.preview(
          { orgId: me.orgId, memberId: me.memberId },
          pullRequestId,
        );
        switch (result.outcome) {
          case "ok":
            return json(reply, 200, {
              pullRequestId: result.plan.pullRequestId,
              number: result.plan.number,
              headSha: result.plan.headSha,
              revisionKnown: result.plan.revisionId !== null,
              contentSha256: result.plan.contentSha256.toString("hex"),
              inFlight: summary(result.plan.inFlight),
              latestSubmission: summary(result.plan.latest),
              items: result.plan.items.map((item) => ({
                kind: item.kind,
                id: item.id,
                path: item.path,
                line: item.line,
                startLine: item.startLine,
                body: item.body,
              })),
            });
          case "not_found":
            return json(reply, 404, { error: "not_found" });
          case "unavailable":
            return json(reply, 503, { error: "posting_unavailable" });
        }
      },
    );

    scope.post(
      POST_REVIEW_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const me = callerOf(request);
        const pullRequestId = pullRequestIdOf(request);
        if (pullRequestId === null) return json(reply, 400, { error: "invalid_pull_request" });
        const input = submitInputOf(request.body);
        if (input === null) return json(reply, 400, { error: "invalid_request" });
        const result = await service.submit(
          { orgId: me.orgId, memberId: me.memberId },
          pullRequestId,
          input,
        );
        switch (result.outcome) {
          case "posted":
            return json(reply, 200, {
              status: "posted",
              submissionId: result.submissionId,
              reviewId: result.reviewId,
              repeated: result.repeated,
            });
          case "invalid":
            return json(reply, 400, { error: "invalid_request", reason: result.reason });
          case "not_found":
            return json(reply, 404, { error: "not_found" });
          case "unavailable":
            return json(reply, 503, { error: "posting_unavailable" });
          case "post_failed":
            return json(reply, 502, {
              error: "post_failed",
              submissionId: result.submissionId,
              reason: result.reason,
            });
          case "post_unknown":
            return json(reply, 502, { error: "post_unknown", submissionId: result.submissionId });
          default:
            return json(reply, 409, { error: result.outcome });
        }
      },
    );
  });
};
