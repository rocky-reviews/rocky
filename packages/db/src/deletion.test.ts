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

/** Time travel: move the grace deadline into the past without the trigger pushing it back. */
const makeDue = async (orgId: string): Promise<void> => {
  await superuser.query("alter table orgs disable trigger orgs_deletion_grace");
  try {
    await superuser.query(
      "update orgs set delete_after = now() - interval '1 second' where id = $1",
      [orgId],
    );
  } finally {
    await superuser.query("alter table orgs enable trigger orgs_deletion_grace");
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

  it("the app role cannot delete an org row directly, even its own", async () => {
    const c = await seedOrg(db, newOrgId(), { installationId: 3 });
    const error = await pgError(db.withOrg(c.orgId, (tx) => tx.query("delete from orgs")));
    // The cascade into audit_events runs as the table owner and hits the append-only trigger.
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(error.message).toMatch(/append-only/);
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, c.orgId)).toBe(1);
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
