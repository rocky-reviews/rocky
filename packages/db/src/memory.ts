import {
  can,
  isDismissReason,
  isMemoryKind,
  isMemoryOrigin,
  prepareMemoryEntry,
  readPullRequestNumber,
  type MemoryEntry,
  type MemoryEntryProblem,
  type MemoryOrigin,
} from "@rocky-reviews/core";
import { audit } from "./audit.js";
import type { TenantTx } from "./client.js";

/**
 * Project memory entries (P8-1, migration 0017, ADR 0036). Every function runs in the caller's
 * `withOrg` transaction (RLS keeps it to that org; the explicit `org_id` filters are defence in
 * depth) and acts for one member, whose id comes from the server's session, never from the
 * request.
 *
 * `createMemoryEntry` is the only writer of entry text. It scrubs personal identifiers with the
 * people Rocky knows about here (the author of the source pull request and every member login
 * of the org, active or removed, first; the caller's list after) and applies core's rules.
 * Nothing about a person is stored but the author's member id; the reader derives "former
 * member" from the member row (gone, or removed) at read time.
 *
 * Who may write is re-checked in the writing transaction with the actor's row locked `FOR
 * SHARE` (the T37 precedent): a member-written entry and a supersede need `memory.edit`
 * (admins and owners, ADR 0024); a learned entry needs its author to be an active member (any
 * role can dismiss a draft). A removal or demotion racing the write is seen, not raced. The
 * origin is the caller's parameter, never read from the untrusted entry.
 *
 * Results are fixed codes; errors carry no values (entry text is derived from PR content and
 * reviewer text: neither belongs in an error or a log).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MemoryStoreError extends Error {
  override readonly name = "MemoryStoreError";
}

const uuid = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new MemoryStoreError(`memory: ${what} must be a uuid`);
  }
  return value.toLowerCase();
};

/** Entries one repository may hold (current and superseded). A ceiling, not a budget (P8-4). */
export const MAX_MEMORY_ENTRIES_PER_REPO = 5000;
/** Most entries one listing returns. */
export const MAX_MEMORY_LISTING = 500;
/** Most ids one touch may carry (a review cites far fewer, schema `MAX_MEMORY_APPLIED`). */
export const MAX_MEMORY_TOUCH = 500;

interface EntryRow {
  id: string;
  repo_id: string;
  kind: string;
  origin: string;
  content: string;
  evidence_path: string;
  evidence_sha: string;
  evidence_start: number;
  evidence_end: number;
  source_pr_number: number;
  confidence: number;
  reason: string | null;
  created_by: string | null;
  author_login: string | null;
  author_removed: boolean | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  superseded_by: string | null;
}

const ENTRY_COLUMNS = `e.id, e.repo_id, e.kind, e.origin, e.content, e.evidence_path, e.evidence_sha,
       e.evidence_start, e.evidence_end, e.source_pr_number, e.confidence, e.reason, e.created_by,
       m.login as author_login, (m.removed_at is not null) as author_removed,
       e.created_at, e.updated_at, e.last_used_at, e.superseded_by`;
const ENTRY_JOIN = `memory_entries e
  left join members m on m.org_id = e.org_id and m.id = e.created_by`;

const viewOf = (row: EntryRow): MemoryEntry => {
  if (!isMemoryKind(row.kind) || !isMemoryOrigin(row.origin)) {
    throw new MemoryStoreError("memory: unknown kind or origin in a row");
  }
  const reason = row.reason;
  if (reason !== null && !isDismissReason(reason)) {
    throw new MemoryStoreError("memory: unknown reason in a row");
  }
  // The author while the member row exists and is not removed; "former member" otherwise.
  const author: MemoryEntry["author"] =
    row.created_by !== null && row.author_login !== null && row.author_removed === false
      ? { kind: "member", memberId: row.created_by, login: row.author_login }
      : { kind: "former_member" };
  return {
    id: row.id,
    repoId: row.repo_id,
    kind: row.kind,
    origin: row.origin,
    text: row.content,
    evidence: {
      path: row.evidence_path,
      sha: row.evidence_sha,
      range: { start: row.evidence_start, end: row.evidence_end },
      pullRequestNumber: row.source_pr_number,
    },
    confidence: row.confidence,
    reason,
    author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    supersededBy: row.superseded_by,
  };
};

/**
 * The actor's role while they are an active member here, read `FOR SHARE` so it cannot change
 * under this transaction; `null` when they are not one.
 */
const activeRole = async (tx: TenantTx, memberId: string): Promise<string | null> => {
  const { rows } = await tx.query<{ role: string }>(
    "select role from members where org_id = $1 and id = $2 and removed_at is null for share",
    [tx.orgId, memberId],
  );
  return rows[0]?.role ?? null;
};

