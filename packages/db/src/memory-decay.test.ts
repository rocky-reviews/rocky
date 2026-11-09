import { randomUUID } from "node:crypto";
import type { Clock, OrgId } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, MAX_LIVE_ORGS_PAGE, type Db } from "./client.js";
import { beginOrgErasure, scheduleOrgDeletion } from "./installations.js";
import { supersedeMemoryEntry, touchMemoryEntries } from "./memory.js";
import {
  decayOrgMemory,
  MEMORY_DECAY_ACTOR,
  MEMORY_DECAY_MIN_DAYS,
  MEMORY_DECAY_STATEMENTS,
  MEMORY_DECAY_STEP,
  memoryDecayCutoff,
  runMemoryDecay,
  type MemoryDecayWindows,
} from "./memory-decay.js";
import { setMemoryEntryDisabled, setRepoMemoryEnabled } from "./memory.js";
import {
  DEFAULT_RETENTION,
  MEMORY_SUPERSEDED_MIN_RETENTION_DAYS,
  MEMORY_UNUSED_MIN_RETENTION_DAYS,
} from "./retention.js";
import * as schema from "./schema.js";
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
 * P8-4 (migration 0019, ADR 0038): the decay job on a real Postgres as the application and the
 * worker roles. Time-travel like retention.test.ts: the clock is injected as `as_of` and rows are
 * planted just inside and just outside each boundary (an entry is idle iff its idle instant is
 * strictly older than `as_of - window`). Member-written entries are never touched; a retired
 * learned entry goes with the learned chain behind it and its embeddings; history goes tail
 * first; the clock cannot be pushed forward; audit rows carry counts only; the org list is the
 * worker's. Cross-tenant checks are in isolation.test.ts.
 */

const DAY = 86_400_000;
const SHA = "d".repeat(40);
const INSUFFICIENT_PRIVILEGE = "42501";
const fixedClock = (at: Date): Clock => ({ now: () => at });
/** Real "now" minus a day, so the injected clock is always behind the database clock. */
const NOW = new Date(Date.now() - DAY);
const ageDays = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const WINDOWS: MemoryDecayWindows = {
  memoryDecayDays: DEFAULT_RETENTION.memoryDecayDays,
  memoryUnusedDays: DEFAULT_RETENTION.memoryUnusedDays,
  memorySupersededDays: DEFAULT_RETENTION.memorySupersededDays,
};

let pgs: TestPostgres;
let db: Db;
let worker: Db;
let superuser: pg.Pool;
let appPool: pg.Pool;
let workerPool: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  pgs = await startPostgres();
  appPool = new pg.Pool({ connectionString: pgs.appUrl, max: 2 }).on("error", ignoreIdleError);
  workerPool = new pg.Pool({ connectionString: pgs.workerUrl, max: 2 }).on(
    "error",
    ignoreIdleError,
  );
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  db = createDb({ pool: appPool });
  worker = createDb({ pool: workerPool });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 81 }),
    await seedOrg(w, newOrgId(), { installationId: 82 }),
  ]);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

interface Planted {
  readonly origin?: "member" | "learned";
  readonly kind?: "convention" | "dismissal";
  readonly confidence?: number;
  readonly createdAt: Date;
  readonly lastUsedAt?: Date;
  readonly decayedAt?: Date;
  readonly supersededBy?: string;
  readonly disabledAt?: Date;
  /** Defaults to `createdAt`; a supersede stamps it. */
  readonly updatedAt?: Date;
}

/** Plants one entry as the superuser (the app cannot backdate a supersede's `updated_at`). */
const plant = async (org: SeededOrg, p: Planted): Promise<string> => {
  const id = randomUUID();
  const kind = p.kind ?? "convention";
  await superuser.query(
    `insert into memory_entries (id, org_id, repo_id, kind, origin, content, evidence_path,
       evidence_sha, evidence_start, evidence_end, source_pr_number, confidence, reason, created_by,
       created_at, updated_at, last_used_at, decayed_at, superseded_by, disabled_at)
     values ($1, $2, $3, $4, $5, $6, 'src/jobs/retry.ts', $7, 1, 3, 612, $8, $9, $10,
             $11, $12, $13, $14, $15, $16)`,
    [
      id,
      org.orgId,
      org.repoId,
      kind,
      p.origin ?? "learned",
      `Planted entry ${id.slice(0, 8)}: swallow the error and move on`,
      SHA,
      p.confidence ?? 80,
      kind === "dismissal" ? "intentional" : null,
      org.memberId,
      p.createdAt,
      p.updatedAt ?? p.createdAt,
      p.lastUsedAt ?? null,
      p.decayedAt ?? null,
      p.supersededBy ?? null,
      p.disabledAt ?? null,
    ],
  );
  return id;
};

