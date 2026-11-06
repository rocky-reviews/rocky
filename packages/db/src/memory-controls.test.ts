import type { MemoryEntry } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type TenantTx } from "./client.js";
import {
  countMemoryEntries,
  createMemoryEntry,
  deleteMemoryEntry,
  editMemoryEntry,
  findMemoryRepository,
  listMemoryEntries,
  loadMemoryEntry,
  MemoryStoreError,
  setMemoryEntryDisabled,
  setRepoMemoryEnabled,
  supersedeMemoryEntry,
} from "./memory.js";
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
 * P8-3 (migration 0019, ADR 0038): what the memory page changes, on a real Postgres as the
 * application role. Edit keeps history (a new member-written entry supersedes the old one, and
 * the scrubber runs again); delete removes the entry with its older versions, so nothing comes
 * back; switching an entry or a repository off; `memory.edit` is re-checked in the transaction;
 * another org's entries and repositories do not exist; audit rows carry ids and counts only.
 */

const SHA = "e".repeat(40);

let pgs: TestPostgres;
let superuser: pg.Pool;
let db: Db;
let A: SeededOrg;
let B: SeededOrg;
let plainMember: string;
let nextForgeId = 80_000;

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  db = createDb({ connectionString: pgs.appUrl, max: 4 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 81 }),
    await seedOrg(w, newOrgId(), { installationId: 82 }),
  ]);
  plainMember = await addMember(A, "dave", "member");
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

async function addMember(org: SeededOrg, login: string, role: "member" | "admin") {
  return db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into members (forge_user_id, login, role) values ($1, $2, $3) returning id",
      [nextForgeId++, login, role],
    );
    return rows[0]!.id;
  });
}

const created = async (
  org: SeededOrg,
  patch: Record<string, unknown> = {},
  origin: "member" | "learned" = "learned",
): Promise<MemoryEntry> => {
  const result = await db.withOrg(org.orgId, (tx) =>
    createMemoryEntry(tx, {
      authorMemberId: org.memberId,
      repoId: org.repoId,
      origin,
      entry: {
        kind: "dismissal",
        reason: "intentional",
        text: "Dismissed as intentional: a swallowed error in the nightly job",
        evidence: {
          path: "src/jobs/bill.ts",
          sha: SHA,
          range: { start: 4, end: 9 },
          pullRequestNumber: 847,
        },
        confidence: 80,
        ...patch,
      },
    }),
  );
  if (result.outcome !== "created") throw new Error(result.outcome);
  return result.entry;
};

const as = <T>(org: SeededOrg, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
  db.withOrg(org.orgId, fn);

const auditOf = (org: SeededOrg, action: string, targetId: string) =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      "select actor_id, metadata from audit_events where action = $1 and target_id = $2 order by id",
      [action, targetId],
    );
    return rows;
  });

const exists = async (id: string) =>
  (await superuser.query("select 1 from public.memory_entries where id = $1", [id])).rowCount === 1;

describe("findMemoryRepository", () => {
  it("finds an enabled repository by name, case-insensitively, in this org only", async () => {
    const name = "org-81/api";
    expect(await as(A, (tx) => findMemoryRepository(tx, "ORG-81/API"))).toEqual({
      repoId: A.repoId,
      forgeRepoId: 2001,
      fullName: name,
      memoryEnabled: true,
    });
    expect(await as(B, (tx) => findMemoryRepository(tx, name))).toBeNull();
    await expect(as(A, (tx) => findMemoryRepository(tx, "../x"))).rejects.toThrow(MemoryStoreError);
  });
});

