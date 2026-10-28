import type { OrgId, RepositoryAccessCheck } from "@rocky-reviews/core";
import { isAssignableRole } from "@rocky-reviews/core";
import {
  analysisRepository,
  approveAnalysisOverLimit,
  changeMemberRole,
  listMembers,
  removeMember,
  restoreMember,
  transferOwnership,
  type Db,
} from "@rocky-reviews/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";

/**
 * The org administration API (P7-2, ADR 0024): the minimal routes that make roles real. Every
 * route declares its permission; the access policy has resolved and checked the caller's member
 * row before a handler runs. Ids of the caller and the org come from the session
 * (`request.access.member`), never from the request; a target id from the path is looked up
 * inside the caller's `withOrg`, so another org's id is simply not found (RLS).
 *
 *   GET    /api/org/members                         members.read     the org's members
 *   PATCH  /api/org/members/:memberId {role}        roles.manage     member <-> admin
 *   DELETE /api/org/members/:memberId               members.manage   remove in Rocky
 *   POST   /api/org/members/:memberId/restore       members.manage   re-add a removed member
 *   POST   /api/org/ownership {memberId}            ownership.transfer
 *   POST   /api/analyses/:analysisId/approve-over-limit   analysis.approve_over_limit
 *
 * Every change is audited in its own transaction (packages/db `members.ts`). Roles are read from
 * the member row on every request, so a change applies to the target's next request without any
 * session being touched; a removal also cuts the org from the target's sessions and deletes their
 * stored token, and the repository access check forgets them (`onMemberChanged`).
 *
 * Logs carry fixed outcomes and ids; never logins, tokens or bodies.
 */

export const MEMBERS_PATH = "/api/org/members";
export const MEMBER_PATH = "/api/org/members/:memberId";
export const RESTORE_PATH = "/api/org/members/:memberId/restore";
export const OWNERSHIP_PATH = "/api/org/ownership";
export const APPROVE_OVER_LIMIT_PATH = "/api/analyses/:analysisId/approve-over-limit";

