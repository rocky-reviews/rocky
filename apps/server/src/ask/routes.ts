import {
  answerQuestion,
  AskSpaceError,
  checkAskRequest,
  isLlmCallError,
  isLlmMeteringError,
  isSameSpace,
  type AskRequest,
  type CodeReader,
  type EmbeddingSpace,
  type LlmRoles,
  type LlmUsageRecord,
  type OrgId,
  type RepositoryAccessCheck,
} from "@rocky-reviews/core";
import {
  codeIndexState,
  loadAskTarget,
  recordLlmUsage,
  searchCodeChunks,
  type CodeIndexState,
  type CodeSearchHit,
  type Db,
} from "@rocky-reviews/db";
import { meterRoles, type LlmUsageTargets } from "@rocky-reviews/llm";
import type { Logger } from "@rocky-reviews/log";
import { limits, RepoName, RepoOwner } from "@rocky-reviews/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";
import { createAskExcerptReader, type AskExcerptReader } from "./excerpt-reader.js";

/**
 * Ask about the pull request (P9-2, ADR 0041): a reviewer's question answered from the
 * repository's index, with citations into the code it was shown.
 *
 *   GET  /api/repos/:owner/:repo/pulls/:number/ask    ask    where the index stands
 *   POST /api/repos/:owner/:repo/pulls/:number/ask    ask    one question, one answer
 *
 * GET answers 200 `{ index }`, one of:
 *
 *   { status: "ready", indexedSha, updating }   searchable; `updating`: a newer run is queued
 *                                               or running (answers come from `indexedSha`)
 *   { status: "indexing" }                      a first index (or one in a new model) is on its way
 *   { status: "not_indexed" }                   no index of this repository in the configured model
 *   { status: "off" }                           Ask is not configured on this instance
 *
 * POST takes `{ question, selection? }` (`selection`: `{ path, startLine, endLine, text }`, code
 * selected in the diff) and answers:
 *
 *   200 { status: "answered", answer, citations: [{ path, startLine, endLine }], indexedSha }
 *   200 { status: "no_answer", reason, note }   `no_context` (nothing readable was found),
 *                                               `model` (the code shown does not say; `note`
 *                                               is the model's), `uncited` (it cited nothing
 *                                               it was shown)
 *   400 invalid_question                        the body is not a question Rocky asks
 *   404 not_found                               as the PR page (unknown, disabled repository,
 *                                               another org's, GitHub access denied)
 *   409 not_indexed | indexing                  nothing to search yet (as GET says)
 *   429 rate_limited                            `limit: "member"` (the `ask` scope) or
 *                                               `limit: "org"` (`ask.org`, `ask.org.day`), with
 *                                               `Retry-After` (ADR 0025, ADR 0042 §3)
 *   502 answer_failed                           the model refused, was cut off or answered
 *                                               invalid output twice (`reason`)
 *   502 model_unavailable                       the provider failed (`retryable`)
 *   502 forge_unavailable                       GitHub did not answer, or not as asked
 *   503 ask_unavailable | access_check_unavailable
 *
 * Order (POST): policy, the member's limit, then the org's two budgets (each counted
 * atomically, so concurrent questions cannot overshoot), the address, the body, the deps that
 * must exist, the row inside `withOrg` (ids only), the P3-6 access check, the index's state,
 * then the flow (`answerQuestion`, packages/core): the question is embedded by the metered embed
 * role, the search runs inside `withOrg` with the org, repository and space filter
 * (`searchCodeChunks`), the hits' lines are read from GitHub on a read-only token for that one
 * repository, revoked after (`excerpt-reader.ts`), and the `ask` role answers. Only citations
 * into lines the model was shown are served; the page builds each link itself, from the
 * repository, `indexedSha` and the citation, never from a URL.
 *
 * Nothing is stored and nothing acts on the answer: it is shown to the person who asked. Every
 * model and embedding call goes through `meterRoles` (P4-5) into `llm_usage`, in its own
 * transaction per call, with the org, repository and pull request (P9-3, migration 0023), a
 * failed call's partial usage included; a usage write that fails after its retries fails the
 * question closed (503), so nothing is spent unmetered. Logs carry ids, counts and fixed
 * outcomes; never the question, the selection, code, paths, the prompt or the answer.
 */