describe("editMemoryEntry", () => {
  it("writes a new member entry with the old evidence that supersedes the old one, scrubbed again", async () => {
    const old = await created(A, { severity: undefined });
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update memory_entries set severity = 'high' where id = $1", [old.id]),
    );
    const result = await as(A, (tx) =>
      editMemoryEntry(tx, {
        actorMemberId: A.memberId,
        entryId: old.id,
        edit: {
          kind: "dismissal",
          reason: "not_an_issue",
          text: "Swallowed errors in nightly jobs are retried, says dave",
        },
      }),
    );
    expect(result.outcome).toBe("edited");
    if (result.outcome !== "edited") return;
    expect(result.entry).toMatchObject({
      kind: "dismissal",
      origin: "member",
      reason: "not_an_issue",
      // A member login is scrubbed out of an edit like out of any entry.
      text: "Swallowed errors in nightly jobs are retried, says [person]",
      severity: "high",
      evidence: old.evidence,
      confidence: old.confidence,
      author: { kind: "member", memberId: A.memberId, login: "alice" },
      supersededBy: null,
      disabledAt: null,
    });
    expect(result.scrubbed).toBe(1);
    expect((await as(A, (tx) => loadMemoryEntry(tx, old.id)))?.supersededBy).toBe(result.entry.id);
    expect(await auditOf(A, "memory.superseded", old.id)).toEqual([
      { actor_id: A.memberId, metadata: { by: result.entry.id, repoId: A.repoId } },
    ]);
  });

  it("a dismissal edited into a convention covers nothing; a switched-off entry stays off", async () => {
    const old = await created(A);
    await as(A, (tx) =>
      setMemoryEntryDisabled(tx, { actorMemberId: A.memberId, entryId: old.id, disabled: true }),
    );
    const result = await as(A, (tx) =>
      editMemoryEntry(tx, {
        actorMemberId: A.memberId,
        entryId: old.id,
        edit: { kind: "convention", reason: null, text: "Log every swallowed error." },
      }),
    );
    expect(result).toMatchObject({
      outcome: "edited",
      entry: { kind: "convention", reason: null, severity: null },
    });
    if (result.outcome === "edited") expect(result.entry.disabledAt).toBeInstanceOf(Date);
  });

  it("refuses a member without memory.edit, a superseded entry, bad text and another org's entry", async () => {
    const old = await created(A);
    const edit = { kind: "convention", reason: null, text: "Fine." } as const;
    expect(
      await as(A, (tx) =>
        editMemoryEntry(tx, { actorMemberId: plainMember, entryId: old.id, edit }),
      ),
    ).toEqual({ outcome: "not_permitted" });
    expect(
      await as(A, (tx) =>
        editMemoryEntry(tx, {
          actorMemberId: A.memberId,
          entryId: old.id,
          edit: { ...edit, text: "two\u0007bells" },
        }),
      ),
    ).toEqual({ outcome: "invalid", problem: "invalid_text" });
    const first = await as(A, (tx) =>
      editMemoryEntry(tx, { actorMemberId: A.memberId, entryId: old.id, edit }),
    );
    expect(first.outcome).toBe("edited");
    expect(
      await as(A, (tx) =>
        editMemoryEntry(tx, { actorMemberId: A.memberId, entryId: old.id, edit }),
      ),
    ).toEqual({ outcome: "already_superseded" });
    expect(
      await as(B, (tx) =>
        editMemoryEntry(tx, { actorMemberId: B.memberId, entryId: old.id, edit }),
      ),
    ).toEqual({ outcome: "not_found" });
    // A refused edit stores nothing.
    expect(
      (
        await as(A, (tx) => listMemoryEntries(tx, { repoId: A.repoId, includeSuperseded: true }))
      ).filter((e) => e.text === "two\u0007bells"),
    ).toEqual([]);
  });
});

describe("deleteMemoryEntry", () => {
  it("deletes the entry with every older version, so none comes back as current", async () => {
    const v1 = await created(A, { text: "Dismissed as intentional: v1 pattern" });
    const v2 = await created(A, { text: "Dismissed as intentional: v2 pattern" });
    const v3 = await created(A, { text: "Dismissed as intentional: v3 pattern" });
    for (const [from, to] of [
      [v1, v2],
      [v2, v3],
    ] as const) {
      expect(
        await as(A, (tx) =>
          supersedeMemoryEntry(tx, {
            actorMemberId: A.memberId,
            entryId: from.id,
            byEntryId: to.id,
          }),
        ),
      ).toBe("superseded");
    }
    const embedded = await superuser.query(
      `insert into public.embeddings (org_id, repo_id, memory_entry_id, source_kind, source_ref, model, embedding)
       select org_id, repo_id, $1::uuid, 'memory', $1::text, 'test-embed', embedding
         from public.embeddings where org_id = $2 limit 1 returning id`,
      [v1.id, A.orgId],
    );
    expect(embedded.rowCount).toBe(1);

    expect(
      await as(A, (tx) => deleteMemoryEntry(tx, { actorMemberId: A.memberId, entryId: v3.id })),
    ).toEqual({ outcome: "deleted", deleted: 3 });
    for (const e of [v1, v2, v3]) expect(await exists(e.id)).toBe(false);
    expect(
      (await superuser.query("select 1 from public.embeddings where memory_entry_id = $1", [v1.id]))
        .rowCount,
    ).toBe(0);
    expect(await auditOf(A, "memory.deleted", v3.id)).toEqual([
      { actor_id: A.memberId, metadata: { repoId: A.repoId, deleted: 3 } },
    ]);
  });

  it("deleting an older version keeps the newer ones", async () => {
    const v1 = await created(A, { text: "Dismissed as intentional: w1 pattern" });
    const v2 = await created(A, { text: "Dismissed as intentional: w2 pattern" });
    await as(A, (tx) =>
      supersedeMemoryEntry(tx, { actorMemberId: A.memberId, entryId: v1.id, byEntryId: v2.id }),
    );
    expect(
      await as(A, (tx) => deleteMemoryEntry(tx, { actorMemberId: A.memberId, entryId: v1.id })),
    ).toEqual({ outcome: "deleted", deleted: 1 });
    expect(await exists(v2.id)).toBe(true);
  });

  it("refuses a member without memory.edit and another org's entry", async () => {
    const entry = await created(A);
    expect(
      await as(A, (tx) => deleteMemoryEntry(tx, { actorMemberId: plainMember, entryId: entry.id })),
    ).toEqual({ outcome: "not_permitted" });
    expect(
      await as(B, (tx) => deleteMemoryEntry(tx, { actorMemberId: B.memberId, entryId: entry.id })),
    ).toEqual({ outcome: "not_found" });
    expect(await exists(entry.id)).toBe(true);
  });
});