const plantEmbedding = async (org: SeededOrg, entryId: string): Promise<string> => {
  const id = randomUUID();
  await superuser.query(
    `insert into embeddings (id, org_id, repo_id, memory_entry_id, source_kind, source_ref, provider, model, dimensions, embedding)
     values ($1, $2, $3, $4, 'memory', $5, 'openai-compatible', 'test-embed', 1024, $6::vector)`,
    [
      id,
      org.orgId,
      org.repoId,
      entryId,
      entryId,
      `[${Array(schema.EMBEDDING_DIMENSIONS).fill(0).join(",")}]`,
    ],
  );
  return id;
};

interface Row {
  confidence: number;
  decayed_at: Date | null;
  superseded_by: string | null;
  last_used_at: Date | null;
}

const row = async (id: string): Promise<Row | null> => {
  const { rows } = await superuser.query<Row>(
    "select confidence, decayed_at, superseded_by, last_used_at from memory_entries where id = $1",
    [id],
  );
  return rows[0] ?? null;
};

const exists = async (table: "memory_entries" | "embeddings", id: string): Promise<boolean> =>
  ((await superuser.query(`select 1 from ${table} where id = $1`, [id])).rowCount ?? 0) === 1;

const run = (org: SeededOrg, asOf: Date = NOW, windows: MemoryDecayWindows = WINDOWS) =>
  db.withOrg(org.orgId, (tx) => decayOrgMemory(tx, { asOf, windows }));

const auditRows = (org: SeededOrg) =>
  superuser.query<{ actor_type: string; actor_id: string; target_id: string; metadata: unknown }>(
    `select actor_type, actor_id, target_id, metadata from audit_events
      where org_id = $1 and action = 'memory.decayed' order by id`,
    [org.orgId],
  );

describe("memoryDecayCutoff", () => {
  it("subtracts whole days from the injected clock", () => {
    expect(memoryDecayCutoff(new Date("2026-11-06T12:00:00Z"), 90).toISOString()).toBe(
      "2026-08-08T12:00:00.000Z",
    );
  });
});