/** Serialises creates per repository (the cap below is a count then an insert). */
const lockRepoMemory = (tx: TenantTx, repoId: string) =>
  tx.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
    `rocky.memory:${tx.orgId}:${repoId}`,
  ]);

export type CreateMemoryEntryResult =
  | {
      readonly outcome: "created";
      readonly entry: MemoryEntry;
      /** Personal identifiers replaced in the text (a count, never what they were). */
      readonly scrubbed: number;
    }
  | { readonly outcome: "invalid"; readonly problem: MemoryEntryProblem }
  | { readonly outcome: "unknown_repo" }
  /** The author is not an active member of this org. */
  | { readonly outcome: "not_a_member" }
  /** A member-written entry needs `memory.edit` (re-checked here, with the row locked). */
  | { readonly outcome: "not_permitted" }
  | { readonly outcome: "repo_full" };

/**
 * Stores one entry for `repoId`, written by `authorMemberId` (an active member of this org, as
 * the session says), from the untrusted `entry` (core `prepareMemoryEntry`). `origin` is the
 * caller's: `member` (a person writes it; needs `memory.edit`) or `learned` (P8-2 derives it
 * from the author's own decision). `people` are logins or names the caller saw around the
 * evidence (commenters, reviewers); the source PR's author and the org's member logins always
 * come first. Audited `memory.created` with ids and counts.
 */
export const createMemoryEntry = async (
  tx: TenantTx,
  input: {
    readonly authorMemberId: string;
    readonly repoId: string;
    readonly origin: MemoryOrigin;
    readonly entry: unknown;
    readonly people?: readonly string[];
  },
): Promise<CreateMemoryEntryResult> => {
  const author = uuid(input.authorMemberId, "author id");
  const repoId = uuid(input.repoId, "repository id");
  if (!isMemoryOrigin(input.origin)) throw new MemoryStoreError("memory: unknown origin");
  const role = await activeRole(tx, author);
  if (role === null) return { outcome: "not_a_member" };
  if (input.origin === "member" && !can(role, "memory.edit")) return { outcome: "not_permitted" };
  const repo = await tx.query("select 1 from repos where org_id = $1 and id = $2", [
    tx.orgId,
    repoId,
  ]);
  if (repo.rowCount !== 1) return { outcome: "unknown_repo" };

  // The people Rocky knows first, so a long caller list can never push them out (the scrubber
  // refuses a list past its cap rather than shortening it; core answers `too_many_people`).
  const people: string[] = [];
  const pullRequestNumber = readPullRequestNumber(input.entry);
  if (pullRequestNumber !== null) {
    const pr = await tx.query<{ author_login: string | null }>(
      "select author_login from pull_requests where org_id = $1 and repo_id = $2 and number = $3",
      [tx.orgId, repoId, pullRequestNumber],
    );
    const login = pr.rows[0]?.author_login;
    if (typeof login === "string") people.push(login);
  }
  const members = await tx.query<{ login: string }>("select login from members where org_id = $1", [
    tx.orgId,
  ]);
  for (const m of members.rows) people.push(m.login);
  people.push(...(input.people ?? []));

  const prepared = prepareMemoryEntry(input.entry, { origin: input.origin, people });
  if (!prepared.ok) return { outcome: "invalid", problem: prepared.problem };
  const { draft } = prepared;

  await lockRepoMemory(tx, repoId);
  const count = await tx.query<{ n: string }>(
    "select count(*)::text as n from memory_entries where org_id = $1 and repo_id = $2",
    [tx.orgId, repoId],
  );
  if (Number(count.rows[0]?.n) >= MAX_MEMORY_ENTRIES_PER_REPO) return { outcome: "repo_full" };

  const inserted = await tx.query<{ id: string }>(
    `insert into memory_entries
       (repo_id, kind, origin, content, evidence_path, evidence_sha, evidence_start, evidence_end,
        source_pr_number, confidence, reason, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      repoId,
      draft.kind,
      draft.origin,
      draft.text,
      draft.evidence.path,
      draft.evidence.sha,
      draft.evidence.range.start,
      draft.evidence.range.end,
      draft.evidence.pullRequestNumber,
      draft.confidence,
      draft.reason,
      author,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new MemoryStoreError("memory: entry not stored");
  const scrubbed = prepared.scrubbed.total;
  await audit(
    tx,
    { type: "user", id: author },
    "memory.created",
    { type: "memory_entry", id },
    { kind: draft.kind, origin: draft.origin, repoId, scrubbed },
  );
  const entry = await loadMemoryEntry(tx, id);
  if (entry === null) throw new MemoryStoreError("memory: entry not stored");
  return { outcome: "created", entry, scrubbed };
};

/** One entry of this org by id, or `null`. */
export const loadMemoryEntry = async (
  tx: TenantTx,
  entryId: string,
): Promise<MemoryEntry | null> => {
  const id = uuid(entryId, "entry id");
  const { rows } = await tx.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from ${ENTRY_JOIN} where e.org_id = $1 and e.id = $2`,
    [tx.orgId, id],
  );
  const row = rows[0];
  return row === undefined ? null : viewOf(row);
};

