import type { MemoryEntry } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type TenantTx } from "./client.js";
import { beginOrgErasure, scheduleOrgDeletion } from "./installations.js";
import {
  createMemoryEntry,
  listMemoryEntries,
  loadMemoryEntry,
  MAX_MEMORY_ENTRIES_PER_REPO,
  MAX_MEMORY_LISTING,
  MAX_MEMORY_TOUCH,
  MemoryStoreError,
  supersedeMemoryEntry,
  touchMemoryEntries,
} from "./memory.js";
import { removeMember, restoreMember } from "./members.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P8-1 (migration 0017, ADR 0036): memory entries on a real Postgres as the application role.
 * The acceptance criteria and the threat model: every create goes through the scrubber with the
 * org's member logins and the PR author (P2, P4); a deleted or removed member shows as "former
 * member" (P2); another org's rows do not exist (P1); supersede chains cannot loop (P6); the
 * per-repository cap holds (P5); the database refuses what core refuses (P8); audit rows carry
 * ids and counts only (P7); erasing the org removes entries and embeddings (P11).
 */

const SHA = "c".repeat(40);
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

let pgs: TestPostgres;
let pool: pg.Pool;
let superuser: pg.Pool;
let db: Db;
let worker: Db;
let A: SeededOrg;
let B: SeededOrg;
let nextForgeId = 70_000;

beforeAll(async () => {
  pgs = await startPostgres();
  pool = new pg.Pool({ connectionString: pgs.appUrl, max: 6 }).on("error", ignoreIdleError);
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  db = createDb({ pool });
  worker = createDb({ connectionString: pgs.workerUrl, max: 2 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 71 }),
    await seedOrg(w, newOrgId(), { installationId: 72 }),
  ]);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

const pgError = async (promise: Promise<unknown>): Promise<pg.DatabaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    if (error instanceof Error && error.cause instanceof pg.DatabaseError) return error.cause;
    throw error;
  }
  throw new Error("expected the query to fail");
};

const entryInput = (patch: Record<string, unknown> = {}) => ({
  kind: "convention",
  origin: "member",
  text: "Use the shared validator for emails.",
  evidence: {
    path: "src/invite.ts",
    sha: SHA,
    range: { start: 10, end: 12 },
    pullRequestNumber: 847,
  },
  confidence: 80,
  ...patch,
});

const create = (org: SeededOrg, patch: Record<string, unknown> = {}, people: string[] = []) =>
  db.withOrg(org.orgId, (tx) =>
    createMemoryEntry(tx, {
      authorMemberId: org.memberId,
      repoId: org.repoId,
      entry: entryInput(patch),
      people,
    }),
  );

const created = async (
  org: SeededOrg,
  patch: Record<string, unknown> = {},
  people: string[] = [],
): Promise<MemoryEntry> => {
  const result = await create(org, patch, people);
  if (result.outcome !== "created") throw new Error(`expected created, got ${result.outcome}`);
  return result.entry;
};

const addMember = (org: SeededOrg, login: string) =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into members (forge_user_id, login, role) values ($1, $2, 'member') returning id",
      [nextForgeId++, login],
    );
    return rows[0]!.id;
  });

const addRepo = (org: SeededOrg) =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into repos (forge_repo_id, full_name) values ($1, $2) returning id",
      [nextForgeId++, `org/repo-${nextForgeId}`],
    );
    return rows[0]!.id;
  });

/** Superuser view (bypasses RLS): the stored text of one entry. */
const storedText = async (entryId: string): Promise<string | undefined> => {
  const { rows } = await superuser.query<{ content: string }>(
    "select content from public.memory_entries where id = $1",
    [entryId],
  );
  return rows[0]?.content;
};

const auditRows = (org: SeededOrg, action: string) =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{
      actor_id: string;
      target_id: string;
      metadata: Record<string, unknown>;
    }>(
      "select actor_id, target_id, metadata from audit_events where org_id = $1 and action = $2 order by id",
      [tx.orgId, action],
    );
    return rows;
  });