describe("setMemoryEntryDisabled", () => {
  it("switches a current entry off and on, audited only when it changes", async () => {
    const entry = await created(A);
    const off = () =>
      as(A, (tx) =>
        setMemoryEntryDisabled(tx, {
          actorMemberId: A.memberId,
          entryId: entry.id,
          disabled: true,
        }),
      );
    const first = await off();
    expect(first.outcome).toBe("switched");
    if (first.outcome === "switched") expect(first.entry.disabledAt).toBeInstanceOf(Date);
    await off();
    expect(await auditOf(A, "memory.disabled", entry.id)).toEqual([
      { actor_id: A.memberId, metadata: { repoId: A.repoId } },
    ]);
    const on = await as(A, (tx) =>
      setMemoryEntryDisabled(tx, { actorMemberId: A.memberId, entryId: entry.id, disabled: false }),
    );
    expect(on).toMatchObject({ outcome: "switched", entry: { disabledAt: null } });
    expect(await auditOf(A, "memory.enabled", entry.id)).toHaveLength(1);
  });

  it("refuses a member without memory.edit, a superseded entry and another org's entry", async () => {
    const older = await created(A, { text: "Dismissed as intentional: x1 pattern" });
    const newer = await created(A, { text: "Dismissed as intentional: x2 pattern" });
    await as(A, (tx) =>
      supersedeMemoryEntry(tx, {
        actorMemberId: A.memberId,
        entryId: older.id,
        byEntryId: newer.id,
      }),
    );
    const input = (actorMemberId: string, entryId: string) => ({
      actorMemberId,
      entryId,
      disabled: true,
    });
    expect(await as(A, (tx) => setMemoryEntryDisabled(tx, input(plainMember, newer.id)))).toEqual({
      outcome: "not_permitted",
    });
    expect(await as(A, (tx) => setMemoryEntryDisabled(tx, input(A.memberId, older.id)))).toEqual({
      outcome: "already_superseded",
    });
    expect(await as(B, (tx) => setMemoryEntryDisabled(tx, input(B.memberId, newer.id)))).toEqual({
      outcome: "not_found",
    });
  });
});

describe("setRepoMemoryEnabled", () => {
  it("switches the repository's memory, for memory.edit only, in this org only", async () => {
    const input = (actorMemberId: string, repoId: string, enabled: boolean) => ({
      actorMemberId,
      repoId,
      enabled,
    });
    expect(await as(A, (tx) => setRepoMemoryEnabled(tx, input(plainMember, A.repoId, false)))).toBe(
      "not_permitted",
    );
    expect(await as(B, (tx) => setRepoMemoryEnabled(tx, input(B.memberId, A.repoId, false)))).toBe(
      "not_found",
    );
    expect(await as(A, (tx) => setRepoMemoryEnabled(tx, input(A.memberId, A.repoId, false)))).toBe(
      "switched",
    );
    expect((await as(A, (tx) => findMemoryRepository(tx, "org-81/api")))?.memoryEnabled).toBe(
      false,
    );
    expect(await auditOf(A, "memory.repo_disabled", A.repoId)).toEqual([
      { actor_id: A.memberId, metadata: {} },
    ]);
    await as(A, (tx) => setRepoMemoryEnabled(tx, input(A.memberId, A.repoId, true)));
    expect((await as(A, (tx) => findMemoryRepository(tx, "org-81/api")))?.memoryEnabled).toBe(true);
    // B's repository is untouched.
    expect((await as(B, (tx) => findMemoryRepository(tx, "org-82/api")))?.memoryEnabled).toBe(true);
  });

  it("counts a repository's entries, current and superseded, in this org only", async () => {
    const n = await as(A, (tx) => countMemoryEntries(tx, A.repoId));
    expect(n).toBeGreaterThan(0);
    expect(await as(B, (tx) => countMemoryEntries(tx, A.repoId))).toBe(0);
  });
});
