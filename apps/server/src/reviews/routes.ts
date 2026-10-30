import type { RepositoryAccessCheck } from "@rocky-reviews/core";
import { parseDraftAction } from "@rocky-reviews/core";
import {
  addOwnComment,
  analysisRepository,
  decideDraft,
  deleteOwnComment,
  listReviewDrafts,
  type Db,
  type DraftView,
  type OwnCommentView,
} from "@rocky-reviews/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";

/**
 * The drafts API (P6-4, ADR 0027): a reviewer's decisions about the AI drafts of one analysis and
 * their own pending comments, kept on the server so a reload shows the same review. Nothing here
 * posts to GitHub: Finish review (P6-6, P3-5) does, after an explicit action.
 *
 *   GET    /api/analyses/:analysisId/review                  my drafts and own comments
 *   POST   /api/analyses/:analysisId/drafts/:findingId       { action, body?, reason? }
 *   POST   /api/analyses/:analysisId/comments                { path, line, body }
 *   DELETE /api/analyses/:analysisId/comments/:commentId
 *
 * Every route needs `drafts.own` (any member, ADR 0024) **and** GitHub read access to the
 * analysis's repository (P3-6): without the access check the routes answer 503, and a denial is
 * the same 404 as an unknown analysis. The member and org come from the session; a draft's
 * location and body come from the stored analysis, never from the request. State changes are
 * CSRF-checked by the global guard (ADR 0020 §5).
 *
 * Each draft and comment says whether a review attempt carries it (`posted`: `posting`,
 * `posted` or null, P3-5): the page shows such items as posted and read-only (P6-6).
 *
 * Logs carry the action, a fixed outcome and ids; never a body, a title or a path.
 */

export const REVIEW_PATH = "/api/analyses/:analysisId/review";
export const DRAFT_PATH = "/api/analyses/:analysisId/drafts/:findingId";
export const COMMENTS_PATH = "/api/analyses/:analysisId/comments";
export const COMMENT_PATH = "/api/analyses/:analysisId/comments/:commentId";

