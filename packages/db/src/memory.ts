import {
  can,
  isDismissReason,
  isMemoryKind,
  isMemoryOrigin,
  memorySubject,
  prepareMemoryEntry,
  readPullRequestNumber,
  type MemoryEdit,
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

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const isSeverity = (value: string): value is (typeof SEVERITIES)[number] =>
  (SEVERITIES as readonly string[]).includes(value);

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
  severity: string | null;
  created_by: string | null;
  author_login: string | null;
  author_removed: boolean | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  superseded_by: string | null;
  disabled_at: Date | null;
}

const ENTRY_COLUMNS = `e.id, e.repo_id, e.kind, e.origin, e.content, e.evidence_path, e.evidence_sha,
       e.evidence_start, e.evidence_end, e.source_pr_number, e.confidence, e.reason, e.severity,
       e.created_by, m.login as author_login, (m.removed_at is not null) as author_removed,
       e.created_at, e.updated_at, e.last_used_at, e.superseded_by, e.disabled_at`;
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
  const severity = row.severity;
  if (severity !== null && !isSeverity(severity)) {
    throw new MemoryStoreError("memory: unknown severity in a row");
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
    severity,
    author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    supersededBy: row.superseded_by,
    disabledAt: row.disabled_at,
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

/**
 * Serialises creates per repository (the cap below is a count then an insert); learning takes it
 * for its whole run (P8-2 fix round, S4).
 */
export const lockRepoMemory = (tx: TenantTx, repoId: string) =>
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
 * The entries of one repository of this org, newest first: the current ones (switched off or
 * not), or every one with `includeSuperseded`. At most `limit` (default and maximum `MAX_MEMORY_LISTING`).
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
      order by (e.superseded_by is null) desc, e.created_at desc, e.id desc
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
 *
 * `origin: "learned"` (P8-2): learning replaces an older learned entry with a newer one about
 * the same pattern, in the name of the reviewer whose posted review taught it. Like a learned
 * create, it needs an active member, not `memory.edit`, and both rows must be learned entries
 * (`not_permitted` otherwise): learning never replaces what a person wrote.
 */
export const supersedeMemoryEntry = async (
  tx: TenantTx,
  input: {
    readonly actorMemberId: string;
    readonly entryId: string;
    readonly byEntryId: string;
    readonly origin?: "member" | "learned";
  },
): Promise<SupersedeMemoryEntryResult> => {
  const learned = input.origin === "learned";
  const actor = uuid(input.actorMemberId, "actor id");
  const entryId = uuid(input.entryId, "entry id");
  const byEntryId = uuid(input.byEntryId, "entry id");
  if (entryId === byEntryId) return "self";
  const role = await activeRole(tx, actor);
  if (role === null) return "not_a_member";
  if (!learned && !can(role, "memory.edit")) return "not_permitted";
  // Both rows locked in id order (no deadlock between two concurrent supersedes).
  const { rows } = await tx.query<{
    id: string;
    repo_id: string;
    superseded_by: string | null;
    origin: string;
  }>(
    `select id, repo_id, superseded_by, origin from memory_entries
      where org_id = $1 and id = any($2::uuid[]) order by id for update`,
    [tx.orgId, [entryId, byEntryId]],
  );
  const source = rows.find((r) => r.id === entryId);
  const target = rows.find((r) => r.id === byEntryId);
  if (source === undefined || target === undefined) return "not_found";
  if (source.repo_id !== target.repo_id) return "different_repo";
  if (learned && (source.origin !== "learned" || target.origin !== "learned"))
    return "not_permitted";
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
  // Sorted: one lock order against every other writer of these rows (P8-4 fix round 2).
  const ids = [...new Set(entryIds.map((id) => uuid(id, "entry id")))].sort();
  if (ids.length === 0) return 0;
  const { rowCount } = await tx.query(
    `update memory_entries set last_used_at = now()
      where org_id = $1 and id = any($2::uuid[])`,
    [tx.orgId, ids],
  );
  return rowCount ?? 0;
};

// ---------- P8-3: the memory page (ADR 0039) ----------

/** A repository of this org as the memory page names it (`owner/name`). */
export interface MemoryRepository {
  readonly repoId: string;
  /** What the repository access check (P3-6) is asked about. */
  readonly forgeRepoId: number;
  /** As stored (the forge's spelling). */
  readonly fullName: string;
  readonly memoryEnabled: boolean;
}

/** The mirror's repository name rule (`mirror.ts`). */
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * An enabled repository of this org by `owner/name` (case-insensitively, as GitHub treats it),
 * or `null`. The caller runs the access check on `forgeRepoId` before reading anything else.
 */
export const findMemoryRepository = async (
  tx: TenantTx,
  fullName: string,
): Promise<MemoryRepository | null> => {
  if (typeof fullName !== "string" || !FULL_NAME.test(fullName)) {
    throw new MemoryStoreError("memory: invalid repository name");
  }
  const { rows } = await tx.query<{
    id: string;
    forge_repo_id: string;
    full_name: string;
    memory_enabled: boolean;
  }>(
    `select id, forge_repo_id::text as forge_repo_id, full_name, memory_enabled from repos
      where org_id = $1 and lower(full_name) = lower($2) and enabled`,
    [tx.orgId, fullName],
  );
  const row = rows[0];
  const forgeRepoId = Number(row?.forge_repo_id);
  if (row === undefined || rows.length !== 1 || !Number.isSafeInteger(forgeRepoId)) return null;
  return {
    repoId: row.id,
    forgeRepoId,
    fullName: row.full_name,
    memoryEnabled: row.memory_enabled,
  };
};

/**
 * Every current entry of one repository (switched off or not), oldest first, for the export to
 * `.rocky/context.md`: all of them, not a page (bounded by `MAX_MEMORY_ENTRIES_PER_REPO`), in an
 * order that adds a new entry at the end of its group, so a re-export changes little.
 */
export const listMemoryEntriesForExport = async (
  tx: TenantTx,
  repoId: string,
): Promise<MemoryEntry[]> => {
  const { rows } = await tx.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from ${ENTRY_JOIN}
      where e.org_id = $1 and e.repo_id = $2 and e.superseded_by is null
      order by e.created_at, e.id
      limit $3`,
    [tx.orgId, uuid(repoId, "repository id"), MAX_MEMORY_ENTRIES_PER_REPO],
  );
  return rows.map(viewOf);
};

/** How many entries one repository holds, current and superseded. */
export const countMemoryEntries = async (tx: TenantTx, repoId: string): Promise<number> => {
  const { rows } = await tx.query<{ n: string }>(
    "select count(*)::text as n from memory_entries where org_id = $1 and repo_id = $2",
    [tx.orgId, uuid(repoId, "repository id")],
  );
  return Number(rows[0]?.n ?? 0);
};

/** `null` when the actor may edit memory here; the refusal otherwise (row locked `FOR SHARE`). */
const editorRefusal = async (
  tx: TenantTx,
  actor: string,
): Promise<"not_a_member" | "not_permitted" | null> => {
  const role = await activeRole(tx, actor);
  if (role === null) return "not_a_member";
  return can(role, "memory.edit") ? null : "not_permitted";
};

interface LockedEntry {
  id: string;
  repo_id: string;
  kind: string;
  confidence: number;
  severity: string | null;
  evidence_path: string;
  evidence_sha: string;
  evidence_start: number;
  evidence_end: number;
  source_pr_number: number;
  superseded_by: string | null;
  disabled_at: Date | null;
  learner_role: string | null;
  learned_subject: string | null;
  origin: string;
  content: string;
}

/**
 * The entry locked `FOR UPDATE`, after its repository's memory lock (the order learning takes
 * them in, so the two never deadlock); `null` when this org has no such entry.
 */
const lockEntry = async (tx: TenantTx, entryId: string): Promise<LockedEntry | null> => {
  const found = await tx.query<{ repo_id: string }>(
    "select repo_id from memory_entries where org_id = $1 and id = $2",
    [tx.orgId, entryId],
  );
  const repoId = found.rows[0]?.repo_id;
  if (repoId === undefined) return null;
  await lockRepoMemory(tx, repoId);
  const { rows } = await tx.query<LockedEntry>(
    `select id, repo_id, kind, confidence, severity, evidence_path, evidence_sha, evidence_start,
            evidence_end, source_pr_number, superseded_by, disabled_at, learner_role,
            learned_subject, origin, content
       from memory_entries where org_id = $1 and id = $2 for update`,
    [tx.orgId, entryId],
  );
  return rows[0] ?? null;
};

export type EditMemoryEntryResult =
  | { readonly outcome: "edited"; readonly entry: MemoryEntry; readonly scrubbed: number }
  | { readonly outcome: "invalid"; readonly problem: MemoryEntryProblem }
  | { readonly outcome: "not_found" }
  /** Only the current entry of a chain can be edited. */
  | { readonly outcome: "already_superseded" }
  | { readonly outcome: "not_a_member" }
  | { readonly outcome: "not_permitted" }
  | { readonly outcome: "unknown_repo" }
  | { readonly outcome: "repo_full" };

/**
 * Edits a current entry the way ADR 0036 §4 asks: a new member-written entry (`origin:
 * "member"`, written by the actor, scrubbed and checked by `createMemoryEntry`) with the edited
 * kind, text and reason and the old entry's evidence and confidence, that supersedes the old one,
 * so history is kept. A dismissal that stays a dismissal keeps the severity it covers; the new
 * entry is switched off when the old one was, and keeps the old one's learned subject and learner
 * role, so learning still matches it and its precedence holds whatever the new text says (P8-3
 * fix round 2). Needs `memory.edit`, re-checked here.
 */
export const editMemoryEntry = async (
  tx: TenantTx,
  input: { readonly actorMemberId: string; readonly entryId: string; readonly edit: MemoryEdit },
): Promise<EditMemoryEntryResult> => {
  const actor = uuid(input.actorMemberId, "actor id");
  const entryId = uuid(input.entryId, "entry id");
  const refusal = await editorRefusal(tx, actor);
  if (refusal !== null) return { outcome: refusal };
  const old = await lockEntry(tx, entryId);
  if (old === null) return { outcome: "not_found" };
  if (old.superseded_by !== null) return { outcome: "already_superseded" };
  const { edit } = input;
  const created = await createMemoryEntry(tx, {
    authorMemberId: actor,
    repoId: old.repo_id,
    origin: "member",
    entry: {
      kind: edit.kind,
      text: edit.text,
      reason: edit.reason,
      evidence: {
        path: old.evidence_path,
        sha: old.evidence_sha,
        range: { start: old.evidence_start, end: old.evidence_end },
        pullRequestNumber: old.source_pr_number,
      },
      confidence: old.confidence,
    },
  });
  if (created.outcome !== "created") return created;
  const severity = edit.kind === "dismissal" && old.kind === "dismissal" ? old.severity : null;
  // The same decision keeps its role; a changed kind is the editor's decision, not the learner's
  // (fix round 4). A row learned before 0020 gets its subject here (TypeScript is its source).
  const learnerRole = edit.kind === old.kind ? old.learner_role : await activeRole(tx, actor);
  const subject =
    old.learned_subject ?? (old.origin === "learned" ? memorySubject(old.content) : null);
  await tx.query(
    `update memory_entries
        set severity = $3, disabled_at = $4, learner_role = $5, learned_subject = $6
      where org_id = $1 and id = $2`,
    [tx.orgId, created.entry.id, severity, old.disabled_at, learnerRole, subject],
  );
  const superseded = await supersedeMemoryEntry(tx, {
    actorMemberId: actor,
    entryId,
    byEntryId: created.entry.id,
  });
  // Both rows are locked and checked above; anything else is a bug, and the transaction rolls back.
  if (superseded !== "superseded") throw new MemoryStoreError("memory: edit not applied");
  const entry = await loadMemoryEntry(tx, created.entry.id);
  if (entry === null) throw new MemoryStoreError("memory: entry not stored");
  return { outcome: "edited", entry, scrubbed: created.scrubbed };
};

export type DeleteMemoryEntryResult =
  | { readonly outcome: "deleted"; readonly deleted: number }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "not_a_member" }
  | { readonly outcome: "not_permitted" };

/**
 * Deletes an entry **and every older version of it** (the entries that were superseded into it,
 * transitively). Deleting only the entry would make the version before it current again
 * (`superseded_by … ON DELETE SET NULL`, ADR 0036 residual risks), which would bring back what
 * the person meant to remove. Newer versions of a superseded entry stay. Embeddings of the rows
 * go with them (cascade). Needs `memory.edit`, re-checked here. Audited `memory.deleted` with the
 * id, the repository and the count.
 */
export const deleteMemoryEntry = async (
  tx: TenantTx,
  input: { readonly actorMemberId: string; readonly entryId: string },
): Promise<DeleteMemoryEntryResult> => {
  const actor = uuid(input.actorMemberId, "actor id");
  const entryId = uuid(input.entryId, "entry id");
  const refusal = await editorRefusal(tx, actor);
  if (refusal !== null) return { outcome: refusal };
  const entry = await lockEntry(tx, entryId);
  if (entry === null) return { outcome: "not_found" };
  // `union` (not `union all`) ends even on a loop a crafted update could close (review nit 6).
  const { rowCount } = await tx.query(
    `with recursive chain(id) as (
       select id from memory_entries where org_id = $1 and id = $2
       union
       select e.id from memory_entries e join chain c on e.superseded_by = c.id
        where e.org_id = $1
     )
     delete from memory_entries where org_id = $1 and id in (select id from chain)`,
    [tx.orgId, entryId],
  );
  const deleted = rowCount ?? 0;
  await audit(
    tx,
    { type: "user", id: actor },
    "memory.deleted",
    { type: "memory_entry", id: entryId },
    { repoId: entry.repo_id, deleted },
  );
  return { outcome: "deleted", deleted };
};

export type SwitchMemoryEntryResult =
  | { readonly outcome: "switched"; readonly entry: MemoryEntry }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "already_superseded" }
  | { readonly outcome: "not_a_member" }
  | { readonly outcome: "not_permitted" };

/**
 * Switches a current entry off (`disabled: true`: kept and shown, never offered to a review, and
 * learning does not store the same pattern again beside it) or back on. Needs `memory.edit`,
 * re-checked here. Audited `memory.disabled` / `memory.enabled` when it changes.
 */
export const setMemoryEntryDisabled = async (
  tx: TenantTx,
  input: { readonly actorMemberId: string; readonly entryId: string; readonly disabled: boolean },
): Promise<SwitchMemoryEntryResult> => {
  const actor = uuid(input.actorMemberId, "actor id");
  const entryId = uuid(input.entryId, "entry id");
  if (typeof input.disabled !== "boolean") throw new MemoryStoreError("memory: disabled flag");
  const refusal = await editorRefusal(tx, actor);
  if (refusal !== null) return { outcome: refusal };
  const entry = await lockEntry(tx, entryId);
  if (entry === null) return { outcome: "not_found" };
  if (entry.superseded_by !== null) return { outcome: "already_superseded" };
  if ((entry.disabled_at !== null) !== input.disabled) {
    await tx.query(
      `update memory_entries
          set disabled_at = case when $3 then now() else null end,
              enabled_at = case when $3 then enabled_at else now() end, updated_at = now()
        where org_id = $1 and id = $2`,
      [tx.orgId, entryId, input.disabled],
    );
    await audit(
      tx,
      { type: "user", id: actor },
      input.disabled ? "memory.disabled" : "memory.enabled",
      { type: "memory_entry", id: entryId },
      { repoId: entry.repo_id },
    );
  }
  const view = await loadMemoryEntry(tx, entryId);
  if (view === null) throw new MemoryStoreError("memory: entry gone");
  return { outcome: "switched", entry: view };
};

export type SwitchRepoMemoryResult = "switched" | "not_found" | "not_a_member" | "not_permitted";

/**
 * Whether reviews of the repository use project memory (`enabled: false`: no entry is offered to
 * a review and nothing is learned; the entries stay). Needs `memory.edit`, re-checked here, and
 * takes the repository's memory lock so a learner in flight finishes first. Audited
 * `memory.repo_disabled` / `memory.repo_enabled` when it changes.
 */
export const setRepoMemoryEnabled = async (
  tx: TenantTx,
  input: { readonly actorMemberId: string; readonly repoId: string; readonly enabled: boolean },
): Promise<SwitchRepoMemoryResult> => {
  const actor = uuid(input.actorMemberId, "actor id");
  const repoId = uuid(input.repoId, "repository id");
  if (typeof input.enabled !== "boolean") throw new MemoryStoreError("memory: enabled flag");
  const refusal = await editorRefusal(tx, actor);
  if (refusal !== null) return refusal;
  await lockRepoMemory(tx, repoId);
  const { rows } = await tx.query<{ memory_enabled: boolean }>(
    "select memory_enabled from repos where org_id = $1 and id = $2 for update",
    [tx.orgId, repoId],
  );
  const current = rows[0]?.memory_enabled;
  if (current === undefined) return "not_found";
  if (current !== input.enabled) {
    await tx.query(
      "update repos set memory_enabled = $3, updated_at = now() where org_id = $1 and id = $2",
      [tx.orgId, repoId, input.enabled],
    );
    // Switched on again: the time off does not count as idle for P8-4's decay (fix round 4).
    // `updated_at` is left alone: it is the history window's clock for superseded rows.
    if (input.enabled)
      await tx.query(
        `update memory_entries set enabled_at = now()
          where org_id = $1 and repo_id = $2 and superseded_by is null`,
        [tx.orgId, repoId],
      );
    await audit(
      tx,
      { type: "user", id: actor },
      input.enabled ? "memory.repo_enabled" : "memory.repo_disabled",
      { type: "repo", id: repoId },
      {},
    );
  }
  return "switched";
};