describe("decay: a confidence step per idle period (ADR 0038 §2.1)", () => {
  it("lowers a learned entry's confidence one step after a period without a citation, and nothing else", async () => {
    const idle = await plant(A, { createdAt: ageDays(91) });
    const boundary = await plant(A, { createdAt: ageDays(90) });
    const fresh = await plant(A, { createdAt: ageDays(89) });
    const usedLately = await plant(A, { createdAt: ageDays(400), lastUsedAt: ageDays(10) });
    const usedLongAgo = await plant(A, { createdAt: ageDays(300), lastUsedAt: ageDays(91) });
    const member = await plant(A, { origin: "member", createdAt: ageDays(400), confidence: 90 });
    const history = await plant(A, { createdAt: ageDays(100), supersededBy: fresh });
    const dismissal = await plant(A, { kind: "dismissal", createdAt: ageDays(91), confidence: 70 });

    const report = await run(A);
    expect(report).toEqual({ decayed: 3, retired: 0, purged: 0 });
    expect(await row(idle)).toMatchObject({ confidence: 80 - MEMORY_DECAY_STEP, decayed_at: NOW });
    expect(await row(usedLongAgo)).toMatchObject({ confidence: 70, decayed_at: NOW });
    expect(await row(dismissal)).toMatchObject({ confidence: 60, decayed_at: NOW });
    for (const id of [boundary, fresh, usedLately, history]) {
      expect(await row(id), id).toMatchObject({ confidence: 80, decayed_at: null });
    }
    expect(await row(member)).toMatchObject({ confidence: 90, decayed_at: null });
    // The fixture's member-written entry is untouched too.
    expect(await row(A.memoryEntryId)).toMatchObject({ confidence: 80, decayed_at: null });
  });

  it("is idempotent at the same instant, takes one step per period since the last step, and stops at 0", async () => {
    // The clock cannot move forward past the database clock (the clamp below), so "a period
    // later" is planted as an earlier decay step instead.
    const low = await plant(A, { createdAt: ageDays(91), confidence: 5 });
    const stepped = await plant(A, {
      createdAt: ageDays(300),
      decayedAt: ageDays(91),
      confidence: 70,
    });
    const steppedBoundary = await plant(A, {
      createdAt: ageDays(300),
      decayedAt: ageDays(90),
      confidence: 70,
    });
    expect(await run(A)).toEqual({ decayed: 2, retired: 0, purged: 0 });
    expect(await row(low)).toMatchObject({ confidence: 0, decayed_at: NOW });
    expect(await row(stepped)).toMatchObject({ confidence: 60, decayed_at: NOW });
    expect(await row(steppedBoundary)).toMatchObject({ confidence: 70, decayed_at: ageDays(90) });
    expect(await run(A)).toEqual({ decayed: 0, retired: 0, purged: 0 });
    expect(await row(low)).toMatchObject({ confidence: 0, decayed_at: NOW });
  });

  it("a citation after a decay step restarts the clock", async () => {
    const cited = await plant(A, {
      createdAt: ageDays(300),
      decayedAt: ageDays(200),
      lastUsedAt: ageDays(89),
      confidence: 70,
    });
    const citedLongAgo = await plant(A, {
      createdAt: ageDays(300),
      decayedAt: ageDays(200),
      lastUsedAt: ageDays(91),
      confidence: 70,
    });
    expect(await run(A)).toEqual({ decayed: 1, retired: 0, purged: 0 });
    expect(await row(cited)).toMatchObject({ confidence: 70, decayed_at: ageDays(200) });
    expect(await row(citedLongAgo)).toMatchObject({ confidence: 60, decayed_at: NOW });
  });
});

describe("retire: an uncited learned entry goes with its learned chain and embeddings (§2.2)", () => {
  it("deletes the head, the learned entries it superseded and their embeddings; keeps a cited or boundary entry", async () => {
    const head = await plant(B, { createdAt: ageDays(400) });
    const middle = await plant(B, {
      createdAt: ageDays(500),
      supersededBy: head,
      updatedAt: ageDays(10),
    });
    const tail = await plant(B, {
      createdAt: ageDays(600),
      supersededBy: middle,
      updatedAt: ageDays(10),
    });
    const headEmbedding = await plantEmbedding(B, head);
    const tailEmbedding = await plantEmbedding(B, tail);
    const cited = await plant(B, { createdAt: ageDays(400), lastUsedAt: ageDays(100) });
    const boundary = await plant(B, { createdAt: ageDays(365) });
    const justOver = await plant(B, { createdAt: new Date(ageDays(365).getTime() - 1000) });

    const report = await run(B);
    expect(report).toMatchObject({ retired: 4, purged: 0 });
    for (const id of [head, middle, tail, justOver]) {
      expect(await exists("memory_entries", id), id).toBe(false);
    }
    expect(await exists("embeddings", headEmbedding)).toBe(false);
    expect(await exists("embeddings", tailEmbedding)).toBe(false);
    expect(await exists("memory_entries", cited)).toBe(true);
    expect(await exists("memory_entries", boundary)).toBe(true);
    expect(await exists("embeddings", B.embeddingId)).toBe(true);
  });

  it("keeps a chain whole when a member-written entry is anywhere in it, and never retires member-written entries", async () => {
    const learnedHead = await plant(B, { createdAt: ageDays(400) });
    const memberHistory = await plant(B, {
      origin: "member",
      createdAt: ageDays(500),
      supersededBy: learnedHead,
      updatedAt: ageDays(400),
    });
    const learnedTail = await plant(B, {
      createdAt: ageDays(600),
      supersededBy: memberHistory,
      updatedAt: ageDays(500),
    });
    const memberHead = await plant(B, { origin: "member", createdAt: ageDays(1000) });

    const report = await run(B);
    expect(report.retired).toBe(0);
    for (const id of [learnedHead, memberHistory, memberHead]) {
      expect(await exists("memory_entries", id), id).toBe(true);
    }
    // The learned tail is history past the window that nothing references: the history rule
    // (§2.3) removes it, whatever superseded it. The member-written entry it led to stays.
    expect(report.purged).toBe(1);
    expect(await exists("memory_entries", learnedTail)).toBe(false);
    expect(await row(memberHistory)).toMatchObject({ superseded_by: learnedHead });
  });

  it("neither hangs on nor deletes a crafted superseded_by loop", async () => {
    const one = await plant(B, { createdAt: ageDays(400) });
    const two = await plant(B, {
      createdAt: ageDays(400),
      supersededBy: one,
      updatedAt: ageDays(400),
    });
    await superuser.query("update memory_entries set superseded_by = $2 where id = $1", [one, two]);
    const report = await run(B);
    expect(report).toMatchObject({ retired: 0, purged: 0 });
    expect(await exists("memory_entries", one)).toBe(true);
    expect(await exists("memory_entries", two)).toBe(true);
    await superuser.query("delete from memory_entries where id = any($1::uuid[])", [[one, two]]);
  });
});

