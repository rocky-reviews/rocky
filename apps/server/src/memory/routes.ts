import {
  can,
  MEMORY_EXPORT_FILENAME,
  parseMemoryEdit,
  parseMemorySwitch,
  renderMemoryContext,
  type MemoryEntry,
  type RepositoryAccessCheck,
} from "@rocky-reviews/core";
import {
  countMemoryEntries,
  deleteMemoryEntry,
  editMemoryEntry,
  findMemoryRepository,
  listMemoryEntries,
  listMemoryEntriesForExport,
  loadMemoryEntry,
  MAX_MEMORY_LISTING,
  setMemoryEntryDisabled,
  setRepoMemoryEnabled,
  type Db,
  type MemoryRepository,
  type TenantTx,
} from "@rocky-reviews/db";
import { RepoName, RepoOwner } from "@rocky-reviews/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requires } from "../auth/policy.js";
import type { ActiveMember } from "../auth/routes.js";

/**
 * The project memory page's API (P8-3, ADR 0038), per repository, by its GitHub name:
 *
 *   GET    /api/repos/:owner/:repo/memory                          pull_requests.review
 *   GET    /api/repos/:owner/:repo/memory/export                   pull_requests.review
 *   PUT    /api/repos/:owner/:repo/memory/enabled   { enabled }     memory.edit
 *   POST   /api/repos/:owner/:repo/memory/entries/:entryId/edit
 *                                             { kind, text, reason? }  memory.edit
 *   PUT    /api/repos/:owner/:repo/memory/entries/:entryId/disabled { disabled }  memory.edit
 *   DELETE /api/repos/:owner/:repo/memory/entries/:entryId          memory.edit
 *
 * Any member who may review the repository reads its memory (the entries are shown to them in
 * reviews already) and downloads the export; editing, deleting and switching need `memory.edit`
 * (admins and owners, ADR 0024), which the policy checks on the route and the store re-checks in
 * the writing transaction. Every route also needs GitHub read access to the repository (P3-6):
 * without the access check the routes answer 503, and a denied repository is the same 404 as an
 * unknown one. An entry id names an entry **of the repository in the path**, or it is not found:
 * access to one repository never reaches another's entries.
 *
 * The export is a download (`Content-Disposition: attachment; filename="context.md"`,
 * `text/markdown`): the person commits it themselves. Rocky writes no file on its disk and
 * nothing to the repository. The response gets the non-document CSP like any API answer.
 *
 * Logs carry ids, fixed outcomes and counts; never entry text, paths or logins. Store errors are
 * reduced to a SQLSTATE (P8-1 review nit 11: Postgres echoes row values in `detail`).
 */

export const MEMORY_PATH = "/api/repos/:owner/:repo/memory";
export const MEMORY_EXPORT_PATH = "/api/repos/:owner/:repo/memory/export";
export const MEMORY_ENABLED_PATH = "/api/repos/:owner/:repo/memory/enabled";
export const MEMORY_ENTRY_PATH = "/api/repos/:owner/:repo/memory/entries/:entryId";
export const MEMORY_ENTRY_EDIT_PATH = "/api/repos/:owner/:repo/memory/entries/:entryId/edit";
export const MEMORY_ENTRY_DISABLED_PATH =
  "/api/repos/:owner/:repo/memory/entries/:entryId/disabled";

