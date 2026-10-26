import type { OrgId } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import * as schema from "./schema.js";
import {
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
} from "./testing/index.js";

/**
 * Review #4: deleting an org must remove every row it owns (uninstall / erasure, P3-3) even
 * though audit_events is append-only. The only path is retention.delete_org, which requires
 * the org to be past its deletion grace period.
 */

const INSUFFICIENT_PRIVILEGE = "42501";
const DAY = 86_400_000;

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let superuser: pg.Pool;
let db: Db;
let a: SeededOrg;
let b: SeededOrg;
let tables: { name: string; tenantColumn: string }[];

const pgError = async (promise: Promise<unknown>): Promise<pg.DatabaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error("expected the query to fail");
};

/** Superuser view (bypasses RLS): how many rows of `org` are left in `table`. */
const rowsOf = async (table: { name: string; tenantColumn: string }, orgId: string) => {
  const { rows } = await superuser.query<{ n: string }>(
    `select count(*)::text as n from public."${table.name}" where "${table.tenantColumn}" = $1`,
    [orgId],
  );
  return Number(rows[0]?.n);
};

/** An org row and nothing else: no fixture rows, no audit rows. */
const bareOrg = async (installationId: number): Promise<OrgId> => {
  const orgId = newOrgId();
  await db.withOrg(orgId, (tx) =>
    tx.db
      .insert(schema.orgs)
      .values({ id: orgId, installationId, login: `bare-${installationId}`, kind: "organization" }),
  );
  return orgId;
};

