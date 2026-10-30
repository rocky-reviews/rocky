import {
  assessPullRequest,
  BulkApproveRequest,
  type BulkApproveOutcome,
  type BulkApproveRefusal,
  type InboxFacts,
  type InboxItem,
  MAX_INBOX_ITEMS,
  type PullRequestApprover,
  readInboxDocument,
  type RepositoryAccessCheck,
  sortInbox,
  splitRepoFullName,
} from "@rocky-reviews/core";
import {
  listInboxRows,
  loadInboxRows,
  memberLogin,
  type Db,
  type InboxRow,
} from "@rocky-reviews/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";

/**
 * The review inbox API (P6-7, ADR 0029).
 *
 *   GET  /api/inbox                              pull_requests.review
 *   POST /api/inbox/approvals {pullRequests}     pull_requests.review   (CSRF-checked)
 *
 * The list holds only pull requests of repositories GitHub lets the member read (the P3-6 check,
 * asked once per repository; a denied repository is left out, as if it did not exist), each
 * assessed by `assessPullRequest` (packages/core) from the stored, re-validated analysis.
 *
 * An approval happens only here, on a signed-in member's CSRF-checked POST naming each pull
 * request and the commit the person saw. Nothing in the inbox data triggers it: the "safe to
 * bulk-approve" group is a suggestion the person confirms per batch. Before anything is
 * approved, every pull request is re-read and re-assessed inside the member's org; if any one is
 * unknown or unreadable (404), has moved to another commit or no longer qualifies (409), the
 * whole batch is refused and nothing is approved. Then each is passed to the
 * `PullRequestApprover` port (P3-5 fills it: the review is the member's own, on GitHub). Without
 * the port or the access check both routes fail closed (503).
 *
 * Logs carry ids, counts and fixed outcomes; never titles, logins or bodies.
 */

export const INBOX_PATH = "/api/inbox";
export const APPROVALS_PATH = "/api/inbox/approvals";

export interface InboxRoutesDeps {
  readonly db: Pick<Db, "withOrg">;
  readonly repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
  readonly approver?: PullRequestApprover;
}

/** Access checks run at once at most (each may cost GitHub requests on a cache miss). */
const ACCESS_CONCURRENCY = 4;

const json = (reply: FastifyReply, status: number, body?: unknown) =>
  reply.code(status).header("cache-control", "no-store").send(body);

const callerOf = (request: FastifyRequest): ActiveMember => {
  const member = request.access?.member;
  if (member === undefined) throw Object.assign(new Error("no member"), { statusCode: 401 });
  return member;
};

const factsOf = (
  row: InboxRow,
  viewerLogin: string | null,
  repo: { owner: string; name: string },
) =>
  ({
    state: row.state,
    headSha: row.headSha,
    authorLogin: row.authorLogin,
    viewerLogin,
    size: row.size,
    diffIncomplete: row.diffIncomplete,
    analysis:
      row.analysis === null
        ? null
        : {
            status: row.analysis.status,
            headSha: row.analysis.headSha,
            document: readInboxDocument(row.analysis.document, { ...repo, number: row.number }),
          },
  }) satisfies InboxFacts;

/** The wire item, or `null` for a row whose stored names do not pass the forge's rules. */
const itemOf = (row: InboxRow, viewerLogin: string | null): InboxItem | null => {
  const repo = splitRepoFullName(row.repoFullName);
  if (repo === null) return null;
  const assessment = assessPullRequest(factsOf(row, viewerLogin, repo));
  return {
    id: row.pullRequestId,
    repo,
    number: row.number,
    title: row.title,
    author: row.authorLogin,
    headSha: row.headSha,
    updatedAt: row.updatedAt.toISOString(),
    size: row.size,
    risk: assessment.risk,
    analysis: assessment.analysis,
    findings: assessment.findings,
    estimatedMinutes: assessment.estimatedMinutes,
    bulkApproval: {
      eligible: assessment.bulkApproval.eligible,
      blockers: [...assessment.bulkApproval.blockers],
    },
  };
};

/** The forge repository ids among `rows` that the member may read (P3-6). */
const readableRepos = async (
  access: Pick<RepositoryAccessCheck, "check">,
  me: ActiveMember,
  rows: readonly InboxRow[],
): Promise<Set<number>> => {
  const pending = [...new Set(rows.map((r) => r.forgeRepoId))];
  const readable = new Set<number>();
  const worker = async () => {
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      const decision = await access.check({
        orgId: me.orgId,
        memberId: me.memberId,
        repositoryId: id,
      });
      if (decision.allowed) readable.add(id);
    }
  };
  await Promise.all(Array.from({ length: ACCESS_CONCURRENCY }, worker));
  return readable;
};