describe("createMemoryEntry", () => {
  it("stores a scrubbed entry with its evidence and answers the view", async () => {
    const before = (await auditRows(A, "memory.created")).length;
    const result = await create(A, { text: "  Use the shared   validator; thanks Carol " });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.entry).toMatchObject({
      repoId: A.repoId,
      kind: "convention",
      origin: "member",
      text: "Use the shared validator; thanks [person]",
      evidence: {
        path: "src/invite.ts",
        sha: SHA,
        range: { start: 10, end: 12 },
        pullRequestNumber: 847,
      },
      confidence: 80,
      reason: null,
      author: { kind: "member", memberId: A.memberId, login: "alice" },
      lastUsedAt: null,
      supersededBy: null,
    });
    expect(result.entry.createdAt).toBeInstanceOf(Date);
    expect(result.scrubbed).toBe(1);
    expect(await storedText(result.entry.id)).toBe("Use the shared validator; thanks [person]");
    // Audited with ids and counts only (P7).
    const rows = await auditRows(A, "memory.created");
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toEqual({
      actor_id: A.memberId,
      target_id: result.entry.id,
      metadata: { kind: "convention", origin: "member", repoId: A.repoId, scrubbed: 1 },
    });
  });

  it("always scrubs every member login of the org, active or removed, and the caller's people (P2, P4)", async () => {
    const removedId = await addMember(A, "gone-person");
    await db.withOrg(A.orgId, (tx) =>
      removeMember(tx, { actorMemberId: A.memberId, targetMemberId: removedId }),
    );
    const entry = await created(
      A,
      { text: "alice and Gone-Person agreed with @octocat, see dana" },
      ["dana"],
    );
    expect(entry.text).toBe("[person] and [person] agreed with [user], see [person]");
    expect(await storedText(entry.id)).not.toMatch(/alice|gone-person|octocat|dana/i);
  });

  it("scrubs the author login of the source pull request (P2)", async () => {
    // The fixture's PR #847 was opened by `alice`; a PR the mirror does not know adds nothing.
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update pull_requests set author_login = 'pr-author-x' where number = 847"),
    );
    const entry = await created(A, { text: "pr-author-x prefers the legacy path" });
    expect(entry.text).toBe("[person] prefers the legacy path");
    const unknownPr = await created(A, {
      text: "pr-author-y prefers the legacy path",
      evidence: { ...entryInput().evidence, pullRequestNumber: 999 },
    });
    // Not a member, not the author of a mirrored PR: the generic rules decide ("prefers" is a
    // speech verb, but a lower-case login is not a capitalised name).
    expect(unknownPr.text).toBe("pr-author-y prefers the legacy path");
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update pull_requests set author_login = 'alice' where number = 847"),
    );
  });

  it("stores a dismissal with its reason and a learned origin", async () => {
    const entry = await created(A, {
      kind: "dismissal",
      origin: "learned",
      reason: "intentional",
      text: "Explicit any in the test helpers is intentional.",
      confidence: 60,
    });
    expect(entry).toMatchObject({ kind: "dismissal", origin: "learned", reason: "intentional" });
    expect(await loadMemoryEntryAs(A, entry.id)).toEqual(entry);
  });

  it("answers the core problem codes without storing anything", async () => {
    for (const [patch, problem] of [
      [{ kind: "note" }, "invalid_kind"],
      [{ text: "" }, "invalid_text"],
      [{ text: "x".repeat(301) }, "text_too_long"],
      [{ text: "see rk-canary-0" }, "invalid_text"],
      [{ evidence: { ...entryInput().evidence, sha: "nope" } }, "invalid_sha"],
      [{ confidence: 101 }, "invalid_confidence"],
      [{ kind: "dismissal" }, "invalid_reason"],
    ] as const) {
      const result = await create(A, patch);
      expect(result).toEqual({ outcome: "invalid", problem });
    }
  });

  it("refuses an author who is not an active member here, and a repository that is not this org's", async () => {
    const removedId = await addMember(A, "leaver");
    await db.withOrg(A.orgId, (tx) =>
      removeMember(tx, { actorMemberId: A.memberId, targetMemberId: removedId }),
    );
    const removed = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, { authorMemberId: removedId, repoId: A.repoId, entry: entryInput() }),
    );
    expect(removed).toEqual({ outcome: "not_a_member" });
    const foreignMember = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, { authorMemberId: B.memberId, repoId: A.repoId, entry: entryInput() }),
    );
    expect(foreignMember).toEqual({ outcome: "not_a_member" });
    const foreignRepo = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, { authorMemberId: A.memberId, repoId: B.repoId, entry: entryInput() }),
    );
    expect(foreignRepo).toEqual({ outcome: "unknown_repo" });
    const notUuid = db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, { authorMemberId: "alice", repoId: A.repoId, entry: entryInput() }),
    );
    await expect(notUuid).rejects.toThrow(MemoryStoreError);
  });

  it("refuses the entry past the per-repository cap, under concurrency (P5)", async () => {
    const repoId = await addRepo(A);
    // Plant the cap minus one as the superuser (the fixture shape), then race two creates.
    await superuser.query(
      `insert into public.memory_entries
         (org_id, repo_id, kind, origin, content, evidence_path, evidence_sha, evidence_start,
          evidence_end, source_pr_number, confidence, created_by)
       select $1, $2, 'convention', 'learned', 'planted ' || g, 'src/a.ts', $3, 1, 1, 1, 50, $4
         from generate_series(1, $5) g`,
      [A.orgId, repoId, SHA, A.memberId, MAX_MEMORY_ENTRIES_PER_REPO - 1],
    );
    const attempt = () =>
      db.withOrg(A.orgId, (tx) =>
        createMemoryEntry(tx, { authorMemberId: A.memberId, repoId, entry: entryInput() }),
      );
    const outcomes = (await Promise.all([attempt(), attempt()])).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["created", "repo_full"]);
    expect(await attempt()).toEqual({ outcome: "repo_full" });
    await superuser.query("delete from public.memory_entries where repo_id = $1", [repoId]);
  }, 60_000);
});