export interface ReviewRoutesDeps {
  readonly db: Pick<Db, "withOrg">;
  /** The repository access check (P3-6); without it every route here answers 503. */
  readonly repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The schema's `Id` (packages/schema primitives). */
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const json = (reply: FastifyReply, status: number, body?: unknown) =>
  reply.code(status).header("cache-control", "no-store").send(body);

const callerOf = (request: FastifyRequest): ActiveMember => {
  const member = request.access?.member;
  if (member === undefined) throw Object.assign(new Error("no member"), { statusCode: 401 });
  return member;
};

const param = (request: FastifyRequest, name: string): string | undefined => {
  const value = (request.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
};

const uuidParam = (request: FastifyRequest, name: string): string | null => {
  const value = param(request, name);
  return value !== undefined && UUID.test(value) ? value.toLowerCase() : null;
};

const bodyField = (request: FastifyRequest, name: string): unknown => {
  const body = request.body;
  return typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.hasOwn(body, name)
    ? (body as Record<string, unknown>)[name]
    : undefined;
};

const draftJson = (d: DraftView) => ({
  findingId: d.findingId,
  state: d.state,
  reason: d.reason,
  edited: d.edited,
  body: d.body,
  agentPromptCopiedAt: d.agentPromptCopiedAt?.toISOString() ?? null,
  updatedAt: d.updatedAt.toISOString(),
  posted: d.posted,
});

const commentJson = (c: OwnCommentView) => ({
  id: c.id,
  path: c.path,
  line: c.line,
  body: c.body,
  createdAt: c.createdAt.toISOString(),
  posted: c.posted,
});

export const registerReviewRoutes = (app: FastifyInstance, deps: ReviewRoutesDeps): void => {
  const { db } = deps;

  const log = (
    request: FastifyRequest,
    action: string,
    outcome: string,
    ids: { orgId?: string; analysisId?: string } = {},
  ) => request.log.info({ drafts: { action, outcome, ...ids } }, "drafts");

  /**
   * The caller and the analysis, once the analysis is found in the caller's org and GitHub lets
   * the caller read its repository; otherwise the reply has been sent and `null` returned.
   */
  const authorise = async (request: FastifyRequest, reply: FastifyReply, action: string) => {
    const me = callerOf(request);
    const analysisId = uuidParam(request, "analysisId");
    if (analysisId === null) {
      await json(reply, 400, { error: "invalid_analysis" });
      return null;
    }
    const ids = { orgId: me.orgId, analysisId };
    if (deps.repositoryAccess === undefined) {
      log(request, action, "access_check_unavailable", ids);
      await json(reply, 503, { error: "access_check_unavailable" });
      return null;
    }
    const repository = await db.withOrg(me.orgId, (tx) => analysisRepository(tx, analysisId));
    if (repository === null) {
      log(request, action, "not_found", ids);
      await json(reply, 404, { error: "not_found" });
      return null;
    }
    const decision = await deps.repositoryAccess.check({
      orgId: me.orgId,
      memberId: me.memberId,
      repositoryId: repository.forgeRepoId,
    });
    if (!decision.allowed) {
      log(request, action, "repository_access_denied", ids);
      // The same answer as an unknown analysis: nothing about a repository they cannot read.
      await json(reply, 404, { error: "not_found" });
      return null;
    }
    return { me, analysisId, ids };
  };

  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      const code = (error as { code?: unknown }).code;
      request.log[status >= 500 ? "error" : "warn"](
        {
          drafts: {
            outcome: "request_failed",
            status,
            ...(typeof code === "string" && SQLSTATE.test(code) ? { errorCode: code } : {}),
          },
        },
        "drafts",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : status === 401 ? "unauthenticated" : "bad_request",
      });
    });

    scope.get(
      REVIEW_PATH,
      { config: { policy: requires("drafts.own") } },
      async (request, reply) => {
        const ok = await authorise(request, reply, "list");
        if (ok === null) return reply;
        const view = await db.withOrg(ok.me.orgId, (tx) =>
          listReviewDrafts(tx, { analysisId: ok.analysisId, memberId: ok.me.memberId }),
        );
        if (view === null) return json(reply, 404, { error: "not_found" });
        return json(reply, 200, {
          analysisId: ok.analysisId,
          drafts: view.drafts.map(draftJson),
          comments: view.comments.map(commentJson),
        });
      },
    );

    scope.post(
      DRAFT_PATH,
      { config: { policy: requires("drafts.own") } },
      async (request, reply) => {
        const findingId = param(request, "findingId");
        if (findingId === undefined || !FINDING_ID.test(findingId))
          return json(reply, 400, { error: "invalid_finding" });
        const action = parseDraftAction(request.body);
        if (action === null) return json(reply, 400, { error: "invalid_action" });
        const ok = await authorise(request, reply, action.kind);
        if (ok === null) return reply;
        const result = await db.withOrg(ok.me.orgId, (tx) =>
          decideDraft(tx, {
            analysisId: ok.analysisId,
            memberId: ok.me.memberId,
            findingId,
            action,
          }),
        );
        log(request, action.kind, result.outcome, ok.ids);
        switch (result.outcome) {
          case "ok":
            return json(reply, 200, { draft: draftJson(result.draft) });
          case "invalid_transition":
            return json(reply, 409, {
              error: "invalid_transition",
              draft: draftJson(result.draft),
            });
          case "already_posted":
            // Carried by a review being posted or posted (ADR 0026 S2): the current state, as
            // a conflict, so the page shows it.
            return json(reply, 409, { error: "already_posted", draft: draftJson(result.draft) });
          case "invalid_body":
          case "comment_too_long":
            return json(reply, 400, { error: result.outcome });
          case "unknown_finding":
          case "not_found":
            return json(reply, 404, { error: "not_found" });
        }
      },
    );

    scope.post(
      COMMENTS_PATH,
      { config: { policy: requires("drafts.own") } },
      async (request, reply) => {
        const ok = await authorise(request, reply, "comment_add");
        if (ok === null) return reply;
        const result = await db.withOrg(ok.me.orgId, (tx) =>
          addOwnComment(tx, {
            analysisId: ok.analysisId,
            memberId: ok.me.memberId,
            path: bodyField(request, "path"),
            line: bodyField(request, "line"),
            body: bodyField(request, "body"),
          }),
        );
        log(request, "comment_add", result.outcome, ok.ids);
        switch (result.outcome) {
          case "created":
            return json(reply, 201, { comment: commentJson(result.comment) });
          case "invalid_location":
          case "invalid_body":
            return json(reply, 400, { error: result.outcome });
          case "not_found":
            return json(reply, 404, { error: "not_found" });
        }
      },
    );

    scope.delete(
      COMMENT_PATH,
      { config: { policy: requires("drafts.own") } },
      async (request, reply) => {
        const commentId = uuidParam(request, "commentId");
        if (commentId === null) return json(reply, 400, { error: "invalid_comment" });
        const ok = await authorise(request, reply, "comment_delete");
        if (ok === null) return reply;
        const outcome = await db.withOrg(ok.me.orgId, (tx) =>
          deleteOwnComment(tx, { analysisId: ok.analysisId, memberId: ok.me.memberId, commentId }),
        );
        log(request, "comment_delete", outcome, ok.ids);
        if (outcome === "deleted") return json(reply, 204);
        return outcome === "already_posted"
          ? json(reply, 409, { error: "already_posted" })
          : json(reply, 404, { error: "not_found" });
      },
    );
  });
};