describe("switched off (P8-3, ADR 0039): the time off never counts as idle", () => {
  const switchEntry = (entryId: string, disabled: boolean) =>
    db.withOrg(B.orgId, (tx) =>
      setMemoryEntryDisabled(tx, { actorMemberId: B.memberId, entryId, disabled }),
    );
  const switchRepo = (enabled: boolean) =>
    db.withOrg(B.orgId, (tx) =>
      setRepoMemoryEnabled(tx, { actorMemberId: B.memberId, repoId: B.repoId, enabled }),
    );
  const backdateSwitchOn = (id: string, at: Date) =>
    superuser.query("update memory_entries set enabled_at = $2 where id = $1", [id, at]);

  it("leaves a switched-off entry alone however idle", async () => {
    const off = await plant(B, { createdAt: ageDays(400), disabledAt: ageDays(300) });
    const idleOff = await plant(B, { createdAt: ageDays(91), disabledAt: ageDays(50) });
    const on = await plant(B, { createdAt: ageDays(400) });
    await run(B);
    expect(await row(off)).toMatchObject({ confidence: 80, decayed_at: null });
    expect(await row(idleOff)).toMatchObject({ confidence: 80, decayed_at: null });
    expect(await exists("memory_entries", on)).toBe(false);
  });

  it("13 months off, then on: the next run neither retires nor decays it; it ages from the switch-on (fix round 4)", async () => {
    const entry = await plant(B, { createdAt: ageDays(500), disabledAt: ageDays(395) });
    expect(await switchEntry(entry, false)).toMatchObject({ outcome: "switched" });
    await run(B);
    expect(await row(entry)).toMatchObject({ confidence: 80, decayed_at: null });

    // A decay period after the switch-on: one step, not retired.
    await backdateSwitchOn(entry, ageDays(91));
    await run(B);
    expect(await row(entry)).toMatchObject({ confidence: 70, decayed_at: NOW });
    // A year after the switch-on without a citation: retired like any other entry.
    await backdateSwitchOn(entry, ageDays(366));
    await run(B);
    expect(await exists("memory_entries", entry)).toBe(false);
  });

  it("a repository's memory off for 13 months, then on: its entries are not retired or decayed at the next run", async () => {
    const old = await plant(B, { createdAt: ageDays(400) });
    const idle = await plant(B, { createdAt: ageDays(91) });
    expect(await switchRepo(false)).toBe("switched");
    try {
      await run(B);
      expect(await exists("memory_entries", old)).toBe(true);
      expect(await row(idle)).toMatchObject({ confidence: 80, decayed_at: null });
    } finally {
      expect(await switchRepo(true)).toBe("switched");
    }
    await run(B);
    expect(await exists("memory_entries", old)).toBe(true);
    expect(await row(idle)).toMatchObject({ confidence: 80, decayed_at: null });

    // From the switch-on, they age normally.
    await backdateSwitchOn(old, ageDays(366));
    await backdateSwitchOn(idle, ageDays(91));
    await run(B);
    expect(await exists("memory_entries", old)).toBe(false);
    expect(await row(idle)).toMatchObject({ confidence: 70, decayed_at: NOW });
  });
});

