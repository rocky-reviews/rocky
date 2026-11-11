import {
  AddRepositoryRequest,
  AddRepositoryResponse,
  AvailableRepositoriesResponse,
  ConnectionErrorResponse,
  ConnectionResponse,
  SaveTokenRequest,
  SaveTokenResponse,
  SyncResponse,
} from "@rocky-reviews/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";
import { tokenRefusalStatus } from "../setup/routes.js";
import type { TokenConnectionService } from "./connection.js";

/**
 * The token connection's API (P10-4, ADR 0045 §4), registered only in token mode:
 *
 *   GET    /api/connection                   connection.manage   the token (described), repositories
 *   PUT    /api/connection/token {token}     connection.manage   replace the token (same owner)
 *   DELETE /api/connection/token             connection.manage   remove it (Rocky stops reading)
 *   GET    /api/connection/available         connection.manage   repositories the token can see
 *   POST   /api/connection/repositories      connection.manage   follow one {forgeRepoId}, then sync it
 *   DELETE /api/connection/repositories/:id  connection.manage   stop following (rows stay)
 *   POST   /api/connection/sync {repoId?}    pull_requests.review  read pull requests from GitHub
 *
 * Every write passes the global CSRF guard (ADR 0020 §5). Ids come from the session, never
 * from the request; another org's repository is not found (RLS). Answers are validated against
 * the core schemas before they leave; the token is never in one, and refusals are fixed codes
 * (`ConnectionErrorResponse`). Logs carry ids and codes only.
 */

export const CONNECTION_PATH = "/api/connection";
export const CONNECTION_TOKEN_PATH = "/api/connection/token";
export const CONNECTION_AVAILABLE_PATH = "/api/connection/available";
export const CONNECTION_REPOSITORIES_PATH = "/api/connection/repositories";
export const CONNECTION_REPOSITORY_PATH = "/api/connection/repositories/:id";
export const CONNECTION_SYNC_PATH = "/api/connection/sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (reply: FastifyReply, status: number, body?: unknown) =>
  reply.code(status).header("cache-control", "no-store").send(body);

const callerOf = (request: FastifyRequest): ActiveMember => {
  const member = request.access?.member;
  if (member === undefined) throw Object.assign(new Error("no member"), { statusCode: 401 });
  return member;
};

/** Status for an add or listing refusal. */
const addRefusalStatus = (reason: string): number =>
  reason === "rate_limited"
    ? 429
    : reason === "forge_unavailable"
      ? 502
      : reason === "no_token" || reason === "token_rejected" || reason === "forbidden"
        ? 409
        : 422;

export interface ConnectionRoutesDeps {
  readonly connection: TokenConnectionService;
}