const loadMemoryEntryAs = (org: SeededOrg, entryId: string) =>
  db.withOrg(org.orgId, (tx) => loadMemoryEntry(tx, entryId));

const listAs = (org: SeededOrg, repoId: string, options: { includeSuperseded?: boolean } = {}) =>
  db.withOrg(org.orgId, (tx) => listMemoryEntries(tx, { repoId, ...options }));

describe("listMemoryEntries and loadMemoryEntry", () => {
  it("lists the current entries of one repository, newest first, and loads one by id", async () => {
    const repoId = await addRepo(A);
    const first = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, {
        authorMemberId: A.memberId,
        repoId,
        entry: entryInput({ text: "first" }),
      }),
    );
    const second = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, {
        authorMemberId: A.memberId,
        repoId,
        entry: entryInput({ text: "second" }),
      }),
    );
    if (first.outcome !== "created" || second.outcome !== "created") throw new Error("setup");
    const listed = await listAs(A, repoId);
    expect(listed.map((e) => e.text)).toEqual(["second", "first"]);
    expect(await loadMemoryEntryAs(A, first.entry.id)).toEqual(first.entry);
    expect(await loadMemoryEntryAs(A, "00000000-0000-4000-8000-000000000000")).toBeNull();
    await expect(listAs(A, "not-a-uuid")).rejects.toThrow(MemoryStoreError);
  });

  it("caps a listing at MAX_MEMORY_LISTING, oldest entries first out", async () => {
    const repoId = await addRepo(A);
    await superuser.query(
      `insert into public.memory_entries
         (org_id, repo_id, kind, origin, content, evidence_path, evidence_sha, evidence_start,
          evidence_end, source_pr_number, confidence, created_by, created_at)
       select $1, $2, 'convention', 'learned', 'planted ' || g, 'src/a.ts', $3, 1, 1, 1, 50, $4,
              now() - make_interval(secs => g)
         from generate_series(1, $5) g`,
      [A.orgId, repoId, SHA, A.memberId, MAX_MEMORY_LISTING + 5],
    );
    const listed = await listAs(A, repoId);
    expect(listed).toHaveLength(MAX_MEMORY_LISTING);
    expect(listed[0]?.text).toBe("planted 1");
    const fewer = await db.withOrg(A.orgId, (tx) => listMemoryEntries(tx, { repoId, limit: 3 }));
    expect(fewer).toHaveLength(3);
    await expect(
      db.withOrg(A.orgId, (tx) => listMemoryEntries(tx, { repoId, limit: 0 })),
    ).rejects.toThrow(MemoryStoreError);
    await superuser.query("delete from public.memory_entries where repo_id = $1", [repoId]);
  }, 60_000);

  it("shows a deleted member as a former member, with nothing to erase (acceptance criterion)", async () => {
    const authorId = await addMember(A, "temp-author");
    const repoId = await addRepo(A);
    const result = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, {
        authorMemberId: authorId,
        repoId,
        entry: entryInput({ text: "temp-author decided: keep the feature flag" }),
      }),
    );
    if (result.outcome !== "created") throw new Error("setup");
    expect(result.entry.author).toEqual({
      kind: "member",
      memberId: authorId,
      login: "temp-author",
    });
    expect(result.entry.text).toBe("[person] decided: keep the feature flag");
    await db.withOrg(A.orgId, (tx) => tx.query("delete from members where id = $1", [authorId]));
    const after = await loadMemoryEntryAs(A, result.entry.id);
    expect(after?.author).toEqual({ kind: "former_member" });
    expect((await listAs(A, repoId))[0]?.author).toEqual({ kind: "former_member" });
    // The row keeps everything but the author id; the login was never in it.
    const row = await superuser.query<{ created_by: string | null; content: string }>(
      "select created_by, content from public.memory_entries where id = $1",
      [result.entry.id],
    );
    expect(row.rows[0]).toEqual({
      created_by: null,
      content: "[person] decided: keep the feature flag",
    });
  });

  it("shows a member removed in Rocky as a former member, and by login again once restored", async () => {
    const authorId = await addMember(A, "removed-author");
    const entry = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, { authorMemberId: authorId, repoId: A.repoId, entry: entryInput() }),
    );
    if (entry.outcome !== "created") throw new Error("setup");
    await db.withOrg(A.orgId, (tx) =>
      removeMember(tx, { actorMemberId: A.memberId, targetMemberId: authorId }),
    );
    expect((await loadMemoryEntryAs(A, entry.entry.id))?.author).toEqual({ kind: "former_member" });
    await db.withOrg(A.orgId, (tx) =>
      restoreMember(tx, { actorMemberId: A.memberId, targetMemberId: authorId }),
    );
    expect((await loadMemoryEntryAs(A, entry.entry.id))?.author).toEqual({
      kind: "member",
      memberId: authorId,
      login: "removed-author",
    });
  });
});