export const ASK_PATH = "/api/repos/:owner/:repo/pulls/:number/ask";
/** A question, a selection and JSON around them fit well inside this. */
export const ASK_BODY_LIMIT = 32 * 1024;

export interface AskDeps {
  /** The roles built from `ROCKY_LLM_*`; the ask and embed roles are used. */
  readonly llm: LlmRoles;
  /** The embed role's space: only an index in this space is searched. */
  readonly space: EmbeddingSpace;
  readonly usageTargets: LlmUsageTargets;
  readonly forge: Pick<CodeReader, "openCode">;
  readonly log: Logger;
  /** Tests: another reader. */
  readonly excerpts?: AskExcerptReader;
  /** Tests: another usage writer (the default writes `llm_usage` inside `withOrg`). */
  readonly recordUsage?: (orgId: OrgId, records: readonly LlmUsageRecord[]) => Promise<void>;
}

export interface AskRoutesDeps {
  readonly db: Pick<Db, "withOrg">;
  readonly repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
  /** Without it (no embedding model configured) Ask is `off`. */
  readonly ask?: AskDeps;
}

export type AskIndexView =
  | { readonly status: "ready"; readonly indexedSha: string; readonly updating: boolean }
  | { readonly status: "indexing" }
  | { readonly status: "not_indexed" }
  | { readonly status: "off" };

/** Where an index stands for Ask, given the configured space (undefined: Ask is off). */
export const askIndexView = (
  index: CodeIndexState | null,
  space: EmbeddingSpace | undefined,
): AskIndexView => {
  if (space === undefined) return { status: "off" };
  if (index === null) return { status: "not_indexed" };
  const moving = index.status === "queued" || index.status === "running";
  if (index.indexedSha !== null && isSameSpace(space, index.space)) {
    return { status: "ready", indexedSha: index.indexedSha, updating: moving };
  }
  return moving ? { status: "indexing" } : { status: "not_indexed" };
};

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

/** The body as a request, or null. Unknown fields are refused. */
const requestOf = (body: unknown): AskRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { question, selection, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof question !== "string") return null;
  let parsed: AskRequest = { question };
  if (selection !== undefined && selection !== null) {
    if (typeof selection !== "object" || Array.isArray(selection)) return null;
    const { path, startLine, endLine, text, ...other } = selection as Record<string, unknown>;
    if (Object.keys(other).length > 0) return null;
    if (
      typeof path !== "string" ||
      typeof startLine !== "number" ||
      typeof endLine !== "number" ||
      typeof text !== "string"
    ) {
      return null;
    }
    parsed = { question, selection: { path, startLine, endLine, text } };
  }
  return checkAskRequest(parsed).ok ? parsed : null;
};

/** A GitHub read failed while the flow ran: answered by the route, never logged with content. */
class ForgeFailure extends Error {
  constructor(
    readonly kind: "not_found" | "forge_failed",
    readonly code: string,
  ) {
    super("ask: forge read failed");
  }
}

/** The limits a question passes before anything is read or spent, in order (ADR 0042 §3). */
const ASK_LIMITS = [
  { scope: "ask", key: "member", limit: "member" },
  { scope: "ask.org", key: "org", limit: "org" },
  { scope: "ask.org.day", key: "org", limit: "org" },
] as const;