export const registerConnectionRoutes = (
  app: FastifyInstance,
  deps: ConnectionRoutesDeps,
): void => {
  const { connection } = deps;
  const manage = { config: { policy: requires("connection.manage") } };

  const log = (
    request: FastifyRequest,
    outcome: string,
    fields: Record<string, string | number> = {},
  ) => request.log.info({ connection: { outcome, ...fields } }, "connection");

  /** Sends `body` only when it passes `schema` (no field the contract does not name). */
  const send = (
    reply: FastifyReply,
    status: number,
    schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
    body: unknown,
  ) => {
    const checked = schema.safeParse(body);
    if (!checked.success) return json(reply, 500, { error: "internal", retryAt: null });
    return json(reply, status, checked.data);
  };

  const refuse = (
    reply: FastifyReply,
    status: number,
    reason: string,
    retryAt?: Date,
  ): FastifyReply =>
    send(reply, status, ConnectionErrorResponse, {
      error: reason,
      retryAt: retryAt?.toISOString() ?? null,
    });

  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      // The status only: an error may come from a driver or GitHub, never echoed or logged.
      request.log[status >= 500 ? "error" : "warn"](
        { connection: { outcome: "request_failed", status } },
        "connection",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : "invalid_request",
        retryAt: null,
      });
    });

    scope.get(CONNECTION_PATH, manage, async (request, reply) => {
      const me = callerOf(request);
      const described = await connection.describe(me.orgId);
      if (described === null) return refuse(reply, 404, "not_found");
      return send(reply, 200, ConnectionResponse, described);
    });

    scope.put(CONNECTION_TOKEN_PATH, manage, async (request, reply) => {
      const me = callerOf(request);
      const parsed = SaveTokenRequest.safeParse(request.body);
      if (!parsed.success) return refuse(reply, 400, "invalid_request");
      const result = await connection.saveToken(parsed.data.token);
      if (!result.ok) {
        log(request, "token_refused", { orgId: me.orgId, reason: result.reason });
        return refuse(reply, tokenRefusalStatus(result.reason), result.reason, result.retryAt);
      }
      // The save binds to the org of the token's owner, which is the caller's (one token org).
      if (result.orgId !== me.orgId) return refuse(reply, 404, "not_found");
      log(request, "token_replaced", { orgId: me.orgId, kind: result.token.kind });
      return send(reply, 200, SaveTokenResponse, { token: result.token });
    });

    scope.delete(CONNECTION_TOKEN_PATH, manage, async (request, reply) => {
      const me = callerOf(request);
      if (!(await connection.removeToken(me.orgId))) return refuse(reply, 404, "not_found");
      log(request, "token_removed", { orgId: me.orgId });
      return reply.code(204).header("cache-control", "no-store").send();
    });

    scope.get(CONNECTION_AVAILABLE_PATH, manage, async (request, reply) => {
      const me = callerOf(request);
      const result = await connection.listAvailable(me.orgId);
      if (!result.ok) {
        log(request, "available_refused", { orgId: me.orgId, reason: result.reason });
        return refuse(reply, addRefusalStatus(result.reason), result.reason, result.retryAt);
      }
      return send(reply, 200, AvailableRepositoriesResponse, result.value);
    });

    scope.post(CONNECTION_REPOSITORIES_PATH, manage, async (request, reply) => {
      const me = callerOf(request);
      const parsed = AddRepositoryRequest.safeParse(request.body);
      if (!parsed.success) return refuse(reply, 400, "invalid_request");
      const result = await connection.addRepository(me.orgId, parsed.data.forgeRepoId);
      if (!result.ok) {
        log(request, "add_refused", { orgId: me.orgId, reason: result.reason });
        return refuse(reply, addRefusalStatus(result.reason), result.reason, result.retryAt);
      }
      return send(reply, 200, AddRepositoryResponse, {
        repository: result.repository,
        sync: result.sync,
      });
    });

    scope.delete(CONNECTION_REPOSITORY_PATH, manage, async (request, reply) => {
      const me = callerOf(request);
      const id = (request.params as { id?: unknown }).id;
      if (typeof id !== "string" || !UUID.test(id)) return refuse(reply, 404, "not_found");
      if (!(await connection.removeRepository(me.orgId, id.toLowerCase()))) {
        return refuse(reply, 404, "not_found");
      }
      return reply.code(204).header("cache-control", "no-store").send();
    });

    scope.post(
      CONNECTION_SYNC_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const me = callerOf(request);
        const body = (request.body ?? {}) as { repoId?: unknown };
        if (typeof body !== "object" || Array.isArray(body)) {
          return refuse(reply, 400, "invalid_request");
        }
        const keys = Object.keys(body);
        if (keys.some((k) => k !== "repoId")) return refuse(reply, 400, "invalid_request");
        let repoId: string | undefined;
        if (body.repoId !== undefined) {
          if (typeof body.repoId !== "string" || !UUID.test(body.repoId)) {
            return refuse(reply, 400, "invalid_request");
          }
          repoId = body.repoId.toLowerCase();
        }
        const result = await connection.sync(me.orgId, repoId === undefined ? {} : { repoId });
        log(request, "synced", {
          orgId: me.orgId,
          result: result.outcome,
          repositories: result.repositories.length,
        });
        return send(reply, 200, SyncResponse, result);
      },
    );
  });
};