export interface MemoryRoutesDeps {
  readonly db: Pick<Db, "withOrg">;
  /** The repository access check (P3-6); without it every route here answers 503. */
  readonly repositoryAccess?: Pick<RepositoryAccessCheck, "check">;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const json = (reply: FastifyReply, status: number, body?: unknown) =>
  reply.code(status).header("cache-control", "no-store").send(body);

const callerOf = (request: FastifyRequest): ActiveMember => {
  const member = request.access?.member;
  if (member === undefined) throw Object.assign(new Error("no member"), { statusCode: 401 });
  return member;
};

const params = (request: FastifyRequest): Record<string, unknown> =>
  (request.params ?? {}) as Record<string, unknown>;

/** `owner/name` from the path, when both pass GitHub's rules; else `null`. */
const repoNameOf = (request: FastifyRequest): string | null => {
  const owner = RepoOwner.safeParse(params(request)["owner"]);
  const repo = RepoName.safeParse(params(request)["repo"]);
  if (!owner.success || !repo.success || [".", ".."].includes(repo.data)) return null;
  return `${owner.data}/${repo.data}`;
};

const entryIdOf = (request: FastifyRequest): string | null => {
  const value = params(request)["entryId"];
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
};

/** One entry as the page reads it (`MemoryEntryView`): the author by login, never by id. */
export const memoryEntryJson = (e: MemoryEntry) => ({
  id: e.id,
  kind: e.kind,
  origin: e.origin,
  text: e.text,
  reason: e.reason,
  severity: e.severity,
  evidence: {
    path: e.evidence.path,
    sha: e.evidence.sha,
    range: { start: e.evidence.range.start, end: e.evidence.range.end },
    pullRequestNumber: e.evidence.pullRequestNumber,
  },
  confidence: e.confidence,
  author:
    e.author.kind === "member"
      ? { kind: "member" as const, login: e.author.login }
      : { kind: "former_member" as const },
  createdAt: e.createdAt.toISOString(),
  lastUsedAt: e.lastUsedAt?.toISOString() ?? null,
  supersededBy: e.supersededBy,
  disabledAt: e.disabledAt?.toISOString() ?? null,
});

/** The `Content-Disposition` of the export: a fixed file name, nothing from the request. */
export const MEMORY_EXPORT_DISPOSITION = `attachment; filename="${MEMORY_EXPORT_FILENAME}"`;

export const registerMemoryRoutes = (app: FastifyInstance, deps: MemoryRoutesDeps): void => {
  const { db } = deps;

  const log = (
    request: FastifyRequest,
    action: string,
    outcome: string,
    fields: Record<string, string | number> = {},
  ) => request.log.info({ memory: { action, outcome, ...fields } }, "memory");

  /**
   * The caller and the repository the path names, once it is found in the caller's org and
   * GitHub lets the caller read it; otherwise the reply has been sent and `null` returned.
   */
  const authorise = async (request: FastifyRequest, reply: FastifyReply, action: string) => {
    const me = callerOf(request);
    const name = repoNameOf(request);
    if (name === null) {
      log(request, action, "invalid_repository", { orgId: me.orgId });
      await json(reply, 400, { error: "invalid_repository" });
      return null;
    }
    if (deps.repositoryAccess === undefined) {
      log(request, action, "access_check_unavailable", { orgId: me.orgId });
      await json(reply, 503, { error: "access_check_unavailable" });
      return null;
    }
    const repo = await db.withOrg(me.orgId, (tx) => findMemoryRepository(tx, name));
    if (repo === null) {
      log(request, action, "not_found", { orgId: me.orgId });
      await json(reply, 404, { error: "not_found" });
      return null;
    }
    const ids = { orgId: me.orgId, repoId: repo.repoId };
    const decision = await deps.repositoryAccess.check({
      orgId: me.orgId,
      memberId: me.memberId,
      repositoryId: repo.forgeRepoId,
    });
    if (!decision.allowed) {
      log(request, action, "repository_access_denied", ids);
      // The same answer as an unknown repository: nothing about one they cannot read.
      await json(reply, 404, { error: "not_found" });
      return null;
    }
    return { me, repo, ids };
  };

  /** Runs `fn` on the path's entry when it belongs to the path's repository; `null` otherwise. */
  const onEntry = <T>(
    tx: TenantTx,
    repo: MemoryRepository,
    entryId: string,
    fn: () => Promise<T>,
  ): Promise<T | null> =>
    loadMemoryEntry(tx, entryId).then((entry) =>
      entry === null || entry.repoId !== repo.repoId ? null : fn(),
    );

  void app.register(async (scope) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const raw = (error as { statusCode?: unknown }).statusCode;
      const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
      const code = (error as { code?: unknown }).code;
      request.log[status >= 500 ? "error" : "warn"](
        {
          memory: {
            outcome: "request_failed",
            status,
            ...(typeof code === "string" && SQLSTATE.test(code) ? { errorCode: code } : {}),
          },
        },
        "memory",
      );
      return json(reply, status, {
        error: status >= 500 ? "internal" : status === 401 ? "unauthenticated" : "bad_request",
      });
    });

