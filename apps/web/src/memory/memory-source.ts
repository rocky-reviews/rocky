/**
 * The memory page's port (P8-3, ADR 0039) and its two sources: the server's API
 * (`/api/repos/:owner/:repo/memory…`) and the fixture (development and tests). Like the inbox's
 * sources, `load` hands over unchecked JSON: the page runs it through `parseMemoryList`, so no
 * source can skip validation. Entry text stays untrusted: rendered as text, never as HTML.
 *
 * The changes (edit, switch off, delete, the repository switch) answer a fixed outcome; the page
 * loads the list again after one that worked, so what it shows is always the server's state.
 * The export is a plain download link to the server (`exportHref`): no blob, no script.
 */
import { MemoryListResponse, type MemoryEdit, type MemoryEntryView } from "@rocky-reviews/core";
import { RepoName, RepoOwner } from "@rocky-reviews/schema";
import { CSRF_HEADER, fetchSession } from "../session.js";
import { MEMORY_FIXTURE } from "./fixtures.js";

export interface MemoryRepoRef {
  readonly owner: string;
  readonly repo: string;
}

export type MemoryChange =
  | { readonly kind: "ok" }
  /** The store refused the text (a fixed problem code, never the text). */
  | { readonly kind: "invalid_text" }
  /** Someone changed the entry first (it is no longer current). */
  | { readonly kind: "conflict" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" }
  | { readonly kind: "error" };

export interface MemorySource {
  load(repo: MemoryRepoRef, options?: { signal?: AbortSignal }): Promise<unknown>;
  edit(repo: MemoryRepoRef, entryId: string, edit: MemoryEdit): Promise<MemoryChange>;
  setDisabled(repo: MemoryRepoRef, entryId: string, disabled: boolean): Promise<MemoryChange>;
  remove(repo: MemoryRepoRef, entryId: string): Promise<MemoryChange>;
  setEnabled(repo: MemoryRepoRef, enabled: boolean): Promise<MemoryChange>;
  /** The download address of `.rocky/context.md` (the server's export route). */
  exportHref(repo: MemoryRepoRef): string;
}

export class MemoryLoadError extends Error {
  override readonly name = "MemoryLoadError";
  constructor(readonly reason: "signed_out" | "not_found" | "unavailable" | "failed") {
    super(`memory: ${reason}`);
  }
}

/** Validates what a source loaded. Messages name fields, never values (they are PR content). */
export const parseMemoryList = (raw: unknown): MemoryListResponse => {
  const parsed = MemoryListResponse.safeParse(raw);
  if (!parsed.success) throw new MemoryLoadError("failed");
  return parsed.data;
};

/** `/api/repos/<owner>/<repo>/memory`, from names that pass GitHub's rules; else `null`. */
export const memoryApiPath = (ref: MemoryRepoRef): string | null => {
  const owner = RepoOwner.safeParse(ref.owner);
  const repo = RepoName.safeParse(ref.repo);
  if (!owner.success || !repo.success || [".", ".."].includes(repo.data)) return null;
  return `/api/repos/${encodeURIComponent(owner.data)}/${encodeURIComponent(repo.data)}/memory`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const changeOf = (status: number, body: unknown): MemoryChange => {
  if (status >= 200 && status < 300) return { kind: "ok" };
  const error =
    typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  if (status === 400 && error === "invalid_entry_text") return { kind: "invalid_text" };
  if (status === 409) return { kind: "conflict" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found" };
  return { kind: "error" };
};

/** The server's memory API, same origin, with the session's CSRF token on every change. */
export const createHttpMemorySource = (): MemorySource => {
  const change = async (
    repo: MemoryRepoRef,
    method: "POST" | "PUT" | "DELETE",
    suffix: string,
    body?: unknown,
  ): Promise<MemoryChange> => {
    const base = memoryApiPath(repo);
    if (base === null) return { kind: "not_found" };
    try {
      const session = await fetchSession();
      if (session === null) return { kind: "error" };
      const response = await fetch(`${base}${suffix}`, {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          [CSRF_HEADER]: session.csrfToken,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return changeOf(response.status, await response.json().catch(() => null));
    } catch {
      return { kind: "error" };
    }
  };
  const entry = (entryId: string): string | null =>
    UUID.test(entryId) ? `/entries/${entryId}` : null;

  return {
    load: async (repo, options) => {
      const path = memoryApiPath(repo);
      if (path === null) throw new MemoryLoadError("not_found");
      const response = await fetch(path, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (response.status === 401) throw new MemoryLoadError("signed_out");
      if (response.status === 404 || response.status === 400)
        throw new MemoryLoadError("not_found");
      // 503 until the server can check repository access (P3-6).
      if (response.status === 503) throw new MemoryLoadError("unavailable");
      if (!response.ok) throw new MemoryLoadError("failed");
      return response.json() as Promise<unknown>;
    },
    edit: (repo, entryId, edit) => {
      const path = entry(entryId);
      return path === null
        ? Promise.resolve({ kind: "not_found" })
        : change(repo, "POST", `${path}/edit`, {
            kind: edit.kind,
            text: edit.text,
            ...(edit.reason === null ? {} : { reason: edit.reason }),
          });
    },
    setDisabled: (repo, entryId, disabled) => {
      const path = entry(entryId);
      return path === null
        ? Promise.resolve({ kind: "not_found" })
        : change(repo, "PUT", `${path}/disabled`, { disabled });
    },
    remove: (repo, entryId) => {
      const path = entry(entryId);
      return path === null ? Promise.resolve({ kind: "not_found" }) : change(repo, "DELETE", path);
    },
    setEnabled: (repo, enabled) => change(repo, "PUT", "/enabled", { enabled }),
    exportHref: (repo) => `${memoryApiPath(repo) ?? "/api/repos/-/-/memory"}/export`,
  };
};

type FixtureEntry = MemoryEntryView;

/**
 * The fixture memory. Changes are applied to a copy in this tab only (a stand-in: nothing is
 * stored anywhere). `canEdit: false` shows the page as a member sees it.
 */
export const createFixtureMemorySource = (options: { canEdit?: boolean } = {}): MemorySource => {
  let memoryEnabled = MEMORY_FIXTURE.repository.memoryEnabled;
  let entries: FixtureEntry[] = parseMemoryList(structuredClone(MEMORY_FIXTURE)).entries;
  let next = 100;
  const canEdit = options.canEdit ?? true;
  const allowed = (fn: () => MemoryChange): Promise<MemoryChange> =>
    Promise.resolve(canEdit ? fn() : { kind: "forbidden" });
  const current = (entryId: string) =>
    entries.find((e) => e.id === entryId && e.supersededBy === null);
  return {
    load: async () => ({
      ...MEMORY_FIXTURE,
      repository: { ...MEMORY_FIXTURE.repository, memoryEnabled },
      canEdit,
      entries,
    }),
    edit: (_repo, entryId, edit) =>
      allowed(() => {
        const old = current(entryId);
        if (old === undefined) return { kind: "conflict" };
        const id = `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
        const edited: FixtureEntry = {
          ...old,
          id,
          kind: edit.kind,
          origin: "member",
          text: edit.text.replace(/\s+/gu, " ").trim(),
          reason: edit.reason,
          severity: edit.kind === "dismissal" && old.kind === "dismissal" ? old.severity : null,
          author: { kind: "member", login: "sam-r" },
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        };
        entries = [
          edited,
          ...entries.map((e) => (e.id === entryId ? { ...e, supersededBy: id } : e)),
        ];
        return { kind: "ok" };
      }),
    setDisabled: (_repo, entryId, disabled) =>
      allowed(() => {
        if (current(entryId) === undefined) return { kind: "conflict" };
        entries = entries.map((e) =>
          e.id === entryId ? { ...e, disabledAt: disabled ? new Date().toISOString() : null } : e,
        );
        return { kind: "ok" };
      }),
    remove: (_repo, entryId) =>
      allowed(() => {
        const gone = new Set([entryId]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const e of entries) {
            if (e.supersededBy !== null && gone.has(e.supersededBy) && !gone.has(e.id)) {
              gone.add(e.id);
              grew = true;
            }
          }
        }
        entries = entries.filter((e) => !gone.has(e.id));
        return { kind: "ok" };
      }),
    setEnabled: (_repo, enabled) =>
      allowed(() => {
        memoryEnabled = enabled;
        return { kind: "ok" };
      }),
    exportHref: (repo) => `${memoryApiPath(repo) ?? "/api/repos/-/-/memory"}/export`,
  };
};