describe("history: superseded learned entries past the window, tail first (§2.3)", () => {
  it("removes the unreferenced tail first, then the next one on a later run; keeps the boundary row", async () => {
    const current = await plant(A, { createdAt: ageDays(10), lastUsedAt: ageDays(1) });
    const middle = await plant(A, {
      createdAt: ageDays(300),
      supersededBy: current,
      updatedAt: ageDays(200),
    });
    const tail = await plant(A, {
      createdAt: ageDays(400),
      supersededBy: middle,
      updatedAt: ageDays(200),
    });
    const boundary = await plant(A, {
      createdAt: ageDays(400),
      supersededBy: current,
      updatedAt: ageDays(180),
    });
    const first = await run(A);
    expect(first.purged).toBe(1);
    expect(await exists("memory_entries", tail)).toBe(false);
    expect(await exists("memory_entries", middle)).toBe(true);
    expect(await exists("memory_entries", boundary)).toBe(true);
    const second = await run(A);
    expect(second.purged).toBe(1);
    expect(await exists("memory_entries", middle)).toBe(false);
    expect(await row(current)).toMatchObject({ superseded_by: null, confidence: 80 });
    expect(await run(A, new Date(NOW.getTime() + DAY))).toMatchObject({ purged: 1 });
    expect(await exists("memory_entries", boundary)).toBe(false);
  });

  it("never removes a superseded member-written entry, however old; learned history behind it still goes", async () => {
    const current = await plant(A, { createdAt: ageDays(10), lastUsedAt: ageDays(1) });
    const memberHistory = await plant(A, {
      origin: "member",
      createdAt: ageDays(900),
      supersededBy: current,
      updatedAt: ageDays(800),
    });
    const learnedBehind = await plant(A, {
      createdAt: ageDays(950),
      supersededBy: memberHistory,
      updatedAt: ageDays(900),
    });
    expect(await run(A)).toMatchObject({ purged: 1, retired: 0 });
    expect(await exists("memory_entries", learnedBehind)).toBe(false);
    expect(await row(memberHistory)).toMatchObject({ superseded_by: current });
    expect(await run(A)).toMatchObject({ purged: 0, retired: 0 });
    expect(await exists("memory_entries", memberHistory)).toBe(true);
  });
});