export const registerAskRoutes = (app: FastifyInstance, deps: AskRoutesDeps): void => {
  const { db } = deps;
  const excerpts =
    deps.ask === undefined
      ? undefined
      : (deps.ask.excerpts ?? createAskExcerptReader({ forge: deps.ask.forge }));
  // Each call's usage in its own tenant transaction (ADR 0016 §4): it survives whatever happens
  // to the question. Records hold ids, enums and numbers only.
  const recordUsage =
    deps.ask?.recordUsage ??
    ((orgId: OrgId, records: readonly LlmUsageRecord[]) =>
      db.withOrg(orgId, (tx) => recordLlmUsage(tx, records)));

  const log = (
    request: FastifyRequest,
    outcome: string,
    fields: Record<string, string | number | null | boolean> = {},
  ) => request.log.info({ ask_route: { outcome, ...fields } }, "ask");

  /** The row and the access check, shared by both routes; a reply was sent when null. */
  const resolve = async (request: FastifyRequest, reply: FastifyReply, me: ActiveMember) => {
    const target = targetOf(request);
    if (target === null) {
      log(request, "invalid_target", { orgId: me.orgId });
      await json(reply, 400, { error: "invalid_pull_request" });
      return null;
    }
    if (deps.repositoryAccess === undefined) {
      log(request, "access_check_unavailable", { orgId: me.orgId });
      await json(reply, 503, { error: "access_check_unavailable" });
      return null;
    }
    const row = await db.withOrg(me.orgId, (tx) => loadAskTarget(tx, target));
    if (row === null) {
      log(request, "not_found", { orgId: me.orgId });
      await json(reply, 404, { error: "not_found" });
      return null;
    }
    const decision = await deps.repositoryAccess.check({
      orgId: me.orgId,
      memberId: me.memberId,
      repositoryId: row.forgeRepoId,
    });
    if (!decision.allowed) {
      log(request, "repository_access_denied", {
        orgId: me.orgId,
        pullRequestId: row.pullRequestId,
      });
      // The same answer as an unknown pull request: nothing about a repository they cannot read.
      await json(reply, 404, { error: "not_found" });
      return null;
    }
    return row;
  };

  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      request.log[status >= 500 ? "error" : "warn"](
        { ask_route: { outcome: "request_failed", status } },
        "ask",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : status === 401 ? "unauthenticated" : "bad_request",
      });
    });

    scope.get(ASK_PATH, { config: { policy: requires("ask") } }, async (request, reply) => {
      const me = callerOf(request);
      const row = await resolve(request, reply, me);
      if (row === null) return reply;
      const index = askIndexView(row.index, deps.ask?.space);
      log(request, "index_state", {
        orgId: me.orgId,
        pullRequestId: row.pullRequestId,
        index: index.status,
      });
      return json(reply, 200, { index });
    });

    scope.post(
      ASK_PATH,
      { bodyLimit: ASK_BODY_LIMIT, config: { policy: requires("ask") } },
      async (request, reply) => {
        const me = callerOf(request);
        // Before anything is read or spent (ADR 0025, ADR 0042 §3): the member's limit, then
        // the org's burst and day budgets. `consume` counts and checks in one step, so questions
        // in flight at once cannot overshoot a budget; the 429 says which limit it was.
        if (app.rateLimits !== undefined) {
          for (const { scope, key, limit } of ASK_LIMITS) {
            const id = key === "member" ? me.memberId : me.orgId;
            if (!(await app.rateLimits.consume(request, reply, scope, id, { limit }))) {
              log(request, `${limit}_rate_limited`, { orgId: me.orgId });
              return reply;
            }
          }
        }
        if (targetOf(request) === null) {
          log(request, "invalid_target", { orgId: me.orgId });
          return json(reply, 400, { error: "invalid_pull_request" });
        }
        const question = requestOf(request.body);
        if (question === null) {
          log(request, "invalid_question", { orgId: me.orgId });
          return json(reply, 400, { error: "invalid_question" });
        }
        const ask = deps.ask;
        if (ask === undefined || excerpts === undefined) {
          log(request, "ask_unavailable", { orgId: me.orgId });
          return json(reply, 503, { error: "ask_unavailable" });
        }
        const row = await resolve(request, reply, me);
        if (row === null) return reply;
        const ids = { orgId: me.orgId, pullRequestId: row.pullRequestId };
        if (row.installationId === null) {
          log(request, "no_installation", ids);
          return json(reply, 404, { error: "not_found" });
        }
        const index = askIndexView(row.index, ask.space);
        if (index.status !== "ready") {
          log(request, index.status, ids);
          return index.status === "off"
            ? json(reply, 503, { error: "ask_unavailable" })
            : json(reply, 409, { error: index.status });
        }
        const installationId = row.installationId;
        const started = Date.now();
        let blobs = 0;
        const llm = meterRoles(ask.llm, {
          sink: { record: (records) => recordUsage(me.orgId, records) },
          targets: ask.usageTargets,
          log: ask.log,
          repoId: row.repoId,
          pullRequestId: row.pullRequestId,
        });
        const embedding = llm.embedding();
        if (embedding === undefined) {
          log(request, "ask_unavailable", ids);
          return json(reply, 503, { error: "ask_unavailable" });
        }
        let found = 0;
        // Whether the index was still settled at `indexedSha` when the search ran: decided again
        // after the search, in its transaction, not from the state read before the embed call (a
        // push may start a run meanwhile). A run is marked queued or running before it writes a
        // chunk, so a search that returned a chunk of a newer blob is followed by a read that no
        // longer sees `done` at this commit; the hits are then checked against the commit's tree.
        let settled = false;
        try {
          const outcome = await answerQuestion(
            llm,
            {
              embedding,
              space: ask.space,
              search: async (vector, k): Promise<readonly CodeSearchHit[]> => {
                const hits = await db.withOrg(me.orgId, async (tx) => {
                  const nearest = await searchCodeChunks(tx, {
                    repoId: row.repoId,
                    space: ask.space,
                    vector,
                    k,
                  });
                  const now = await codeIndexState(tx, row.repoId);
                  settled = now?.status === "done" && now.indexedSha === index.indexedSha;
                  return nearest;
                });
                found = hits.length;
                return hits;
              },
              read: async (hits) => {
                const result = await excerpts.read(
                  {
                    installationId,
                    repositoryId: row.forgeRepoId,
                    indexedSha: index.indexedSha,
                    verifyAtCommit: !settled,
                  },
                  hits.map((hit) => ({
                    path: hit.path,
                    blobSha: hit.blobSha,
                    startLine: hit.startLine,
                    endLine: hit.endLine,
                  })),
                );
                if (result.kind !== "ok") {
                  throw new ForgeFailure(
                    result.kind,
                    result.kind === "forge_failed" ? result.code : "not_found",
                  );
                }
                blobs = result.blobs;
                return result.sources;
              },
            },
            question,
          );
          const counts = {
            ...ids,
            hits: found,
            blobs,
            ms: Date.now() - started,
          };
          switch (outcome.kind) {
            case "answer":
              log(request, "answered", {
                ...counts,
                excerpts: outcome.excerpts,
                citations: outcome.citations.length,
                dropped: outcome.dropped,
              });
              return json(reply, 200, {
                status: "answered",
                answer: outcome.answer,
                citations: outcome.citations.map((c) => ({
                  path: c.path,
                  startLine: c.start,
                  endLine: c.end,
                })),
                indexedSha: index.indexedSha,
              });
            case "no_answer":
              log(request, "no_answer", {
                ...counts,
                reason: outcome.reason,
                excerpts: outcome.excerpts,
                dropped: outcome.dropped,
              });
              return json(reply, 200, {
                status: "no_answer",
                reason: outcome.reason,
                note: outcome.note,
              });
            case "failed":
              log(request, "answer_failed", { ...counts, reason: outcome.reason });
              return json(reply, 502, { error: "answer_failed", reason: outcome.reason });
          }
        } catch (error) {
          if (error instanceof ForgeFailure) {
            if (error.kind === "not_found") {
              log(request, "forge_not_found", ids);
              return json(reply, 404, { error: "not_found" });
            }
            log(request, "forge_failed", { ...ids, code: error.code });
            return json(reply, 502, { error: "forge_unavailable" });
          }
          if (isLlmCallError(error)) {
            log(request, "model_failed", { ...ids, kind: error.kind });
            return json(reply, 502, { error: "model_unavailable", retryable: error.retryable });
          }
          if (isLlmMeteringError(error)) {
            // The usage could not be written (it was logged as numbers by the meter): no more
            // calls are made for this question, and none is made unmetered (fail closed).
            log(request, "usage_unrecorded", ids);
            return json(reply, 503, { error: "ask_unavailable" });
          }
          if (error instanceof AskSpaceError) {
            log(request, "space_mismatch", ids);
            return json(reply, 503, { error: "ask_unavailable" });
          }
          throw error;
        }
      },
    );
  });
};