const waitFor = async (condition: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Time travel: move the grace deadline into the past without the trigger pushing it back. */
const makeDue = async (orgId: string): Promise<void> => {
  // Both the clamp (BEFORE) and the audit (AFTER) trigger stay out of the way.
  await superuser.query("alter table orgs disable trigger user");
  try {
    await superuser.query(
      "update orgs set delete_after = now() - interval '1 second' where id = $1",
      [orgId],
    );
  } finally {
    await superuser.query("alter table orgs enable trigger user");
  }
};

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 });
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  a = await seedOrg(db, newOrgId(), { installationId: 1 });
  b = await seedOrg(db, newOrgId(), { installationId: 2 });
  const { rows } = await superuser.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname = 'public' order by 1`,
  );
  tables = rows.map((r) => ({ name: r.name, tenantColumn: r.name === "orgs" ? "id" : "org_id" }));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

describe("retention.delete_org", () => {
  it("refuses an org that is not scheduled for deletion", async () => {
    const error = await pgError(db.deleteOrg(a.orgId));
    expect(error.message).toMatch(/not scheduled/);
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, a.orgId)).toBe(1);
  });

  it("refuses an org still inside its grace period, which the app cannot shorten", async () => {
    // The app schedules deletion "now"; the trigger enforces the configured grace (7 days).
    const deleteAfter = await db.withOrg(a.orgId, async (tx) => {
      await tx.db.update(schema.orgs).set({ deleteAfter: new Date() });
      const [row] = await tx.db.select({ d: schema.orgs.deleteAfter }).from(schema.orgs);
      return row?.d ?? null;
    });
    expect(deleteAfter).not.toBeNull();
    expect(deleteAfter!.getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY);
    const error = await pgError(db.deleteOrg(a.orgId));
    expect(error.message).toMatch(/grace/);
    // Backdating directly is refused the same way: the trigger moves it forward again.
    const backdated = await db.withOrg(a.orgId, async (tx) => {
      await tx.db.update(schema.orgs).set({ deleteAfter: new Date(Date.now() - DAY) });
      const [row] = await tx.db.select({ d: schema.orgs.deleteAfter }).from(schema.orgs);
      return row?.d ?? null;
    });
    expect(backdated!.getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY);
  });

  it("audits scheduling and cancelling a deletion from the trigger (re-review D)", async () => {
    const actions = async () =>
      db.withOrg(a.orgId, async (tx) =>
        (await tx.db.select().from(schema.auditEvents).orderBy(schema.auditEvents.id))
          .filter((e) => e.action.startsWith("org.deletion_"))
          .map((e) => ({ action: e.action, target: e.targetId, metadata: e.metadata })),
      );
    // The previous test scheduled twice (schedule, then an attempted backdate).
    const scheduled = await actions();
    expect(scheduled.map((e) => e.action)).toEqual([
      "org.deletion_scheduled",
      "org.deletion_scheduled",
    ]);
    for (const e of scheduled) {
      expect(e.target).toBe(a.orgId);
      expect(new Date(String(e.metadata["delete_after"])).getTime()).toBeGreaterThan(
        Date.now() + 6.9 * DAY,
      );
    }
    await db.withOrg(a.orgId, (tx) => tx.db.update(schema.orgs).set({ deleteAfter: null }));
    expect((await actions()).map((e) => e.action)).toEqual([
      "org.deletion_scheduled",
      "org.deletion_scheduled",
      "org.deletion_cancelled",
    ]);
    // Touching other columns, or re-saving the same value, writes nothing.
    await db.withOrg(a.orgId, (tx) =>
      tx.db.update(schema.orgs).set({ settings: { theme: "slate" }, deleteAfter: null }),
    );
    expect(await actions()).toHaveLength(3);
    // Schedule again so the deletion test below has something to execute.
    await db.withOrg(a.orgId, (tx) => tx.db.update(schema.orgs).set({ deleteAfter: new Date() }));
    expect((await actions()).at(-1)?.action).toBe("org.deletion_scheduled");
  });

  it("can insert an org with delete_after already set: clamp before, audit after (re-review H)", async () => {
    const orgId = newOrgId();
    const result = await db.withOrg(orgId, async (tx) => {
      const [inserted] = await tx.db
        .insert(schema.orgs)
        .values({
          id: orgId,
          installationId: 99,
          login: "org-99",
          kind: "organization",
          deleteAfter: new Date(),
        })
        .returning({ deleteAfter: schema.orgs.deleteAfter });
      const events = await tx.db.select().from(schema.auditEvents);
      return {
        deleteAfter: inserted?.deleteAfter ?? null,
        events: events.map((e) => ({ action: e.action, target: e.targetId })),
      };
    });
    expect(result.deleteAfter!.getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY);
    expect(result.events).toEqual([{ action: "org.deletion_scheduled", target: orgId }]);
  });

  it("the app role cannot delete an org row directly, even its own (final review #2)", async () => {
    // An org with no audit rows: nothing but the privilege itself stands in the way of a
    // cascade through every tenant table, so the privilege must not exist.
    const orgId = await bareOrg(3);
    expect(await rowsOf({ name: "audit_events", tenantColumn: "org_id" }, orgId)).toBe(0);
    for (const sql of ["delete from orgs", "delete from orgs where id = $1"]) {
      const error = await pgError(
        db.withOrg(orgId, (tx) => tx.query(sql, sql.includes("$1") ? [orgId] : [])),
      );
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      expect(error.message, sql).toMatch(/permission denied for table orgs/);
    }
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, orgId)).toBe(1);
    // Even if the privilege came back, the restrictive policy refuses every row.
    const { rows } = await superuser.query<{ n: string }>(
      `select count(*)::text as n from pg_policies
        where tablename = 'orgs' and permissive = 'RESTRICTIVE' and cmd = 'DELETE'
          and 'rocky_app' = any(roles) and qual = 'false'`,
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("waits for an in-flight tenant write instead of failing on its audit row (final review #5)", async () => {
    // Connection 1 inserts an audit row for the org and keeps its transaction open: the FK
    // check holds KEY SHARE on the orgs row. Connection 2 runs delete_org, which must block on
    // its FOR UPDATE until connection 1 commits, then delete the new audit row itself. Without
    // the lock it would delete audit_events first, then cascade into the freshly committed row
    // as the table owner, where the append-only trigger aborts the erasure.
    const orgId = await bareOrg(4);
    await makeDue(orgId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted = false;
    const writer = db.withOrg(orgId, async (tx) => {
      await tx.db.insert(schema.auditEvents).values({
        actorType: "system",
        actorId: "late-writer",
        action: "late.write",
        targetType: "org",
        targetId: orgId,
      });
      inserted = true;
      await gate;
    });
    await waitFor(() => inserted);
    const deleter = db.deleteOrg(orgId);
    // The deleter is blocked on a row lock held by the writer's transaction.
    await waitFor(async () => {
      const { rows } = await superuser.query<{ n: string }>(
        `select count(*)::text as n from pg_stat_activity
          where wait_event_type = 'Lock' and query like '%retention.delete_org%'`,
      );
      return rows[0]?.n === "1";
    });
    release();
    await writer;
    const report = await deleter;
    expect(report).toEqual(
      expect.arrayContaining([
        { table: "audit_events", deleted: 1 },
        { table: "orgs", deleted: 1 },
      ]),
    );
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, orgId)).toBe(0);
    expect(await rowsOf({ name: "audit_events", tenantColumn: "org_id" }, orgId)).toBe(0);
  });

  it("deletes every row of a due org from every tenant table and nothing of other orgs", async () => {
    expect(tables.length).toBeGreaterThanOrEqual(13);
    await makeDue(a.orgId);
    const report = await db.deleteOrg(a.orgId);
    expect(report).toEqual(
      expect.arrayContaining([
        { table: "orgs", deleted: 1 },
        { table: "audit_events", deleted: expect.any(Number) as number },
      ]),
    );
    expect(report.find((r) => r.table === "audit_events")?.deleted).toBeGreaterThan(0);
    for (const t of tables) {
      expect(await rowsOf(t, a.orgId), t.name).toBe(0);
      expect(await rowsOf(t, b.orgId), t.name).toBe(1);
    }
    // Gone means gone: a second call finds nothing to delete.
    const again = await pgError(db.deleteOrg(a.orgId));
    expect(again.message).toMatch(/not scheduled/);
  });
});