describe("the clock, the windows and the audit trail", () => {
  it("cannot be pushed forward: a clock in the future is clamped to the database clock", async () => {
    const fresh = await plant(A, { createdAt: NOW });
    const old = await plant(A, { createdAt: ageDays(400) });
    const report = await run(A, new Date(Date.now() + 1000 * DAY));
    expect(report.retired).toBeGreaterThanOrEqual(1);
    expect(await exists("memory_entries", fresh)).toBe(true);
    expect(await row(fresh)).toMatchObject({ confidence: 80, decayed_at: null });
    expect(await exists("memory_entries", old)).toBe(false);
    // The audit row records the clamped instant, not the clock the caller claimed (N2).
    const last = (await auditRows(A)).rows.at(-1);
    const recorded = new Date(String((last?.metadata as { asOf: string }).asOf));
    expect(recorded.getTime()).toBeLessThanOrEqual(Date.now());
    expect(recorded.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("refuses windows under the settings table's floors, and an invalid clock, before any SQL (fix round 1, S1)", async () => {
    const victim = await plant(A, { createdAt: ageDays(29) });
    for (const [windows, message] of [
      [{ ...WINDOWS, memoryDecayDays: 0 }, /memoryDecayDays must be an integer of at least 1/],
      [{ ...WINDOWS, memoryUnusedDays: 1.5 }, /memoryUnusedDays must be an integer of at least 30/],
      [
        { ...WINDOWS, memoryUnusedDays: MEMORY_DECAY_MIN_DAYS.memoryUnusedDays - 1 },
        /memoryUnusedDays must be an integer of at least 30/,
      ],
      [
        { ...WINDOWS, memorySupersededDays: MEMORY_DECAY_MIN_DAYS.memorySupersededDays - 1 },
        /memorySupersededDays must be an integer of at least 7/,
      ],
      [{ ...WINDOWS, memorySupersededDays: Number.NaN }, /memorySupersededDays/],
    ] as const) {
      await expect(run(A, NOW, windows)).rejects.toThrow(message);
    }
    expect(MEMORY_DECAY_MIN_DAYS).toEqual({
      memoryDecayDays: 1,
      memoryUnusedDays: MEMORY_UNUSED_MIN_RETENTION_DAYS,
      memorySupersededDays: MEMORY_SUPERSEDED_MIN_RETENTION_DAYS,
    });
    // The floor itself is accepted; a 29-day-old entry is inside it and survives (older learned
    // entries of this org from earlier tests go, as the window says).
    await run(A, NOW, { ...WINDOWS, memoryUnusedDays: MEMORY_DECAY_MIN_DAYS.memoryUnusedDays });
    expect(await exists("memory_entries", victim)).toBe(true);
    await expect(run(A, new Date("garbage"))).rejects.toThrow(/asOf must be a valid Date/);
  });

  it("audits counts only, once per run that changed something, and nothing on an idle run", async () => {
    const before = (await auditRows(B)).rows.length;
    const id = await plant(B, { createdAt: ageDays(91) });
    const report = await run(B);
    expect(report.decayed).toBeGreaterThanOrEqual(1);
    const { rows } = await auditRows(B);
    expect(rows).toHaveLength(before + 1);
    const last = rows.at(-1);
    expect(last).toMatchObject({
      actor_type: "system",
      actor_id: MEMORY_DECAY_ACTOR,
      target_id: "memory_entries",
      metadata: { ...report, asOf: NOW.toISOString() },
    });
    expect(JSON.stringify(last?.metadata)).not.toContain("Planted");
    expect(JSON.stringify(last?.metadata)).not.toContain(id);
    await run(B);
    expect((await auditRows(B)).rows).toHaveLength(before + 1);
  });
});

describe("concurrent tenant transactions: the job never waits (fix rounds 1 and 2, S2 and N4)", () => {
  type Tx = Parameters<Parameters<Db["withOrg"]>[1]>[0];

  /**
   * True once some other backend is blocked on a row lock while running a statement on `table`
   * that contains `fragment` (bounded poll of pg_stat_activity, 5 s), so a test can prove the
   * other side was waiting before it releases what it holds.
   */
  const waitingOnLock = async (table: string, fragment: string): Promise<boolean> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { rows } = await superuser.query(
        `select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and state = 'active'
            and query ilike $1 and query ilike $2`,
        [`%${table}%`, `%${fragment}%`],
      );
      if ((rows.length ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };

  /**
   * Holds a tenant transaction of org B open after `act` ran on it (its row locks stay) and
   * hands back `release`, which lets it commit. The application pool has two connections: one
   * for the held transaction, one for whatever runs meanwhile. No timing is involved: the job
   * either sees the lock (and skips) or does not, and the assertions tell which.
   */
  const hold = async (act: (tx: Tx) => Promise<void>) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acted!: () => void;
    const hasActed = new Promise<void>((resolve) => {
      acted = resolve;
    });
    const held = db.withOrg(B.orgId, async (tx) => {
      await act(tx);
      acted();
      await gate;
    });
    await hasActed;
    return {
      release: async () => {
        release();
        await held;
      },
    };
  };

  it("a supersede still holding the head: the job skips the head (nothing waits), and the chain is whole once the supersede commits (S2)", async () => {
    const head = await plant(B, { createdAt: ageDays(400) });
    const written = await plant(B, { origin: "member", createdAt: ageDays(5), confidence: 90 });
    const supersede = await hold(async (tx) => {
      expect(
        await supersedeMemoryEntry(tx, {
          actorMemberId: B.memberId,
          entryId: written,
          byEntryId: head,
        }),
      ).toBe("superseded");
    });
    // Runs to completion while the supersede holds its locks: the head is skipped, not waited for.
    await run(B);
    expect(await exists("memory_entries", head)).toBe(true);
    await supersede.release();
    expect(await row(written)).toMatchObject({ superseded_by: head, confidence: 90 });
    // The chain now holds a member-written entry: a later run keeps it whole.
    await run(B);
    expect(await exists("memory_entries", head)).toBe(true);
    expect(await row(written)).toMatchObject({ superseded_by: head });
  });

  it("the job holding the head: a supersede that arrives meanwhile finds it gone (not_found) and the member-written entry stays current (S2)", async () => {
    const head = await plant(B, { createdAt: ageDays(400) });
    const written = await plant(B, { origin: "member", createdAt: ageDays(5), confidence: 90 });
    const job = await hold(async (tx) => {
      const report = await decayOrgMemory(tx, { asOf: NOW, windows: WINDOWS });
      expect(report.retired).toBeGreaterThanOrEqual(1);
    });
    // The supersede locks both rows FOR UPDATE and waits for the job's commit (its own choice to
    // wait, never the job's); once it is seen waiting on a lock, the job commits and the
    // supersede then sees the head gone.
    const result = db.withOrg(B.orgId, (tx) =>
      supersedeMemoryEntry(tx, { actorMemberId: B.memberId, entryId: written, byEntryId: head }),
    );
    expect(await waitingOnLock("memory_entries", "for update")).toBe(true);
    await job.release();
    expect(await result).toBe("not_found");
    expect(await exists("memory_entries", head)).toBe(false);
    expect(await row(written)).toMatchObject({ superseded_by: null, confidence: 90 });
  });

  it("the heads are locked before the chain behind them is walked: a supersede that commits in between is seen and the chain kept whole (S2 ordering)", async () => {
    const head = await plant(B, { createdAt: ageDays(400) });
    const written = await plant(B, { origin: "member", createdAt: ageDays(5), confidence: 90 });
    let intercepted = 0;
    // A TenantTx that, right before the heads lock is sent, lets a member-written supersede of
    // the head commit on the other connection. With the lock first, the walk that follows sees
    // the member-written entry in the chain and keeps it whole; a walk done before the lock
    // would have missed it and deleting the head would make that entry current again.
    const report = await db.withOrg(B.orgId, async (tx) => {
      const wrapped = {
        orgId: tx.orgId,
        db: tx.db,
        query: async (sql: string, params?: unknown[]) => {
          if (sql === MEMORY_DECAY_STATEMENTS.lockHeads) {
            intercepted++;
            expect(
              await db.withOrg(B.orgId, (other) =>
                supersedeMemoryEntry(other, {
                  actorMemberId: B.memberId,
                  entryId: written,
                  byEntryId: head,
                }),
              ),
            ).toBe("superseded");
          }
          return tx.query(sql, params);
        },
      } as unknown as Tx;
      return decayOrgMemory(wrapped, { asOf: NOW, windows: WINDOWS });
    });
    expect(intercepted).toBe(1);
    expect(report.retired).toBe(0);
    expect(await exists("memory_entries", head)).toBe(true);
    expect(await row(written)).toMatchObject({ superseded_by: head, confidence: 90 });
  });

  it("a citation still holding the entry: the job skips the decay step; the next run takes it only if the entry is idle again (N4)", async () => {
    const entry = await plant(B, { createdAt: ageDays(91) });
    const citation = await hold(async (tx) => {
      expect(await touchMemoryEntries(tx, [entry])).toBe(1);
    });
    await run(B);
    expect(await row(entry)).toMatchObject({ confidence: 80, decayed_at: null });
    await citation.release();
    await run(B);
    const after = await row(entry);
    expect(after).toMatchObject({ confidence: 80, decayed_at: null });
    expect(after?.last_used_at).not.toBeNull();
  });

  it("a row of the chain behind a retiring head held elsewhere: the whole chain waits for the next run (no wait, no partial chain)", async () => {
    const head = await plant(B, { createdAt: ageDays(400) });
    const behind = await plant(B, {
      createdAt: ageDays(500),
      supersededBy: head,
      updatedAt: ageDays(10),
    });
    const citation = await hold(async (tx) => {
      // A reused unit may still cite a superseded entry's id (ADR 0037 §4).
      expect(await touchMemoryEntries(tx, [behind])).toBe(1);
    });
    await run(B);
    expect(await exists("memory_entries", head)).toBe(true);
    expect(await exists("memory_entries", behind)).toBe(true);
    await citation.release();
    await run(B);
    expect(await exists("memory_entries", head)).toBe(false);
    expect(await exists("memory_entries", behind)).toBe(false);
  });
});

describe("liveOrgs (worker.live_orgs, migration 0019)", () => {
  it("is the worker's alone: the application login is refused", async () => {
    await expect(db.liveOrgs(null, 10)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    const direct = await appPool
      .query("select org_id from worker.live_orgs(null, 10)")
      .catch((error: unknown) => error as pg.DatabaseError);
    expect(direct).toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it("lists live org ids only, in id order, paged by `after`, leaving out scheduled and erasing orgs", async () => {
    const [scheduled, erasing] = await asWorker(pgs.workerUrl, async (w) => [
      await seedOrg(w, newOrgId(), { installationId: 83 }),
      await seedOrg(w, newOrgId(), { installationId: 84 }),
    ]);
    await worker.withOrg(scheduled.orgId, (tx) => scheduleOrgDeletion(tx, 83));
    await worker.withOrg(erasing.orgId, (tx) => scheduleOrgDeletion(tx, 84));
    await superuser.query("alter table orgs disable trigger user");
    try {
      await superuser.query(
        "update orgs set delete_after = now() - interval '1 second' where id = $1",
        [erasing.orgId],
      );
    } finally {
      await superuser.query("alter table orgs enable trigger user");
    }
    expect(await worker.withOrg(erasing.orgId, (tx) => beginOrgErasure(tx))).toBe("started");

    const all = await worker.liveOrgs(null, MAX_LIVE_ORGS_PAGE);
    expect(all).toEqual([...all].sort());
    expect(all).toContain(A.orgId);
    expect(all).toContain(B.orgId);
    expect(all).not.toContain(scheduled.orgId);
    expect(all).not.toContain(erasing.orgId);
    const first = await worker.liveOrgs(null, 1);
    expect(first).toEqual([all[0]]);
    const rest = await worker.liveOrgs(first[0] as OrgId, MAX_LIVE_ORGS_PAGE);
    expect(rest).toEqual(all.slice(1));
    // Ids only: the function has one column.
    const shape = await workerPool.query("select * from worker.live_orgs(null, 1)");
    expect(shape.fields.map((f) => f.name)).toEqual(["org_id"]);
  });

  it("refuses a limit outside 1..MAX_LIVE_ORGS_PAGE and a malformed cursor before any SQL", async () => {
    await expect(worker.liveOrgs(null, 0)).rejects.toThrow(/limit/);
    await expect(worker.liveOrgs(null, MAX_LIVE_ORGS_PAGE + 1)).rejects.toThrow(/limit/);
    await expect(worker.liveOrgs("not-a-uuid" as OrgId, 1)).rejects.toThrow(/uuid/);
  });
});

describe("runMemoryDecay", () => {
  it("visits every live org as the worker, each in its own tenant transaction, with the settings' windows", async () => {
    const a = await plant(A, { createdAt: ageDays(400) });
    const b = await plant(B, { createdAt: ageDays(91) });
    const report = await runMemoryDecay(worker, { clock: fixedClock(NOW) });
    expect(report.ranAt).toEqual(NOW);
    expect(report.orgs).toBeGreaterThanOrEqual(2);
    expect(report.failures).toEqual([]);
    expect(report.retired).toBeGreaterThanOrEqual(1);
    expect(report.decayed).toBeGreaterThanOrEqual(1);
    expect(await exists("memory_entries", a)).toBe(false);
    expect(await row(b)).toMatchObject({ confidence: 70, decayed_at: NOW });
  });

  it("fails closed as the application login: no org list, nothing touched", async () => {
    const id = await plant(A, { createdAt: ageDays(400) });
    await expect(runMemoryDecay(db, { clock: fixedClock(NOW) })).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    expect(await exists("memory_entries", id)).toBe(true);
  });
});