describe("supersedeMemoryEntry", () => {
  const supersede = (org: SeededOrg, entryId: string, byEntryId: string, actor = org.memberId) =>
    db.withOrg(org.orgId, (tx) =>
      supersedeMemoryEntry(tx, { actorMemberId: actor, entryId, byEntryId }),
    );

  it("marks the old entry, keeps it out of the default listing, and audits ids only", async () => {
    const repoId = await addRepo(A);
    const old = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, {
        authorMemberId: A.memberId,
        repoId,
        entry: entryInput({ text: "old" }),
      }),
    );
    const next = await db.withOrg(A.orgId, (tx) =>
      createMemoryEntry(tx, {
        authorMemberId: A.memberId,
        repoId,
        entry: entryInput({ text: "new" }),
      }),
    );
    if (old.outcome !== "created" || next.outcome !== "created") throw new Error("setup");
    expect(await supersede(A, old.entry.id, next.entry.id)).toBe("superseded");
    expect((await loadMemoryEntryAs(A, old.entry.id))?.supersededBy).toBe(next.entry.id);
    expect((await listAs(A, repoId)).map((e) => e.text)).toEqual(["new"]);
    expect((await listAs(A, repoId, { includeSuperseded: true })).map((e) => e.text)).toEqual([
      "new",
      "old",
    ]);
    const rows = await auditRows(A, "memory.superseded");
    expect(rows.at(-1)).toEqual({
      actor_id: A.memberId,
      target_id: old.entry.id,
      metadata: { by: next.entry.id, repoId },
    });
  });

  it("refuses itself, a superseded source or target, a different repository, an unknown id, and a non-member (P6)", async () => {
    const repoId = await addRepo(A);
    const otherRepoId = await addRepo(A);
    const make = (repo: string, text: string) =>
      db.withOrg(A.orgId, async (tx) => {
        const r = await createMemoryEntry(tx, {
          authorMemberId: A.memberId,
          repoId: repo,
          entry: entryInput({ text }),
        });
        if (r.outcome !== "created") throw new Error("setup");
        return r.entry.id;
      });
    const a = await make(repoId, "a");
    const b = await make(repoId, "b");
    const c = await make(repoId, "c");
    const elsewhere = await make(otherRepoId, "elsewhere");
    expect(await supersede(A, a, a)).toBe("self");
    expect(await supersede(A, a, elsewhere)).toBe("different_repo");
    expect(await supersede(A, a, "00000000-0000-4000-8000-000000000000")).toBe("not_found");
    expect(await supersede(A, "00000000-0000-4000-8000-000000000000", a)).toBe("not_found");
    expect(await supersede(A, a, b)).toBe("superseded");
    // a → b. Superseding a again, or anything by a (which is no longer current), is refused.
    expect(await supersede(A, a, c)).toBe("already_superseded");
    expect(await supersede(A, c, a)).toBe("already_superseded");
    // b → a would close the loop: a is superseded, so it is refused above; b → c then c → b?
    expect(await supersede(A, b, c)).toBe("superseded");
    expect(await supersede(A, c, b)).toBe("already_superseded");
    // The actor must be an active member of this org.
    expect(await supersede(A, c, a, B.memberId)).toBe("not_a_member");
    const self = await pgError(
      db.withOrg(A.orgId, (tx) =>
        tx.query("update memory_entries set superseded_by = id where id = $1", [c]),
      ),
    );
    expect(self.code).toBe(CHECK_VIOLATION);
  });
});

