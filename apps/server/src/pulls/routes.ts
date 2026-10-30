import {
  readInboxDocument,
  type RepositoryAccessCheck,
  splitRepoFullName,
} from "@rocky-reviews/core";
import { loadPullRequestPage, type Db, type PullRequestPageRow } from "@rocky-reviews/db";
import { limits, RepoName, RepoOwner } from "@rocky-reviews/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";

/**
 * The PR review page's data (H4-2): the shell's `RawShellData` (apps/web `data/shell-data.ts`,
 * ADR 0019 §3 and its P6-2 amendment) for one pull request, looked up by repository and number.
 *
 *   GET /api/repos/:owner/:repo/pulls/:number      pull_requests.review
 *
 * Answer (200):
 *
 *   {
 *     pullRequestId,               the row id Finish review posts through (ADR 0026)
 *     pull: { owner, repo, number, title, author, state, headSha, updatedAt,
 *             additions, deletions, changedFiles,      null before the head is recorded
 *             headRef, baseRef, approvers, commentCount },  null: the mirror does not hold them
 *     myReview,                    the caller's latest review posted from Rocky, or null
 *     analysis, analysisId,        the latest finished document (the head's, else an older
 *                                  push's), validated and for this very PR; else both null
 *     analysisRun                  where the head's analysis stands (ADR 0019 §3 amendment)
 *   }
 *
 * Who may read: any active member (`pull_requests.review`) **and** GitHub read access to the
 * repository (P3-6). Without the access check the route answers 503; an unknown pull request, a
 * disabled repository, another org's (RLS) and a denied repository are the same 404. Tenant data
 * is read only inside `withOrg`. Nothing here changes anything (a GET, ADR 0024).
 *
 * The document is re-validated here, as the inbox does: one that does not parse, or describes
 * another pull request, is not served (`analysis: null`; when it was the head's own result the
 * run reads `failed` with the fixed code `invalid_document`).
 *
 * Logs carry ids and fixed outcomes; never names, titles, logins or document content.
 */

export const PULL_REQUEST_PAGE_PATH = "/api/repos/:owner/:repo/pulls/:number";

export interface PullRequestPageRoutesDeps {
  readonly db: Pick<Db, "withOrg">;
  /** The repository access check (P3-6); without it the route answers 503. */
  readonly repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
}

/** `analyses.error_code`'s shape (ADR 0019 §3 amendment). */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TOKENS = 1_000_000_000;

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

const MY_REVIEW = {
  approve: "approved",
  request_changes: "changes_requested",
  comment: "commented",
};

const tokens = (value: number | null): number | null =>
  value !== null && Number.isInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : null;

/** The head's run as the page reads it, given whether a document is served. */
const runOf = (row: PullRequestPageRow, served: boolean, invalidHeadDocument: boolean) => {
  const run = row.headRun;
  if (invalidHeadDocument) return { status: "failed", code: "invalid_document" };
  if (run === null) return { status: served ? "done" : "none" };
  switch (run.status) {
    case "queued":
    case "running":
    case "done":
      return { status: run.status === "done" && !served ? "none" : run.status };
    case "awaiting_approval": {
      const estimatedTokens = tokens(run.estimatedTokens);
      const limitTokens = tokens(run.limitTokens);
      // The table guarantees both (0012); without them the page could not say what it waits for.
      return estimatedTokens === null || limitTokens === null
        ? { status: "queued" }
        : { status: "awaiting_approval", estimatedTokens, limitTokens };
    }
    case "failed":
      return {
        status: "failed",
        code: run.errorCode !== null && ERROR_CODE.test(run.errorCode) ? run.errorCode : "unknown",
      };
  }
};

/** The answer for a row the caller may read (see the module comment). */
export const pullRequestPageView = (row: PullRequestPageRow) => {
  const names = splitRepoFullName(row.repoFullName);
  if (names === null) return null;
  const document =
    row.done === null
      ? null
      : readInboxDocument(row.done.document, { ...names, number: row.number });
  const invalidHeadDocument =
    row.done !== null &&
    document === null &&
    row.headRun?.status === "done" &&
    row.headRun.analysisId === row.done.analysisId;
  // A `superseded` head run contradicts a document (the head moved or the PR closed while it ran):
  // the page then shows the run, not an older briefing.
  const superseded = row.headRun?.status === "failed" && row.headRun.errorCode === "superseded";
  const served = document !== null && !superseded;
  const run = runOf(row, served, invalidHeadDocument);
  return {
    pullRequestId: row.pullRequestId,
    pull: {
      owner: names.owner,
      repo: names.name,
      number: row.number,
      title: row.title,
      author: row.authorLogin,
      state: row.state,
      headRef: null,
      baseRef: null,
      headSha: row.headSha,
      additions: row.size?.additions ?? null,
      deletions: row.size?.deletions ?? null,
      changedFiles: row.size?.files ?? null,
      updatedAt: row.updatedAt.toISOString(),
      approvers: null,
      commentCount: null,
    },
    myReview: row.myVerdict === null ? null : MY_REVIEW[row.myVerdict],
    analysis: served ? document : null,
    analysisId: served ? (row.done?.analysisId ?? null) : null,
    analysisRun: run,
  };
};

export const registerPullRequestPageRoutes = (
  app: FastifyInstance,
  deps: PullRequestPageRoutesDeps,
): void => {
  const { db } = deps;

  const log = (request: FastifyRequest, outcome: string, ids: Record<string, string> = {}) =>
    request.log.info({ pull_page: { outcome, ...ids } }, "pull request page");

  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      request.log[status >= 500 ? "error" : "warn"](
        { pull_page: { outcome: "request_failed", status } },
        "pull request page",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : status === 401 ? "unauthenticated" : "bad_request",
      });
    });

    scope.get(
      PULL_REQUEST_PAGE_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const me = callerOf(request);
        const target = targetOf(request);
        if (target === null) {
          log(request, "invalid_target", { orgId: me.orgId });
          return json(reply, 400, { error: "invalid_pull_request" });
        }
        if (deps.repositoryAccess === undefined) {
          log(request, "access_check_unavailable", { orgId: me.orgId });
          return json(reply, 503, { error: "access_check_unavailable" });
        }
        const row = await db.withOrg(me.orgId, (tx) =>
          loadPullRequestPage(tx, { ...target, memberId: me.memberId }),
        );
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
        const view = pullRequestPageView(row);
        if (view === null) {
          log(request, "invalid_repository_name", ids);
          return json(reply, 404, { error: "not_found" });
        }
        log(request, "served", {
          ...ids,
          ...(view.analysisId === null ? {} : { analysisId: view.analysisId }),
          run: view.analysisRun.status,
        });
        return json(reply, 200, view);
      },
    );
  });
};
