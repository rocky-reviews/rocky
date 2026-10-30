import type { RepositoryAccessCheck } from "@rocky-reviews/core";
import { loadPullRequestDiffTarget, type Db } from "@rocky-reviews/db";
import { limits, RepoName, RepoOwner } from "@rocky-reviews/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";
import type { PullRequestDiffReader } from "./diff-reader.js";

/**
 * The pull request's diff for the file view (H4-3, ADR 0034), read from GitHub on demand: what
 * the web app's `DiffDataSource` expects (apps/web `data/diff-data.ts`), for the mirror's head.
 *
 *   GET /api/repos/:owner/:repo/pulls/:number/diff      pull_requests.review
 *
 * Answers:
 *
 *   200 { headSha, diff, truncation }   the mirror's head; `truncation` is null (whole) or
 *                                       "max_bytes" (a prefix cut at a line end, ADR 0010 §4)
 *   400 invalid_pull_request            the address cannot name a pull request
 *   404 not_found                       unknown PR, disabled repository, another org's (RLS),
 *                                       GitHub access denied, the installation cannot read the
 *                                       repository, GitHub has no such PR: all the same answer
 *   409 head_moved                      GitHub's head is not the mirror's any more (nothing
 *                                       served; the mirror catches up on its own)
 *   409 commits_unavailable             GitHub has no diff for the mirror's commits
 *   413 diff_too_large                  GitHub refuses to render a diff this large
 *   429 rate_limited                    more than the `diff` limit per member and minute
 *   502 forge_unavailable               GitHub did not answer, or not as asked
 *   503 access_check_unavailable        no repository access check (fail closed)
 *   503 diffs_unavailable               no diff reader (no app key; fail closed)
 *
 * Order: policy (session, role), the per-member rate limit, the address, the two checks that
 * must exist, the mirror's row inside `withOrg` (ids only), the P3-6 access check (ADR 0011
 * §6), then the reader (which may answer from its short cache; the check ran either way).
 * Nothing is stored; every answer is `Cache-Control: no-store`. Logs carry ids, sizes, a digest
 * and fixed outcomes; never diff text, names or tokens.
 */

export const PULL_REQUEST_DIFF_PATH = "/api/repos/:owner/:repo/pulls/:number/diff";

export interface PullRequestDiffRoutesDeps {
  readonly db: Pick<Db, "withOrg">;
  /** The repository access check (P3-6); without it the route answers 503. */
  readonly repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
  /** The on-demand reader; without it (no app key) the route answers 503. */
  readonly diffs?: PullRequestDiffReader;
}

const json = (reply: FastifyReply, status: number, body?: unknown) =>
  reply.code(status).header("cache-control", "no-store").send(body);

const callerOf = (request: FastifyRequest): ActiveMember => {
  const member = request.access?.member;
  if (member === undefined) throw Object.assign(new Error("no member"), { statusCode: 401 });
  return member;
};

/** The path's repository and number, when they can name one on the forge; else `null`. */
const targetOf = (request: FastifyRequest) => {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const owner = RepoOwner.safeParse(params["owner"]);
  const repo = RepoName.safeParse(params["repo"]);
  const raw = params["number"];
  const number = typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!owner.success || !repo.success || [".", ".."].includes(repo.data)) return null;
  if (!Number.isSafeInteger(number) || number > limits.MAX_PR_NUMBER) return null;
  return { owner: owner.data, repo: repo.data, number };
};

export const registerPullRequestDiffRoutes = (
  app: FastifyInstance,
  deps: PullRequestDiffRoutesDeps,
): void => {
  const { db } = deps;

  const log = (
    request: FastifyRequest,
    outcome: string,
    fields: Record<string, string | number | null | boolean> = {},
  ) => request.log.info({ pull_diff_route: { outcome, ...fields } }, "pull request diff");

  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      request.log[status >= 500 ? "error" : "warn"](
        { pull_diff_route: { outcome: "request_failed", status } },
        "pull request diff",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : status === 401 ? "unauthenticated" : "bad_request",
      });
    });

    scope.get(
      PULL_REQUEST_DIFF_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const me = callerOf(request);
        // Before anything is read: a member hammering this endpoint costs no token mint and no
        // query (ADR 0034 D8). The limits exist wherever `startServer` built the app.
        if (
          app.rateLimits !== undefined &&
          !(await app.rateLimits.consume(request, reply, "diff", me.memberId))
        ) {
          return reply;
        }
        const target = targetOf(request);
        if (target === null) {
          log(request, "invalid_target", { orgId: me.orgId });
          return json(reply, 400, { error: "invalid_pull_request" });
        }
        if (deps.repositoryAccess === undefined) {
          log(request, "access_check_unavailable", { orgId: me.orgId });
          return json(reply, 503, { error: "access_check_unavailable" });
        }
        if (deps.diffs === undefined) {
          log(request, "diffs_unavailable", { orgId: me.orgId });
          return json(reply, 503, { error: "diffs_unavailable" });
        }
        const row = await db.withOrg(me.orgId, (tx) => loadPullRequestDiffTarget(tx, target));
        if (row === null) {
          log(request, "not_found", { orgId: me.orgId });
          return json(reply, 404, { error: "not_found" });
        }
        const ids = { orgId: me.orgId, pullRequestId: row.pullRequestId };
        const decision = await deps.repositoryAccess.check({
          orgId: me.orgId,
          memberId: me.memberId,
          repositoryId: row.forgeRepoId,
        });
        if (!decision.allowed) {
          log(request, "repository_access_denied", ids);
          // The same answer as an unknown pull request: nothing about a repository they cannot read.
          return json(reply, 404, { error: "not_found" });
        }
        if (row.installationId === null) {
          // No installation to read on behalf of: nothing can be verified (fail closed).
          log(request, "no_installation", ids);
          return json(reply, 404, { error: "not_found" });
        }
        const result = await deps.diffs.read({
          orgId: me.orgId,
          installationId: row.installationId,
          repositoryId: row.forgeRepoId,
          number: target.number,
          headSha: row.headSha,
          baseSha: row.baseSha,
        });
        switch (result.kind) {
          case "diff":
            log(request, "served", {
              ...ids,
              bytes: result.bytes,
              sha256: result.sha256,
              truncation: result.truncation,
              cached: result.cached,
            });
            return json(reply, 200, {
              headSha: result.headSha,
              diff: result.diff,
              truncation: result.truncation,
            });
          case "head_moved":
            log(request, "head_moved", ids);
            return json(reply, 409, { error: "head_moved" });
          case "commits_unavailable":
            log(request, "commits_unavailable", ids);
            return json(reply, 409, { error: "commits_unavailable" });
          case "too_large":
            log(request, "too_large", ids);
            return json(reply, 413, { error: "diff_too_large" });
          case "not_found":
            // The installation lost the repository, or GitHub has no such PR: the mirror's next
            // event or a rebuild says which; the member learns nothing more than "not here".
            log(request, "forge_not_found", ids);
            return json(reply, 404, { error: "not_found" });
          case "forge_failed":
            request.log.warn(
              { pull_diff_route: { outcome: "forge_failed", code: result.code, ...ids } },
              "pull request diff",
            );
            return json(reply, 502, { error: "forge_unavailable" });
        }
      },
    );
  });
};