/**
 * The entries of one repository of this org, newest first: the current ones, or every one with
 * `includeSuperseded`. At most `limit` (default and maximum `MAX_MEMORY_LISTING`).
 */
export const listMemoryEntries = async (
  tx: TenantTx,
  input: {
    readonly repoId: string;
    readonly includeSuperseded?: boolean;
    readonly limit?: number;
  },
): Promise<MemoryEntry[]> => {
  const repoId = uuid(input.repoId, "repository id");
  const limit = input.limit ?? MAX_MEMORY_LISTING;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_LISTING) {
    throw new MemoryStoreError(`memory: limit must be an integer in 1..${MAX_MEMORY_LISTING}`);
  }
  const { rows } = await tx.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from ${ENTRY_JOIN}
      where e.org_id = $1 and e.repo_id = $2 and ($3 or e.superseded_by is null)
      order by e.created_at desc, e.id desc
      limit $4`,
    [tx.orgId, repoId, input.includeSuperseded === true, limit],
  );
  return rows.map(viewOf);
};

export type SupersedeMemoryEntryResult =
  | "superseded"
  | "not_found"
  | "self"
  /** The source or the target is no longer current (which also keeps chains from looping). */
  | "already_superseded"
  | "different_repo"
  /** The actor is not an active member of this org. */
  | "not_a_member"
  /** The actor lacks `memory.edit` (re-checked here, with their row locked). */
  | "not_permitted";

/**
 * Marks `entryId` as replaced by `byEntryId` (both current entries of the same repository of
 * this org), with both rows locked, for an actor who holds `memory.edit` here. The old entry stays as history and leaves the default
 * listing. Audited `memory.superseded` with ids only.
 */
export const supersedeMemoryEntry = async (
  tx: TenantTx,
  input: {
    readonly actorMemberId: string;
    readonly entryId: string;
    readonly byEntryId: string;
  },
): Promise<SupersedeMemoryEntryResult> => {
  const actor = uuid(input.actorMemberId, "actor id");
  const entryId = uuid(input.entryId, "entry id");
  const byEntryId = uuid(input.byEntryId, "entry id");
  if (entryId === byEntryId) return "self";
  const role = await activeRole(tx, actor);
  if (role === null) return "not_a_member";
  if (!can(role, "memory.edit")) return "not_permitted";
  // Both rows locked in id order (no deadlock between two concurrent supersedes).
  const { rows } = await tx.query<{ id: string; repo_id: string; superseded_by: string | null }>(
    `select id, repo_id, superseded_by from memory_entries
      where org_id = $1 and id = any($2::uuid[]) order by id for update`,
    [tx.orgId, [entryId, byEntryId]],
  );
  const source = rows.find((r) => r.id === entryId);
  const target = rows.find((r) => r.id === byEntryId);
  if (source === undefined || target === undefined) return "not_found";
  if (source.repo_id !== target.repo_id) return "different_repo";
  if (source.superseded_by !== null || target.superseded_by !== null) return "already_superseded";
  await tx.query(
    `update memory_entries set superseded_by = $3, updated_at = now()
      where org_id = $1 and id = $2`,
    [tx.orgId, entryId, byEntryId],
  );
  await audit(
    tx,
    { type: "user", id: actor },
    "memory.superseded",
    { type: "memory_entry", id: entryId },
    { by: byEntryId, repoId: source.repo_id },
  );
  return "superseded";
};

/**
 * Records that a review cited these entries now (`last_used_at`, the database clock). Ids of
 * other orgs or unknown ids are ignored; returns how many rows moved. At most
 * `MAX_MEMORY_TOUCH` ids.
 */
export const touchMemoryEntries = async (
  tx: TenantTx,
  entryIds: readonly string[],
): Promise<number> => {
  if (entryIds.length > MAX_MEMORY_TOUCH) {
    throw new MemoryStoreError(`memory: at most ${MAX_MEMORY_TOUCH} entries per touch`);
  }
  const ids = [...new Set(entryIds.map((id) => uuid(id, "entry id")))];
  if (ids.length === 0) return 0;
  const { rowCount } = await tx.query(
    `update memory_entries set last_used_at = now()
      where org_id = $1 and id = any($2::uuid[])`,
    [tx.orgId, ids],
  );
  return rowCount ?? 0;
};