export const registerInboxRoutes = (app: FastifyInstance, deps: InboxRoutesDeps): void => {
  const { db } = deps;
  /** Members with a batch in flight in this process (a double submit is refused, not queued). */
  const inFlight = new Set<string>();

  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      request.log[status >= 500 ? "error" : "warn"](
        { inbox: { outcome: "request_failed", status } },
        "inbox",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : status === 401 ? "unauthenticated" : "bad_request",
      });
    });

    scope.get(
      INBOX_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const me = callerOf(request);
        if (deps.repositoryAccess === undefined) {
          request.log.warn({ inbox: { outcome: "access_check_unavailable" } }, "inbox");
          return json(reply, 503, { error: "access_check_unavailable" });
        }
        const { rows, truncated, viewer } = await db.withOrg(me.orgId, async (tx) => ({
          ...(await listInboxRows(tx, { limit: MAX_INBOX_ITEMS })),
          viewer: await memberLogin(tx, me.memberId),
        }));
        const readable = await readableRepos(deps.repositoryAccess, me, rows);
        const items = rows
          .filter((row) => readable.has(row.forgeRepoId))
          .map((row) => itemOf(row, viewer))
          .filter((item) => item !== null);
        request.log.info(
          {
            inbox: {
              outcome: "listed",
              orgId: me.orgId,
              items: items.length,
              hidden: rows.length - items.length,
              offered: items.filter((i) => i.bulkApproval.eligible).length,
            },
          },
          "inbox",
        );
        return json(reply, 200, { items: sortInbox(items), truncated });
      },
    );

    scope.post(
      APPROVALS_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const me = callerOf(request);
        const log = (outcome: string, extra: Record<string, number | string> = {}) =>
          request.log.info(
            { bulk_approve: { outcome, orgId: me.orgId, memberId: me.memberId, ...extra } },
            "bulk approve",
          );
        const parsed = BulkApproveRequest.safeParse(request.body);
        if (!parsed.success) {
          log("invalid_batch");
          return json(reply, 400, { error: "invalid_batch" });
        }
        const batch = parsed.data.pullRequests;
        if (deps.approver === undefined || deps.repositoryAccess === undefined) {
          log("unavailable");
          return json(reply, 503, {
            error: deps.approver === undefined ? "approve_unavailable" : "access_check_unavailable",
          });
        }
        const key = `${me.orgId}:${me.memberId}`;
        if (inFlight.has(key)) {
          log("in_progress");
          return json(reply, 409, { error: "batch_in_progress" });
        }
        inFlight.add(key);
        try {
          return await approveBatch(reply, me, batch, deps.approver, deps.repositoryAccess, log);
        } finally {
          inFlight.delete(key);
        }
      },
    );
  });

  const approveBatch = async (
    reply: FastifyReply,
    me: ActiveMember,
    batch: BulkApproveRequest["pullRequests"],
    approver: PullRequestApprover,
    access: Pick<RepositoryAccessCheck, "check">,
    log: (outcome: string, extra?: Record<string, number | string>) => void,
  ) => {
    const { rows, viewer } = await db.withOrg(me.orgId, async (tx) => ({
      rows: await loadInboxRows(
        tx,
        batch.map((p) => p.id),
      ),
      viewer: await memberLogin(tx, me.memberId),
    }));
    const byId = new Map(rows.map((r) => [r.pullRequestId, r]));
    const readable = await readableRepos(access, me, rows);
    // Unknown, another org's (RLS) or unreadable on GitHub: all look the same.
    if (batch.some((p) => !readable.has(byId.get(p.id)?.forgeRepoId ?? -1))) {
      log("not_found", { size: batch.length });
      return json(reply, 404, { error: "not_found" });
    }
    const refusals: { id: string; reason: BulkApproveRefusal }[] = [];
    for (const pick of batch) {
      const row = byId.get(pick.id);
      if (row === undefined || row.headSha !== pick.headSha) {
        refusals.push({ id: pick.id, reason: "head_moved" });
        continue;
      }
      const item = itemOf(row, viewer);
      if (item === null || !item.bulkApproval.eligible) {
        refusals.push({ id: pick.id, reason: "not_eligible" });
      }
    }
    if (refusals.length > 0) {
      log("refused", { size: batch.length, refused: refusals.length });
      return json(reply, 409, { error: "batch_refused", refusals });
    }

    const results: { id: string; outcome: BulkApproveOutcome }[] = [];
    for (const pick of batch) {
      let outcome: BulkApproveOutcome;
      try {
        outcome = await approver.approve({
          orgId: me.orgId,
          memberId: me.memberId,
          pullRequestId: pick.id,
          headSha: pick.headSha,
        });
      } catch {
        // The error may carry forge text; only the outcome is kept.
        outcome = "failed";
      }
      results.push({ id: pick.id, outcome });
      log(outcome, { pullRequestId: pick.id });
    }
    return json(reply, 200, { results });
  };
};