export interface RoleRoutesDeps {
  readonly db: Pick<Db, "withOrg">;
  /** Called after a commit that changed a member (the access check's `invalidateMember`). */
  readonly onMemberChanged?: (orgId: OrgId, memberId: string) => void;
  /**
   * The repository access check (P3-6). "Analyze anyway" needs it: without it that route
   * answers 503 (fail closed), because a role never stands in for GitHub access.
   */
  readonly repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const json = (reply: FastifyReply, status: number, body?: unknown) =>
  reply.code(status).header("cache-control", "no-store").send(body);

/** The caller, as the policy resolved it. Absent only if a route lost its policy: fail closed. */
const callerOf = (request: FastifyRequest): ActiveMember => {
  const member = request.access?.member;
  if (member === undefined) throw Object.assign(new Error("no member"), { statusCode: 401 });
  return member;
};

const idParam = (request: FastifyRequest, name: string): string | null => {
  const value = (request.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
};

const bodyField = (request: FastifyRequest, name: string): unknown => {
  const body = request.body;
  return typeof body === "object" && body !== null && Object.hasOwn(body, name)
    ? (body as Record<string, unknown>)[name]
    : undefined;
};

export const registerRoleRoutes = (app: FastifyInstance, deps: RoleRoutesDeps): void => {
  const { db } = deps;

  const changed = (orgId: OrgId, memberId: string) => {
    try {
      deps.onMemberChanged?.(orgId, memberId);
    } catch {
      // An observer failure never changes the outcome; the access check's 5-minute bound holds.
    }
  };

  const log = (
    request: FastifyRequest,
    action: string,
    outcome: string,
    extra: Record<string, string | number> = {},
  ) => request.log.info({ org_admin: { action, outcome, ...extra } }, "org admin");

  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      const code = (error as { code?: unknown }).code;
      request.log[status >= 500 ? "error" : "warn"](
        {
          org_admin: {
            outcome: "request_failed",
            status,
            ...(typeof code === "string" && SQLSTATE.test(code) ? { errorCode: code } : {}),
          },
        },
        "org admin",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : status === 401 ? "unauthenticated" : "bad_request",
      });
    });

    scope.get(
      MEMBERS_PATH,
      { config: { policy: requires("members.read") } },
      async (request, reply) => {
        const me = callerOf(request);
        const members = await db.withOrg(me.orgId, (tx) => listMembers(tx));
        return json(reply, 200, {
          members: members.map((m) => ({
            memberId: m.memberId,
            login: m.login,
            role: m.role,
            removed: m.removed,
            createdAt: m.createdAt.toISOString(),
          })),
        });
      },
    );

    scope.patch(
      MEMBER_PATH,
      { config: { policy: requires("roles.manage") } },
      async (request, reply) => {
        const me = callerOf(request);
        const target = idParam(request, "memberId");
        const role = bodyField(request, "role");
        if (target === null) return json(reply, 400, { error: "invalid_member" });
        if (!isAssignableRole(role)) return json(reply, 400, { error: "invalid_role" });
        const result = await db.withOrg(me.orgId, (tx) =>
          changeMemberRole(tx, { actorMemberId: me.memberId, targetMemberId: target, role }),
        );
        log(request, "role_change", result.outcome, { orgId: me.orgId, memberId: target });
        switch (result.outcome) {
          case "changed":
            changed(me.orgId, target);
            return json(reply, 200, { memberId: target, role: result.to });
          case "unchanged":
            return json(reply, 200, { memberId: target, role });
          case "not_found":
            return json(reply, 404, { error: "not_found" });
          case "target_is_owner":
            return json(reply, 409, { error: "target_is_owner" });
        }
      },
    );

    scope.delete(
      MEMBER_PATH,
      { config: { policy: requires("members.manage") } },
      async (request, reply) => {
        const me = callerOf(request);
        const target = idParam(request, "memberId");
        if (target === null) return json(reply, 400, { error: "invalid_member" });
        const result = await db.withOrg(me.orgId, (tx) =>
          removeMember(tx, { actorMemberId: me.memberId, targetMemberId: target }),
        );
        log(request, "remove", result.outcome, { orgId: me.orgId, memberId: target });
        switch (result.outcome) {
          case "removed":
            changed(me.orgId, target);
            return json(reply, 204);
          case "not_found":
            return json(reply, 404, { error: "not_found" });
          case "already_removed":
          case "target_is_owner":
          case "self":
            return json(reply, 409, { error: result.outcome });
        }
      },
    );

    scope.post(
      RESTORE_PATH,
      { config: { policy: requires("members.manage") } },
      async (request, reply) => {
        const me = callerOf(request);
        const target = idParam(request, "memberId");
        if (target === null) return json(reply, 400, { error: "invalid_member" });
        const result = await db.withOrg(me.orgId, (tx) =>
          restoreMember(tx, { actorMemberId: me.memberId, targetMemberId: target }),
        );
        log(request, "restore", result.outcome, { orgId: me.orgId, memberId: target });
        switch (result.outcome) {
          case "restored":
            changed(me.orgId, target);
            return json(reply, 200, { memberId: target, role: "member" });
          case "not_found":
            return json(reply, 404, { error: "not_found" });
          case "not_removed":
            return json(reply, 409, { error: "not_removed" });
        }
      },
    );

    scope.post(
      OWNERSHIP_PATH,
      { config: { policy: requires("ownership.transfer") } },
      async (request, reply) => {
        const me = callerOf(request);
        const raw = bodyField(request, "memberId");
        const target = typeof raw === "string" && UUID.test(raw) ? raw.toLowerCase() : null;
        if (target === null) return json(reply, 400, { error: "invalid_member" });
        const result = await db.withOrg(me.orgId, (tx) =>
          transferOwnership(tx, { actorMemberId: me.memberId, targetMemberId: target }),
        );
        log(request, "transfer_ownership", result.outcome, { orgId: me.orgId, memberId: target });
        switch (result.outcome) {
          case "transferred":
            changed(me.orgId, target);
            changed(me.orgId, me.memberId);
            return json(reply, 200, { ownerMemberId: target });
          case "not_found":
            return json(reply, 404, { error: "not_found" });
          case "self":
          case "not_owner":
            return json(reply, 409, { error: result.outcome });
        }
      },
    );

    scope.post(
      APPROVE_OVER_LIMIT_PATH,
      { config: { policy: requires("analysis.approve_over_limit") } },
      async (request, reply) => {
        const me = callerOf(request);
        const analysisId = idParam(request, "analysisId");
        if (analysisId === null) return json(reply, 400, { error: "invalid_analysis" });
        const repository = await db.withOrg(me.orgId, (tx) => analysisRepository(tx, analysisId));
        if (repository === null) return json(reply, 404, { error: "not_found" });
        // A role never replaces GitHub access (P3-6): the approver must be able to read the repo.
        if (deps.repositoryAccess === undefined) {
          log(request, "approve_over_limit", "access_check_unavailable", { orgId: me.orgId });
          return json(reply, 503, { error: "access_check_unavailable" });
        }
        const decision = await deps.repositoryAccess.check({
          orgId: me.orgId,
          memberId: me.memberId,
          repositoryId: repository.forgeRepoId,
        });
        if (!decision.allowed) {
          log(request, "approve_over_limit", "repository_access_denied", {
            orgId: me.orgId,
            reason: decision.reason,
          });
          // The same answer as an unknown analysis: nothing about a repo they cannot read.
          return json(reply, 404, { error: "not_found" });
        }
        const approval = await db.withOrg(me.orgId, (tx) =>
          approveAnalysisOverLimit(tx, analysisId, { memberId: me.memberId }),
        );
        log(request, "approve_over_limit", approval === undefined ? "not_waiting" : "approved", {
          orgId: me.orgId,
        });
        if (approval === undefined) return json(reply, 409, { error: "not_waiting" });
        return json(reply, 200, {
          analysisId: approval.analysisId,
          estimatedTokens: approval.estimatedTokens,
          tokenLimit: approval.tokenLimit,
        });
      },
    );
  });
};
