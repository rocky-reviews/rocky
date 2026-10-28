import { can, isPermission, type Permission } from "@rocky-reviews/core";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  RouteOptions,
} from "fastify";
import type { ActiveMember, SessionAuth, SessionContext } from "./routes.js";

/**
 * The one access policy (P7-2, ADR 0024). Every route declares what it needs in
 * `config.policy`, and an `onRoute` hook refuses to register a route that does not: a new route
 * cannot forget the check, it fails at boot (and in the route-permission matrix test).
 *
 * - `publicRoute(reason)`: no session needed (health, webhooks, the login flow). The reason is
 *   documentation the matrix test prints; the route authenticates itself if it must.
 * - `SESSION_ROUTE`: a live session (the session API: no org needed yet).
 * - `requires(permission)`: a live session whose active org's member row (re-read inside
 *   `withOrg` on every request, so a role change or removal applies to the very next request)
 *   holds the permission (`can`, packages/core).
 *
 * Enforcement is a route-level `onRequest` hook, after the global CSRF guard and before the
 * body is read. The handler finds what was resolved on `request.access`; ids come from the
 * session, never from the request. Denials are fixed JSON answers and a log line with the reason
 * and permission only:
 *
 *   401 { error: "unauthenticated" }  no live session
 *   409 { error: "no_active_org" }    a session, but no org chosen (or it was cut from it)
 *   403 { error: "not_a_member" }     the active org's member row is gone, removed, or the org is
 *                                     being deleted
 *   403 { error: "forbidden" }        a member whose role lacks the permission
 *
 * Roles never widen GitHub access: routes that touch a repository's data also run the P3-6
 * access check for the member.
 */

export type RoutePolicy =
  | { readonly kind: "public"; readonly reason: string }
  | { readonly kind: "session" }
  | { readonly kind: "permission"; readonly permission: Permission };

export const publicRoute = (reason: string): RoutePolicy => ({ kind: "public", reason });
export const SESSION_ROUTE: RoutePolicy = Object.freeze({ kind: "session" });
export const requires = (permission: Permission): RoutePolicy => ({
  kind: "permission",
  permission,
});

declare module "fastify" {
  interface FastifyContextConfig {
    /** Required on every route (P7-2): who may call it. */
    policy?: RoutePolicy;
  }
  interface FastifyRequest {
    /** What the access policy resolved for this request; `null` on public routes. */
    access: RequestAccess | null;
  }
}

export interface RequestAccess {
  readonly session: SessionContext;
  /** Present on permission routes only. */
  readonly member?: ActiveMember;
}

/** One registered route and its declared policy (the matrix test enumerates these). */
export interface PolicyEntry {
  readonly method: string;
  readonly url: string;
  readonly policy: RoutePolicy;
}

export class RoutePolicyError extends Error {
  override readonly name = "RoutePolicyError";
}

const isRoutePolicy = (value: unknown): value is RoutePolicy => {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Record<string, unknown>;
  switch (policy["kind"]) {
    case "public":
      return typeof policy["reason"] === "string" && policy["reason"].length > 0;
    case "session":
      return true;
    case "permission":
      return isPermission(policy["permission"]);
    default:
      return false;
  }
};

const deny = (
  request: FastifyRequest,
  reply: FastifyReply,
  status: 401 | 403 | 409,
  error: "unauthenticated" | "no_active_org" | "not_a_member" | "forbidden",
  permission?: Permission,
) => {
  request.log.info(
    {
      access: {
        outcome: "denied",
        reason: error,
        ...(permission === undefined ? {} : { permission }),
      },
    },
    "access denied",
  );
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .send(status === 401 ? { error, authenticated: false } : { error });
};

const asArray = <T>(value: T | readonly T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? [...(value as T[])] : [value as T];

/**
 * Registers the policy on `app`. Must run before any route is added (routes registered earlier
 * are not seen); `buildApp` calls it first. `sessionAuth` is read per request, so login can be
 * wired after this; without it every session or permission route answers 401 (fail closed).
 */
export const registerAccessPolicy = (
  app: FastifyInstance,
  sessionAuth: () => SessionAuth | undefined,
): { readonly routes: () => readonly PolicyEntry[] } => {
  const entries: PolicyEntry[] = [];
  app.decorateRequest("access", null);

  const enforce =
    (policy: Exclude<RoutePolicy, { kind: "public" }>): onRequestAsyncHookHandler =>
    async (request, reply) => {
      const auth = sessionAuth();
      if (policy.kind === "session") {
        const session = auth === undefined ? null : await auth.authenticate(request);
        if (session === null) return deny(request, reply, 401, "unauthenticated");
        request.access = { session };
        return undefined;
      }
      if (auth === undefined)
        return deny(request, reply, 401, "unauthenticated", policy.permission);
      const resolved = await auth.activeMember(request);
      if (!resolved.ok)
        return deny(request, reply, resolved.status, resolved.error, policy.permission);
      if (!can(resolved.member.role, policy.permission)) {
        return deny(request, reply, 403, "forbidden", policy.permission);
      }
      request.access = { session: resolved.session, member: resolved.member };
      return undefined;
    };

  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = asArray(route.method);
    const policy = route.config?.policy;
    if (!isRoutePolicy(policy)) {
      throw new RoutePolicyError(
        `route ${methods.join(",")} ${route.url} declares no access policy (config.policy)`,
      );
    }
    for (const method of methods) entries.push({ method, url: route.url, policy });
    if (policy.kind === "public") return;
    // A new array: a HEAD route Fastify derives from a GET shares the original options.
    route.onRequest = [...asArray(route.onRequest), enforce(policy)];
  });

  return { routes: () => entries.map((e) => ({ ...e })) };
};
