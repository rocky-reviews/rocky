import type { OrgId } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, TenantContextError, type Db } from "./client.js";
import * as schema from "./schema.js";
import { CONTAINER_TIMEOUT_MS, newOrgId, seedOrg, startPostgres } from "./testing/index.js";

/** P2-2: the tenant-scoped client. The isolation suite covers the policies table by table. */

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let pool: pg.Pool;
let db: Db;
let orgA: OrgId;
let orgB: OrgId;

beforeAll(async () => {
  pgs = await startPostgres();
  // One physical connection, so "stale session state" tests hit the same connection withOrg uses.
  pool = new pg.Pool({ connectionString: pgs.appUrl, max: 1 });
  db = createDb({ pool });
  orgA = newOrgId();
  orgB = newOrgId();
  await seedOrg(db, orgA);
  await seedOrg(db, orgB);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await pgs?.stop();
});

const repoOrgIds = async (orgId: OrgId): Promise<string[]> =>
  db.withOrg(orgId, async (tx) => (await tx.db.select().from(schema.repos)).map((r) => r.orgId));

describe("withOrg", () => {
  it("scopes Drizzle and raw queries to the org", async () => {
    expect(await repoOrgIds(orgA)).toEqual([orgA]);
    await db.withOrg(orgB, async (tx) => {
      const raw = await tx.query<{ org_id: string }>("select org_id from repos");
      expect(raw.rows).toEqual([{ org_id: orgB }]);
      expect(tx.orgId).toBe(orgB);
    });
  });

  it("rejects an org id that is not a uuid before touching the database", async () => {
    const fn = async () => Promise.resolve("never");
    await expect(db.withOrg("" as OrgId, fn)).rejects.toThrow(TenantContextError);
    await expect(db.withOrg("' or 1=1 --" as OrgId, fn)).rejects.toThrow(TenantContextError);
    await expect(db.withOrg("00000000-0000-0000-0000-00000000000g" as OrgId, fn)).rejects.toThrow(
      TenantContextError,
    );
  });

  it("commits on success and rolls back when fn throws", async () => {
    await db.withOrg(orgA, async (tx) => {
      await tx.db.insert(schema.memoryEntries).values({ kind: "note", content: "committed" });
    });
    await expect(
      db.withOrg(orgA, async (tx) => {
        await tx.db.insert(schema.memoryEntries).values({ kind: "note", content: "rolled back" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const contents = await db.withOrg(orgA, async (tx) =>
      (await tx.db.select({ c: schema.memoryEntries.content }).from(schema.memoryEntries)).map(
        (r) => r.c,
      ),
    );
    expect(contents).toContain("committed");
    expect(contents).not.toContain("rolled back");
  });

  it("does not leak a stale session-level app.org_id into or out of a transaction", async () => {
    await pool.query("select set_config('app.org_id', $1, false)", [orgB]);
    expect(await repoOrgIds(orgA)).toEqual([orgA]);
    // After withOrg the connection carries no tenant: a bare query sees nothing.
    const bare = await pool.query("select org_id from repos");
    expect(bare.rowCount).toBe(0);
    const setting = await pool.query<{ v: string | null }>(
      "select current_setting('app.org_id', true) as v",
    );
    expect(setting.rows[0]?.v ?? "").toBe("");
  });

  it("aborts the transaction if code inside it switches tenant", async () => {
    await expect(
      db.withOrg(orgA, async (tx) => {
        await tx.db.insert(schema.memoryEntries).values({ kind: "note", content: "pre-switch" });
        await tx.query("select set_config('app.org_id', $1, true)", [orgB]);
        return "should not commit";
      }),
    ).rejects.toThrow(TenantContextError);
    const contents = await db.withOrg(orgA, async (tx) =>
      (await tx.db.select({ c: schema.memoryEntries.content }).from(schema.memoryEntries)).map(
        (r) => r.c,
      ),
    );
    expect(contents).not.toContain("pre-switch");
    // RESET inside the transaction is a switch too (to "no tenant").
    await expect(
      db.withOrg(orgA, async (tx) => {
        await tx.query("reset app.org_id");
      }),
    ).rejects.toThrow(TenantContextError);
  });

  it("refuses a nested withOrg for a different org and keeps the outer scope intact", async () => {
    const seen = await db.withOrg(orgA, async (outer) => {
      await expect(db.withOrg(orgB, async () => Promise.resolve("inner"))).rejects.toThrow(
        TenantContextError,
      );
      return (await outer.db.select().from(schema.repos)).map((r) => r.orgId);
    });
    expect(seen).toEqual([orgA]);
  });

  it("joins a nested withOrg for the same org (savepoint), rolling back only the inner part", async () => {
    await db.withOrg(orgA, async (outer) => {
      await outer.db.insert(schema.memoryEntries).values({ kind: "note", content: "outer" });
      await db.withOrg(orgA, async (inner) => {
        expect(inner.orgId).toBe(orgA);
        const rows = await inner.db.select().from(schema.memoryEntries);
        expect(rows.map((r) => r.content)).toContain("outer");
      });
      await expect(
        db.withOrg(orgA, async (inner) => {
          await inner.db
            .insert(schema.memoryEntries)
            .values({ kind: "note", content: "inner-fail" });
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
    });
    const contents = await db.withOrg(orgA, async (tx) =>
      (await tx.db.select({ c: schema.memoryEntries.content }).from(schema.memoryEntries)).map(
        (r) => r.c,
      ),
    );
    expect(contents).toContain("outer");
    expect(contents).not.toContain("inner-fail");
  });

  it("can be created from a connection string and closed", async () => {
    const own = createDb({ connectionString: pgs.appUrl, max: 2 });
    const rows = await own.withOrg(orgB, async (tx) => tx.db.select().from(schema.orgs));
    expect(rows.map((r) => r.id)).toEqual([orgB]);
    await own.close();
  });
});