describe("touchMemoryEntries", () => {
  it("moves last_used_at forward for this org's entries only, and bounds the batch", async () => {
    const mine = await created(A, { text: "touch me" });
    const theirs = await created(B, { text: "not yours" });
    const touched = await db.withOrg(A.orgId, (tx) =>
      touchMemoryEntries(tx, [mine.id, theirs.id, "00000000-0000-4000-8000-000000000000"]),
    );
    expect(touched).toBe(1);
    expect((await loadMemoryEntryAs(A, mine.id))?.lastUsedAt).toBeInstanceOf(Date);
    expect((await loadMemoryEntryAs(B, theirs.id))?.lastUsedAt).toBeNull();
    expect(await db.withOrg(A.orgId, (tx) => touchMemoryEntries(tx, []))).toBe(0);
    await expect(
      db.withOrg(A.orgId, (tx) =>
        touchMemoryEntries(
          tx,
          Array.from({ length: MAX_MEMORY_TOUCH + 1 }, () => mine.id),
        ),
      ),
    ).rejects.toThrow(MemoryStoreError);
    await expect(db.withOrg(A.orgId, (tx) => touchMemoryEntries(tx, ["x"]))).rejects.toThrow(
      MemoryStoreError,
    );
  });
});

describe("another org's rows do not exist (P1)", () => {
  it("cannot list, load, supersede or touch org B's entries from org A", async () => {
    const theirs = await created(B, { text: "theirs" });
    expect(await listAs(A, B.repoId)).toEqual([]);
    expect(await loadMemoryEntryAs(A, theirs.id)).toBeNull();
    const mine = await created(A, { text: "mine" });
    expect(
      await db.withOrg(A.orgId, (tx) =>
        supersedeMemoryEntry(tx, {
          actorMemberId: A.memberId,
          entryId: mine.id,
          byEntryId: theirs.id,
        }),
      ),
    ).toBe("not_found");
    expect(await db.withOrg(A.orgId, (tx) => touchMemoryEntries(tx, [theirs.id]))).toBe(0);
    // Even a crafted update cannot point an own row at B's entry: composite FK (T4).
    const crafted = await pgError(
      db.withOrg(A.orgId, (tx) =>
        tx.query("update memory_entries set superseded_by = $2 where id = $1", [
          mine.id,
          theirs.id,
        ]),
      ),
    );
    expect(crafted.code).toBe(FOREIGN_KEY_VIOLATION);
    expect((await loadMemoryEntryAs(B, theirs.id))?.supersededBy).toBeNull();
  });
});

