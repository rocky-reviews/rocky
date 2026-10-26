import { randomBytes, randomUUID } from "node:crypto";
import type { OrgId } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  beginOrgErasure,
  bindInstallation,
  cancelOrgDeletion,
  insertInstallationOrg,
  scheduleOrgDeletion,
} from "./installations.js";
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
 * the org to be past its deletion grace period. Since P3-3 (migration 0007) only the worker
 * login creates orgs and runs the erasure; the server's login can do neither.
 */

const INSUFFICIENT_PRIVILEGE = "42501";
const DAY = 86_400_000;

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let superuser: pg.Pool;
/** The server's login (rocky_app). */
let db: Db;
/** The worker's login (rocky_app + rocky_worker). */
let worker: Db;
let a: SeededOrg;
let b: SeededOrg;
let tables: { name: string; tenantColumn: string }[];

const pgError = async (promise: Promise<unknown>): Promise<pg.DatabaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    // Drizzle wraps the driver error ("Failed query: …") and keeps it as the cause.
    if (error instanceof Error && error.cause instanceof pg.DatabaseError) return error.cause;
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

/** An org row and nothing else: no fixture rows, no audit rows. Created by the worker. */
const bareOrg = async (installationId: number): Promise<OrgId> => {
  const orgId = newOrgId();
  await worker.withOrg(orgId, (tx) =>
    tx.db.insert(schema.orgs).values({
      id: orgId,
      installationId,
      accountId: 500_000 + installationId,
      login: `bare-${installationId}`,
      kind: "organization",
    }),
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
  worker = createDb({ connectionString: pgs.workerUrl, max: 2 });
  a = await seedOrg(worker, newOrgId(), { installationId: 1 });
  b = await seedOrg(worker, newOrgId(), { installationId: 2 });
  const { rows } = await superuser.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname = 'public' order by 1`,
  );
  tables = rows.map((r) => ({ name: r.name, tenantColumn: r.name === "orgs" ? "id" : "org_id" }));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await worker?.close();
  await superuser?.end();
  await pgs?.stop();
});

describe("retention.delete_org", () => {
  it("refuses an org that is not scheduled for deletion", async () => {
    const error = await pgError(worker.deleteOrg(a.orgId));
    expect(error.message).toMatch(/not scheduled/);
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, a.orgId)).toBe(1);
  });

  it("refuses an org still inside its grace period, which the app cannot shorten", async () => {
    // The worker schedules deletion "now" (since review round 1, H1, only the worker may write
    // delete_after; the server's refusal is in the H1 suite below); the trigger enforces the
    // configured grace (7 days).
    const deleteAfter = await worker.withOrg(a.orgId, async (tx) => {
      await tx.db.update(schema.orgs).set({ deleteAfter: new Date() });
      const [row] = await tx.db.select({ d: schema.orgs.deleteAfter }).from(schema.orgs);
      return row?.d ?? null;
    });
    expect(deleteAfter).not.toBeNull();
    expect(deleteAfter!.getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY);
    const error = await pgError(worker.deleteOrg(a.orgId));
    expect(error.message).toMatch(/grace/);
    // Backdating directly is refused the same way: the trigger moves it forward again.
    const backdated = await worker.withOrg(a.orgId, async (tx) => {
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
    await worker.withOrg(a.orgId, (tx) => tx.db.update(schema.orgs).set({ deleteAfter: null }));
    expect((await actions()).map((e) => e.action)).toEqual([
      "org.deletion_scheduled",
      "org.deletion_scheduled",
      "org.deletion_cancelled",
    ]);
    // Touching other columns, or re-saving the same value, writes nothing.
    await worker.withOrg(a.orgId, (tx) =>
      tx.db.update(schema.orgs).set({ settings: { theme: "slate" }, deleteAfter: null }),
    );
    expect(await actions()).toHaveLength(3);
    // Schedule again so the deletion test below has something to execute.
    await worker.withOrg(a.orgId, (tx) =>
      tx.db.update(schema.orgs).set({ deleteAfter: new Date() }),
    );
    expect((await actions()).at(-1)?.action).toBe("org.deletion_scheduled");
  });

  it("can insert an org with delete_after already set: clamp before, audit after (re-review H)", async () => {
    const orgId = newOrgId();
    const result = await worker.withOrg(orgId, async (tx) => {
      const [inserted] = await tx.db
        .insert(schema.orgs)
        .values({
          id: orgId,
          installationId: 99,
          accountId: 99_099,
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
    const deleter = worker.deleteOrg(orgId);
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
    const report = await worker.deleteOrg(a.orgId);
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
    const again = await pgError(worker.deleteOrg(a.orgId));
    expect(again.message).toMatch(/not scheduled/);
  });
});

describe("org creation and identity (P3-3, migration 0007)", () => {
  it("only the worker login creates orgs; the server login is refused", async () => {
    const orgId = newOrgId();
    const error = await pgError(
      db.withOrg(orgId, (tx) =>
        tx.db.insert(schema.orgs).values({
          id: orgId,
          installationId: 31,
          accountId: 31_031,
          login: "planted",
          kind: "organization",
        }),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(error.message).toMatch(/permission denied for table orgs/);
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, orgId)).toBe(0);
    // The worker still goes through the tenant policy: it cannot create an org other than the
    // tenant of its transaction.
    const other = newOrgId();
    const forged = await pgError(
      worker.withOrg(orgId, (tx) =>
        tx.db.insert(schema.orgs).values({
          id: other,
          installationId: 32,
          accountId: 32_032,
          login: "other",
          kind: "organization",
        }),
      ),
    );
    expect(forged.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, other)).toBe(0);
  });

  it("the server login cannot rebind an installation or change an org's identity", async () => {
    for (const [sql, value] of [
      ["update orgs set installation_id = $1", 777],
      ["update orgs set account_id = $1", 778],
      ["update orgs set forge = $1", "gitlab"],
    ] as const) {
      const error = await pgError(db.withOrg(b.orgId, (tx) => tx.query(sql, [value])));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // The worker may rebind the installation (a reinstall), never the account or the forge.
    await worker.withOrg(b.orgId, (tx) => tx.query("update orgs set installation_id = 777"));
    await worker.withOrg(b.orgId, (tx) => tx.query("update orgs set installation_id = 2"));
    for (const sql of ["update orgs set account_id = 779", "update orgs set forge = 'gitlab'"]) {
      const error = await pgError(worker.withOrg(b.orgId, (tx) => tx.query(sql)));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const { rows } = await superuser.query<{ installation_id: string; forge: string }>(
      "select installation_id::text, forge from orgs where id = $1",
      [b.orgId],
    );
    expect(rows[0]).toEqual({ installation_id: "2", forge: "github" });
  });

  it("binds one org per (forge, installation) and one per (forge, account)", async () => {
    const UNIQUE_VIOLATION = "23505";
    const accountOfB = await superuser.query<{ account_id: string }>(
      "select account_id::text from orgs where id = $1",
      [b.orgId],
    );
    for (const values of [
      { installationId: 2, accountId: 41_041 },
      { installationId: 41, accountId: Number(accountOfB.rows[0]?.account_id) },
    ]) {
      const orgId = newOrgId();
      const error = await pgError(
        worker.withOrg(orgId, (tx) =>
          tx.db
            .insert(schema.orgs)
            .values({ id: orgId, ...values, login: "dup", kind: "organization" }),
        ),
      );
      expect(error.code, JSON.stringify(values)).toBe(UNIQUE_VIOLATION);
    }
  });
});

describe("the deletion sweep's database side (P3-3)", () => {
  it("the server login can neither list due orgs nor erase one", async () => {
    const orgId = await bareOrg(50);
    await makeDue(orgId);
    const appPool = new pg.Pool({ connectionString: pgs.appUrl, max: 1 });
    try {
      for (const [sql, params] of [
        ["select * from retention.orgs_due_for_deletion(10)", []],
        ["select * from retention.delete_org($1)", [orgId]],
      ] as const) {
        const error = await pgError(appPool.query(sql, [...params]));
        expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    } finally {
      await appPool.end();
    }
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, orgId)).toBe(1);
    // Clean up through the real path so later tests see only their own due orgs.
    await worker.deleteOrg(orgId);
  });

  it("lists only orgs past their grace period, by the database clock", async () => {
    const due = await bareOrg(51);
    const graced = await bareOrg(52);
    const idle = await bareOrg(53);
    await makeDue(due);
    await worker.withOrg(graced, (tx) =>
      tx.db.update(schema.orgs).set({ deleteAfter: new Date() }),
    );
    const rows = await worker.orgsDueForDeletion(100);
    const listed = rows.map((r) => r.orgId);
    expect(listed).toContain(due);
    expect(listed).not.toContain(graced);
    expect(listed).not.toContain(idle);
    // What the sweep needs to re-verify with the forge (review round 1, S1c) and to resume.
    expect(rows.find((r) => r.orgId === due)).toEqual({
      orgId: due,
      forge: "github",
      installationId: 51,
      erasing: false,
    });
    await expect(worker.orgsDueForDeletion(1.5)).rejects.toThrow(/integer/);
    await worker.deleteOrg(due);
    expect((await worker.orgsDueForDeletion(100)).map((r) => r.orgId)).not.toContain(due);
  });

  it("is structural: every column that holds an org id, in any schema, is emptied for the erased org", async () => {
    const c = await seedOrg(worker, newOrgId(), { installationId: 60, accountId: 60_060 });
    const d = await seedOrg(worker, newOrgId(), { installationId: 61, accountId: 61_061 });
    // Inbox rows: finished ones for c (by installation, and by account under an older,
    // unbound installation), a pending redelivery for c's installation (kept: work not yet done,
    // but loses the sender and the login, review round 1 L4), a pending pull request of c's
    // installation (deleted: nobody will process it for an erased org, L4), one finished for d.
    // Review round 2 (C): rows of the account under another installation that is pending, or
    // bound to a live org (a reinstall during the erasure), are not c's and stay untouched.
    const delivery = (installationId: number, accountId: number) => ({
      forge: "github" as const,
      deliveryId: randomUUID(),
      payloadSha256: randomBytes(32).toString("hex"),
      event: {
        type: "installation.created" as const,
        installationId,
        account: { id: accountId, login: `acct-${accountId}`, kind: "organization" as const },
        sender: { id: 7, login: "installer" },
      },
    });
    const finishedC = delivery(60, 60_060);
    const finishedCOld = delivery(59, 60_060);
    const pendingC = delivery(62, 60_060);
    const pendingSameC = {
      ...delivery(60, 60_060),
      event: { ...delivery(60, 60_060).event, sender: { id: 8, login: "redeliverer" } },
    };
    const finishedE = delivery(63, 60_060);
    const finishedD = delivery(61, 61_061);
    const pendingPrC = {
      forge: "github" as const,
      deliveryId: randomUUID(),
      payloadSha256: randomBytes(32).toString("hex"),
      event: {
        type: "pull_request.opened" as const,
        installationId: 60,
        repositoryId: 9,
        number: 3,
        headSha: "b".repeat(40),
        merged: false,
      },
    };
    for (const row of [
      finishedC,
      finishedCOld,
      pendingC,
      pendingSameC,
      finishedE,
      finishedD,
      pendingPrC,
    ]) {
      expect(await db.recordWebhookDelivery(row)).toBe("queued");
    }
    await superuser.query(
      `update app.webhook_deliveries set processed_at = now(), outcome = 'test'
        where delivery_id = any($1)`,
      [[finishedC.deliveryId, finishedCOld.deliveryId, finishedD.deliveryId, finishedE.deliveryId]],
    );

    // Every column that can hold an org id: anything named org_id (any schema), and every
    // column with a foreign key to orgs. The tombstone table is the one documented exception:
    // it records the erased org's id as evidence that the erasure ran.
    const { rows: columns } = await superuser.query<{ table: string; column: string }>(
      `select format('%I.%I', c.table_schema, c.table_name) as "table", c.column_name as "column"
         from information_schema.columns c
        where c.column_name = 'org_id' and c.table_schema not in ('pg_catalog', 'information_schema')
       union
       select format('%I.%I', n.nspname, cl.relname), a.attname
         from pg_constraint k
         join pg_class cl on cl.oid = k.conrelid
         join pg_namespace n on n.oid = cl.relnamespace
         join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
        where k.contype = 'f' and k.confrelid = 'public.orgs'::regclass
       union
       select 'public.orgs', 'id'
       order by 1, 2`,
    );
    const holders = columns.filter((c) => c.table !== "app.org_deletions");
    expect(columns.map((c) => c.table)).toContain("app.org_deletions");
    // Every tenant table is in the list (the isolation suite proves each has a fixture row).
    expect(new Set(holders.map((h) => h.table)).size).toBeGreaterThanOrEqual(13);
    const count = async (h: { table: string; column: string }, orgId: string) => {
      const { rows } = await superuser.query<{ n: string }>(
        `select count(*)::text as n from ${h.table} where ${h.column} = $1`,
        [orgId],
      );
      return Number(rows[0]?.n);
    };
    // Review round 1 (N1): every holder has a row for c before, so "0 after" proves something.
    for (const h of holders) {
      expect(await count(h, c.orgId), `${h.table}.${h.column} before`).toBeGreaterThan(0);
    }
    // Outside public, rows are tied to an org through its installation or account id instead of
    // an org id. Pin the tables that do so: a new one must be added to delete_org and here.
    const { rows: keyedByForgeIds } = await superuser.query<{ table: string }>(
      `select distinct format('%I.%I', c.table_schema, c.table_name) as "table"
         from information_schema.columns c join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.column_name in ('installation_id', 'account_id') and t.table_type = 'BASE TABLE'
          and c.table_schema not in ('public', 'pg_catalog', 'information_schema')
        order by 1`,
    );
    // app.webhook_queue holds only (forge, installation id, lane) and a time: no personal data;
    // a stale row (no pending delivery left) is dropped by the next claim (review round 3).
    expect(keyedByForgeIds.map((r) => r.table)).toEqual([
      "app.org_deletions",
      "app.webhook_deliveries",
      "app.webhook_queue",
    ]);

    await makeDue(c.orgId);
    // The account reinstalls while c is being erased: a fresh, live org e for installation 63.
    expect(await worker.withOrg(c.orgId, (tx) => beginOrgErasure(tx))).toBe("started");
    const e = newOrgId();
    await worker.withOrg(e, (tx) =>
      insertInstallationOrg(tx, {
        forge: "github",
        installationId: 63,
        accountId: 60_060,
        login: "acct-60060",
        kind: "organization",
        installerForgeUserId: 7,
      }),
    );
    const report = await worker.deleteOrg(c.orgId);
    expect(report).toEqual(
      expect.arrayContaining([
        { table: "orgs", deleted: 1 },
        { table: "webhook_deliveries", deleted: 3 },
      ]),
    );

    for (const h of holders) {
      expect(await count(h, c.orgId), `${h.table}.${h.column} after`).toBe(0);
      if (h.column === "org_id" || h.table === "public.orgs") {
        expect(await count(h, d.orgId), `${h.table}.${h.column} other org`).toBeGreaterThan(0);
      }
    }
    const inbox = await superuser.query<{ delivery_id: string }>(
      "select delivery_id from app.webhook_deliveries where delivery_id = any($1) order by 1",
      [
        [
          finishedC.deliveryId,
          finishedCOld.deliveryId,
          pendingC.deliveryId,
          finishedD.deliveryId,
          pendingPrC.deliveryId,
          pendingSameC.deliveryId,
          finishedE.deliveryId,
        ],
      ],
    );
    expect(inbox.rows.map((r) => r.delivery_id)).toEqual(
      [
        pendingC.deliveryId,
        pendingSameC.deliveryId,
        finishedD.deliveryId,
        finishedE.deliveryId,
      ].sort(),
    );
    // The surviving row of the erased installation keeps ids only; everything else is untouched.
    const events = await superuser.query<{ delivery_id: string; event: unknown }>(
      "select delivery_id, event from app.webhook_deliveries where delivery_id = any($1)",
      [[pendingC.deliveryId, pendingSameC.deliveryId, finishedD.deliveryId, finishedE.deliveryId]],
    );
    const eventOf = (id: string) => events.rows.find((r) => r.delivery_id === id)?.event;
    expect(eventOf(pendingSameC.deliveryId)).toEqual({
      ...pendingSameC.event,
      account: { ...pendingSameC.event.account, login: "erased" },
      sender: null,
    });
    expect(eventOf(pendingC.deliveryId)).toEqual(pendingC.event);
    expect(eventOf(finishedE.deliveryId)).toEqual(finishedE.event);
    expect(eventOf(finishedD.deliveryId)).toEqual(finishedD.event);
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, e)).toBe(1);
    const tombstone = await superuser.query(
      `select forge, installation_id::text, audit_events_deleted > 0 as audited,
              inbox_rows_deleted::text, inbox_rows_scrubbed::text, deleted_at <= now() as stamped
         from app.org_deletions where org_id = $1`,
      [c.orgId],
    );
    expect(tombstone.rows).toEqual([
      {
        forge: "github",
        installation_id: "60",
        audited: true,
        inbox_rows_deleted: "3",
        inbox_rows_scrubbed: "1",
        stamped: true,
      },
    ]);
  });

  it("keeps the erasure record append-only and out of the application's reach", async () => {
    const orgId = await bareOrg(70);
    await makeDue(orgId);
    await worker.deleteOrg(orgId);
    for (const sql of [
      "update app.org_deletions set installation_id = 1 where org_id = $1",
      "delete from app.org_deletions where org_id = $1",
    ]) {
      const error = await pgError(superuser.query(sql, [orgId]));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      expect(error.message, sql).toMatch(/append-only/);
    }
    const appPool = new pg.Pool({ connectionString: pgs.appUrl, max: 1 });
    try {
      for (const sql of [
        "select * from app.org_deletions",
        "insert into app.org_deletions (org_id, forge, installation_id, was_due, audit_events_deleted, inbox_rows_deleted) values (gen_random_uuid(), 'github', 1, now(), 0, 0)",
      ]) {
        const error = await pgError(appPool.query(sql));
        expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    } finally {
      await appPool.end();
    }
  });
});

describe("the deletion schedule belongs to the worker (review round 1, H1)", () => {
  const CHECK_VIOLATION = "23514";

  it("the server login cannot set, push out, clear or re-target a deletion, or change the installer", async () => {
    const orgId = await bareOrg(80);
    for (const sql of [
      "update orgs set delete_after = now()",
      "update orgs set delete_after = 'infinity'",
      "update orgs set installer_forge_user_id = 1",
      "update orgs set login = 'renamed'",
      "update orgs set kind = 'user'",
    ]) {
      const error = await pgError(db.withOrg(orgId, (tx) => tx.query(sql)));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // Scheduled by the worker; the server can neither clear it nor move it.
    await worker.withOrg(orgId, (tx) => tx.query("update orgs set delete_after = now()"));
    for (const sql of [
      "update orgs set delete_after = null",
      "update orgs set delete_after = 'infinity'",
      "update orgs set delete_after = delete_after + interval '1 year'",
    ]) {
      const error = await pgError(db.withOrg(orgId, (tx) => tx.query(sql)));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const { rows } = await superuser.query<{ due: boolean }>(
      "select delete_after < now() + interval '7 days 1 hour' as due from orgs where id = $1",
      [orgId],
    );
    expect(rows[0]?.due).toBe(true);
    // What the server may still change: settings and the encrypted key columns.
    await db.withOrg(orgId, (tx) =>
      tx.query(`update orgs set settings = '{"a":1}', updated_at = now()`),
    );
  });

  it("refuses infinity, or a date beyond the grace window, for every role", async () => {
    const orgId = await bareOrg(81);
    for (const value of ["infinity", "-infinity"]) {
      const error = await pgError(
        worker.withOrg(orgId, (tx) => tx.query("update orgs set delete_after = $1", [value])),
      );
      expect(error.code, value).toBe(CHECK_VIOLATION);
    }
    const far = await pgError(
      worker.withOrg(orgId, (tx) =>
        tx.query("update orgs set delete_after = now() + interval '30 days'"),
      ),
    );
    expect(far.code).toBe(CHECK_VIOLATION);
    // Even the superuser (bypassing RLS, with the triggers on) cannot store infinity.
    const su = await pgError(
      superuser.query("update orgs set delete_after = 'infinity' where id = $1", [orgId]),
    );
    expect(su.code).toBe(CHECK_VIOLATION);
    const { rows } = await superuser.query("select delete_after from orgs where id = $1", [orgId]);
    expect(rows).toEqual([{ delete_after: null }]);
  });

  it("the server holds UPDATE on exactly the columns it writes", async () => {
    const columns = async (grantee: string) =>
      (
        await superuser.query<{ column_name: string }>(
          `select column_name from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'orgs' and grantee = $1
              and privilege_type = 'UPDATE' order by 1`,
          [grantee],
        )
      ).rows.map((r) => r.column_name);
    expect(await columns("rocky_app")).toEqual([
      "data_key_ciphertext",
      "data_key_version",
      "llm_api_key_ciphertext",
      "llm_api_key_version",
      "settings",
      "updated_at",
    ]);
    expect(await columns("rocky_worker")).toEqual([
      "delete_after",
      "erasing_at",
      "installation_id",
      "installer_forge_user_id",
      "kind",
      "login",
      "updated_at",
    ]);
  });
});

describe("rescheduling and erasing (review round 1, H1 and S6)", () => {
  const OBJECT_IN_USE = "55000";

  const deleteAfterOf = async (orgId: string) =>
    (
      await superuser.query<{ d: Date | null }>(
        "select delete_after as d from orgs where id = $1",
        [orgId],
      )
    ).rows[0]?.d ?? null;

  it("reschedules a deadline beyond the grace window instead of keeping it (H1)", async () => {
    const orgId = await bareOrg(90);
    // A date the window forbids today (written before 0007, or by hand with the triggers off).
    await superuser.query("alter table orgs disable trigger user");
    try {
      await superuser.query(
        "update orgs set delete_after = now() + interval '5 years' where id = $1",
        [orgId],
      );
    } finally {
      await superuser.query("alter table orgs enable trigger user");
    }
    expect(await worker.withOrg(orgId, (tx) => scheduleOrgDeletion(tx, 90))).toBe("scheduled");
    const due = await deleteAfterOf(orgId);
    expect(+due! - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect(+due! - Date.now()).toBeLessThan(7 * DAY + 3_600_000);
    // An in-window schedule is kept (a duplicate uninstall does not push it out).
    expect(await worker.withOrg(orgId, (tx) => scheduleOrgDeletion(tx, 90))).toBe(
      "already_scheduled",
    );
    expect(await deleteAfterOf(orgId)).toEqual(due);
    // Bound to another installation meanwhile: nothing happens.
    expect(await worker.withOrg(orgId, (tx) => scheduleOrgDeletion(tx, 91))).toBe("stale");
  });

  it("marks an org erasing only once it is due; erasing is final and frees its binding (S6)", async () => {
    const orgId = await bareOrg(92);
    await worker.withOrg(orgId, (tx) => scheduleOrgDeletion(tx, 92));
    expect(await worker.withOrg(orgId, (tx) => beginOrgErasure(tx))).toBe("not_due");
    // The trigger refuses it too, not only the helper's WHERE clause.
    const early = await pgError(
      worker.withOrg(orgId, (tx) => tx.query("update orgs set erasing_at = now()")),
    );
    expect(early.code).toBe(OBJECT_IN_USE);
    // The server may not start an erasure at all.
    const byServer = await pgError(
      db.withOrg(orgId, (tx) => tx.query("update orgs set erasing_at = now()")),
    );
    expect(byServer.code).toBe(INSUFFICIENT_PRIVILEGE);

    await makeDue(orgId);
    expect(await worker.withOrg(orgId, (tx) => beginOrgErasure(tx))).toBe("started");
    expect(await worker.withOrg(orgId, (tx) => beginOrgErasure(tx))).toBe("resumed");
    expect((await worker.orgsDueForDeletion(100)).find((r) => r.orgId === orgId)).toMatchObject({
      erasing: true,
    });

    // Past the point of no return: no cancel, no rebind, no new deadline, no un-erasing.
    expect(await worker.withOrg(orgId, (tx) => cancelOrgDeletion(tx))).toBe(false);
    expect(
      await worker.withOrg(orgId, (tx) =>
        bindInstallation(tx, {
          expectedInstallationId: 92,
          installationId: 92,
          login: "back",
          kind: "organization",
        }),
      ),
    ).toBe(false);
    for (const sql of [
      "update orgs set delete_after = null",
      "update orgs set erasing_at = null",
      "update orgs set installation_id = 93",
    ]) {
      const error = await pgError(worker.withOrg(orgId, (tx) => tx.query(sql)));
      expect(error.code, sql).toBe(OBJECT_IN_USE);
    }

    // The lookup no longer returns it, and a reinstall gets a fresh org with the same ids.
    expect(await worker.installationOrgs("github", 92, 500_092)).toEqual([]);
    const fresh = newOrgId();
    await worker.withOrg(fresh, (tx) =>
      insertInstallationOrg(tx, {
        forge: "github",
        installationId: 92,
        accountId: 500_092,
        login: "bare-92",
        kind: "organization",
        installerForgeUserId: null,
      }),
    );
    expect((await worker.installationOrgs("github", 92, 500_092)).map((o) => o.orgId)).toEqual([
      fresh,
    ]);
    // A second live org for the same installation is still refused.
    const twin = newOrgId();
    const dup = await pgError(
      worker.withOrg(twin, (tx) =>
        insertInstallationOrg(tx, {
          forge: "github",
          installationId: 92,
          accountId: 500_092,
          login: "bare-92",
          kind: "organization",
          installerForgeUserId: null,
        }),
      ),
    );
    expect(dup.code).toBe("23505");

    // Finishing the erasure removes the old org only.
    await worker.deleteOrg(orgId);
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, orgId)).toBe(0);
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, fresh)).toBe(1);
  });
});

describe("review round 2", () => {
  it("B: a malformed pending row of the installation cannot wedge the erasure (shape guard + delete)", async () => {
    const orgId = await bareOrg(95);
    // Rows like this cannot be stored any more (CHECK webhook_deliveries_installation_shape,
    // review round 2 A); plant them with the CHECK lifted, as if they predated it.
    const def = await superuser.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'app.webhook_deliveries'::regclass
          and conname = 'webhook_deliveries_installation_shape'`,
    );
    expect(def.rows).toHaveLength(1);
    const planted = [randomUUID(), randomUUID(), randomUUID()];
    await superuser.query(
      "alter table app.webhook_deliveries drop constraint webhook_deliveries_installation_shape",
    );
    try {
      for (const [i, event] of [
        { type: "installation.created", installationId: 95, account: [1], sender: null },
        { type: "installation.created", installationId: 95, account: "x", sender: [] },
        {
          type: "installation.deleted",
          installationId: 95,
          account: { id: 1, login: "a", kind: "user" },
          sender: "x",
        },
      ].entries()) {
        await superuser.query(
          `insert into app.webhook_deliveries
             (forge, delivery_id, payload_sha256, event_type, installation_id, event)
           values ('github', $1, $2, $3, 95, $4::jsonb)`,
          [planted[i], randomBytes(32), event.type, JSON.stringify(event)],
        );
      }
      await makeDue(orgId);
      const report = await worker.deleteOrg(orgId);
      expect(report).toEqual(
        expect.arrayContaining([
          { table: "orgs", deleted: 1 },
          { table: "webhook_deliveries", deleted: 3 },
        ]),
      );
      const left = await superuser.query(
        "select 1 from app.webhook_deliveries where delivery_id = any($1)",
        [planted],
      );
      expect(left.rowCount).toBe(0);
    } finally {
      await superuser.query("delete from app.webhook_deliveries where delivery_id = any($1)", [
        planted,
      ]);
      await superuser.query(
        `alter table app.webhook_deliveries add constraint webhook_deliveries_installation_shape ${def.rows[0]!.def}`,
      );
    }
    expect(await rowsOf({ name: "orgs", tenantColumn: "id" }, orgId)).toBe(0);
  });

  it("N-a: the trigger alone refuses the schedule and installer to a role that holds the column grant", async () => {
    const orgId = await bareOrg(96);
    const role = "rocky_probe_test";
    const password = randomBytes(12).toString("hex");
    // A member of rocky_app (the tenant policies apply) that is not in rocky_worker.
    await superuser.query(
      `create role ${role} login inherit password '${password}' in role rocky_app`,
    );
    await superuser.query(
      `grant update (delete_after, installer_forge_user_id, erasing_at, installation_id, login, kind) on orgs to ${role}`,
    );
    const url = new URL(pgs.appUrl);
    url.username = role;
    url.password = password;
    const probe = createDb({ connectionString: url.href, max: 1 });
    try {
      for (const sql of [
        "update orgs set delete_after = now()",
        "update orgs set installer_forge_user_id = 1",
        "update orgs set login = 'renamed'",
        "update orgs set kind = 'user'",
        "update orgs set installation_id = 97",
      ]) {
        const error = await pgError(probe.withOrg(orgId, (tx) => tx.query(sql)));
        expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
        expect(error.message, sql).not.toMatch(/permission denied for (table|column)/);
      }
    } finally {
      await probe.close();
      await superuser.query(
        `revoke update (delete_after, installer_forge_user_id, erasing_at, installation_id, login, kind) on orgs from ${role}`,
      );
      await superuser.query(`drop role ${role}`);
    }
    const { rows } = await superuser.query(
      "select delete_after, installer_forge_user_id, login from orgs where id = $1",
      [orgId],
    );
    expect(rows).toEqual([{ delete_after: null, installer_forge_user_id: null, login: "bare-96" }]);
  });
});