    scope.get(
      MEMORY_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const ok = await authorise(request, reply, "list");
        if (ok === null) return reply;
        const { entries, total } = await db.withOrg(ok.me.orgId, async (tx) => ({
          entries: await listMemoryEntries(tx, {
            repoId: ok.repo.repoId,
            includeSuperseded: true,
            limit: MAX_MEMORY_LISTING,
          }),
          total: await countMemoryEntries(tx, ok.repo.repoId),
        }));
        const [owner = "", name = ""] = ok.repo.fullName.split("/");
        log(request, "list", "served", { ...ok.ids, entries: entries.length });
        return json(reply, 200, {
          repository: { owner, name, memoryEnabled: ok.repo.memoryEnabled },
          canEdit: can(ok.me.role, "memory.edit"),
          entries: entries.map(memoryEntryJson),
          truncated: total > entries.length,
        });
      },
    );

    scope.get(
      MEMORY_EXPORT_PATH,
      { config: { policy: requires("pull_requests.review") } },
      async (request, reply) => {
        const ok = await authorise(request, reply, "export");
        if (ok === null) return reply;
        const entries = await db.withOrg(ok.me.orgId, (tx) =>
          listMemoryEntriesForExport(tx, ok.repo.repoId),
        );
        const { markdown, exported, dropped } = renderMemoryContext({
          repository: ok.repo.fullName,
          entries: entries.map((e) => ({
            kind: e.kind,
            origin: e.origin,
            text: e.text,
            reason: e.reason,
            severity: e.severity,
            evidence: e.evidence,
            confidence: e.confidence,
            disabled: e.disabledAt !== null,
          })),
        });
        log(request, "export", "served", { ...ok.ids, exported, dropped });
        return reply
          .code(200)
          .header("cache-control", "no-store")
          .header("content-type", "text/markdown; charset=utf-8")
          .header("content-disposition", MEMORY_EXPORT_DISPOSITION)
          .send(markdown);
      },
    );

    scope.put(
      MEMORY_ENABLED_PATH,
      { config: { policy: requires("memory.edit") } },
      async (request, reply) => {
        const enabled = parseMemorySwitch(request.body, "enabled");
        if (enabled === null) return json(reply, 400, { error: "invalid_request" });
        const ok = await authorise(request, reply, "switch_repo");
        if (ok === null) return reply;
        const outcome = await db.withOrg(ok.me.orgId, (tx) =>
          setRepoMemoryEnabled(tx, {
            actorMemberId: ok.me.memberId,
            repoId: ok.repo.repoId,
            enabled,
          }),
        );
        log(request, "switch_repo", outcome, ok.ids);
        switch (outcome) {
          case "switched":
            return json(reply, 200, { memoryEnabled: enabled });
          case "not_permitted":
          case "not_a_member":
            return json(reply, 403, { error: "forbidden" });
          case "not_found":
            return json(reply, 404, { error: "not_found" });
        }
      },
    );

    scope.post(
      MEMORY_ENTRY_EDIT_PATH,
      { config: { policy: requires("memory.edit") } },
      async (request, reply) => {
        const entryId = entryIdOf(request);
        if (entryId === null) return json(reply, 400, { error: "invalid_entry" });
        const edit = parseMemoryEdit(request.body);
        if (edit === null) return json(reply, 400, { error: "invalid_request" });
        const ok = await authorise(request, reply, "edit");
        if (ok === null) return reply;
        const result = await db.withOrg(ok.me.orgId, (tx) =>
          onEntry(tx, ok.repo, entryId, () =>
            editMemoryEntry(tx, { actorMemberId: ok.me.memberId, entryId, edit }),
          ),
        );
        const outcome = result?.outcome ?? "not_found";
        log(request, "edit", outcome, {
          ...ok.ids,
          entryId,
          ...(result?.outcome === "edited" ? { scrubbed: result.scrubbed } : {}),
        });
        switch (result?.outcome) {
          case "edited":
            return json(reply, 200, { entry: memoryEntryJson(result.entry) });
          case "invalid":
            return json(reply, 400, { error: "invalid_entry_text", problem: result.problem });
          case "already_superseded":
            return json(reply, 409, { error: "already_superseded" });
          case "repo_full":
            return json(reply, 409, { error: "repo_full" });
          case "not_permitted":
          case "not_a_member":
            return json(reply, 403, { error: "forbidden" });
          default:
            return json(reply, 404, { error: "not_found" });
        }
      },
    );

    scope.put(
      MEMORY_ENTRY_DISABLED_PATH,
      { config: { policy: requires("memory.edit") } },
      async (request, reply) => {
        const entryId = entryIdOf(request);
        if (entryId === null) return json(reply, 400, { error: "invalid_entry" });
        const disabled = parseMemorySwitch(request.body, "disabled");
        if (disabled === null) return json(reply, 400, { error: "invalid_request" });
        const ok = await authorise(request, reply, "switch_entry");
        if (ok === null) return reply;
        const result = await db.withOrg(ok.me.orgId, (tx) =>
          onEntry(tx, ok.repo, entryId, () =>
            setMemoryEntryDisabled(tx, { actorMemberId: ok.me.memberId, entryId, disabled }),
          ),
        );
        log(request, "switch_entry", result?.outcome ?? "not_found", { ...ok.ids, entryId });
        switch (result?.outcome) {
          case "switched":
            return json(reply, 200, { entry: memoryEntryJson(result.entry) });
          case "already_superseded":
            return json(reply, 409, { error: "already_superseded" });
          case "not_permitted":
          case "not_a_member":
            return json(reply, 403, { error: "forbidden" });
          default:
            return json(reply, 404, { error: "not_found" });
        }
      },
    );

    scope.delete(
      MEMORY_ENTRY_PATH,
      { config: { policy: requires("memory.edit") } },
      async (request, reply) => {
        const entryId = entryIdOf(request);
        if (entryId === null) return json(reply, 400, { error: "invalid_entry" });
        const ok = await authorise(request, reply, "delete");
        if (ok === null) return reply;
        const result = await db.withOrg(ok.me.orgId, (tx) =>
          onEntry(tx, ok.repo, entryId, () =>
            deleteMemoryEntry(tx, { actorMemberId: ok.me.memberId, entryId }),
          ),
        );
        log(request, "delete", result?.outcome ?? "not_found", {
          ...ok.ids,
          entryId,
          ...(result?.outcome === "deleted" ? { deleted: result.deleted } : {}),
        });
        switch (result?.outcome) {
          case "deleted":
            return json(reply, 200, { deleted: result.deleted });
          case "not_permitted":
          case "not_a_member":
            return json(reply, 403, { error: "forbidden" });
          default:
            return json(reply, 404, { error: "not_found" });
        }
      },
    );
  });
};