describe("the database refuses what core refuses (P8)", () => {
  const insert = (tx: TenantTx, patch: Record<string, unknown>) => {
    const row = {
      repo_id: A.repoId,
      kind: "convention",
      origin: "member",
      content: "ok",
      evidence_path: "src/a.ts",
      evidence_sha: SHA,
      evidence_start: 1,
      evidence_end: 1,
      source_pr_number: 1,
      confidence: 50,
      reason: null,
      ...patch,
    };
    const columns = Object.keys(row);
    return tx.query(
      `insert into memory_entries (${columns.join(", ")})
       values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row),
    );
  };

  it("CHECKs kind, origin, content, path, sha, range, PR number, confidence and the reason pairing", async () => {
    const cases: Record<string, unknown>[] = [
      { kind: "note" },
      { origin: "system" },
      { content: "" },
      { content: "x".repeat(301) },
      { content: "line\u0001break" },
      { evidence_path: "/abs.ts" },
      { evidence_path: "a\\b.ts" },
      { evidence_path: "a/../b.ts" },
      { evidence_path: "../b.ts" },
      { evidence_path: "a/." },
      { evidence_path: "a/" },
      { evidence_path: "" },
      { evidence_sha: "A".repeat(40) },
      { evidence_sha: "c".repeat(39) },
      { evidence_start: 0 },
      { evidence_start: 5, evidence_end: 4 },
      { evidence_start: 1, evidence_end: 201 },
      { evidence_end: 10_000_001 },
      { source_pr_number: 0 },
      { source_pr_number: 1_000_000_001 },
      { confidence: -1 },
      { confidence: 101 },
      { kind: "dismissal" },
      { reason: "intentional" },
      { kind: "dismissal", reason: "because" },
    ];
    for (const patch of cases) {
      const error = await pgError(db.withOrg(A.orgId, (tx) => insert(tx, patch)));
      expect(error.code, JSON.stringify(patch)).toBe(CHECK_VIOLATION);
    }
    // And the valid shapes go in (then out again).
    await db.withOrg(A.orgId, async (tx) => {
      await insert(tx, { content: "x".repeat(300), evidence_start: 1, evidence_end: 200 });
      await insert(tx, {
        kind: "dismissal",
        reason: "not_worth_it",
        evidence_path: "a/.hidden/.b",
      });
      await tx.query(
        "delete from memory_entries where content = $1 or evidence_path = 'a/.hidden/.b'",
        ["x".repeat(300)],
      );
    });
  });

  it("requires a repository (no org-wide entries) and keeps the author a same-org member", async () => {
    const noRepo = await pgError(db.withOrg(A.orgId, (tx) => insert(tx, { repo_id: null })));
    expect(noRepo.code).toBe("23502");
    const foreignRepo = await pgError(
      db.withOrg(A.orgId, (tx) => insert(tx, { repo_id: B.repoId })),
    );
    expect(foreignRepo.code).toBe(FOREIGN_KEY_VIOLATION);
    const foreignAuthor = await pgError(
      db.withOrg(A.orgId, (tx) => insert(tx, { created_by: B.memberId })),
    );
    expect(foreignAuthor.code).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe("erasure (P11)", () => {
  it("removes the org's entries and embeddings with the org", async () => {
    const orgId = newOrgId();
    const org = await asWorker(pgs.workerUrl, (w) => seedOrg(w, orgId, { installationId: 73 }));
    await created(org, { text: "to be erased" });
    const count = async (table: string) =>
      Number(
        (
          await superuser.query<{ n: string }>(
            `select count(*)::text as n from public.${table} where org_id = $1`,
            [orgId],
          )
        ).rows[0]?.n,
      );
    expect(await count("memory_entries")).toBe(2);
    expect(await count("embeddings")).toBe(1);
    await worker.withOrg(orgId, (tx) => scheduleOrgDeletion(tx, 73));
    await superuser.query("alter table orgs disable trigger user");
    try {
      await superuser.query(
        "update orgs set delete_after = now() - interval '1 second' where id = $1",
        [orgId],
      );
    } finally {
      await superuser.query("alter table orgs enable trigger user");
    }
    expect(await worker.withOrg(orgId, (tx) => beginOrgErasure(tx))).not.toBe("not_due");
    await worker.deleteOrg(orgId);
    expect(await count("memory_entries")).toBe(0);
    expect(await count("embeddings")).toBe(0);
  });
});
