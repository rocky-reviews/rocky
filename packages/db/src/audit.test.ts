import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, AUDIT_METADATA_MAX_BYTES } from "./audit.js";
import { createDb, type Db } from "./client.js";
import { AUDIT_MIN_RETENTION_DAYS, DEFAULT_RETENTION, setRetentionSettings } from "./retention.js";
import * as schema from "./schema.js";
import {
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
} from "./testing/index.js";

/** P2-5: audit_events is append-only; only the retention function may delete, and only old rows. */

const INSUFFICIENT_PRIVILEGE = "42501";

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let db: Db;
let org: SeededOrg;

const pgError = async (promise: Promise<unknown>): Promise<pg.DatabaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error("expected the query to fail");
};

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  org = await seedOrg(db, newOrgId());
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await pgs?.stop();
});

describe("audit()", () => {
  it("writes the expected row inside the tenant transaction", async () => {
    const { id } = await db.withOrg(org.orgId, (tx) =>
      audit(
        tx,
        { type: "user", id: org.memberId },
        "finding.accepted",
        { type: "finding", id: "f-1" },
        { analysisId: org.analysisId },
      ),
    );
    const rows = await db.withOrg(org.orgId, (tx) =>
      tx.db.select().from(schema.auditEvents).orderBy(schema.auditEvents.id),
    );
    const row = rows.find((r) => r.id === id);
    expect(row).toMatchObject({
      orgId: org.orgId,
      actorType: "user",
      actorId: org.memberId,
      action: "finding.accepted",
      targetType: "finding",
      targetId: "f-1",
      metadata: { analysisId: org.analysisId },
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("rejects malformed actions and oversized metadata before touching the database", async () => {
    const actor = { type: "system" as const, id: "worker" };
    const target = { type: "org", id: org.orgId };
    await expect(
      db.withOrg(org.orgId, (tx) => audit(tx, actor, "drop table; --", target)),
    ).rejects.toThrow(/action/);
    await expect(db.withOrg(org.orgId, (tx) => audit(tx, actor, "", target))).rejects.toThrow(
      /action/,
    );
    await expect(
      db.withOrg(org.orgId, (tx) =>
        audit(tx, actor, "x.y", target, { diff: "x".repeat(AUDIT_METADATA_MAX_BYTES) }),
      ),
    ).rejects.toThrow(/metadata/);
    await expect(
      db.withOrg(org.orgId, (tx) => audit(tx, actor, "x.y", { type: "", id: "1" })),
    ).rejects.toThrow(/target/);
  });
});

describe("append-only trigger", () => {
  it("blocks UPDATE and DELETE for the app role", async () => {
    for (const sql of [
      "update audit_events set action = 'tampered'",
      "update audit_events set metadata = '{}'::jsonb where id = $1",
      "delete from audit_events where id = $1",
      "delete from audit_events",
    ]) {
      const params = sql.includes("$1") ? [org.auditEventId] : [];
      const error = await pgError(db.withOrg(org.orgId, (tx) => tx.query(sql, params)));
      expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const rows = await db.withOrg(org.orgId, (tx) => tx.db.select().from(schema.auditEvents));
    expect(rows.some((r) => r.action === "fixture.seeded")).toBe(true);
  });

  it("blocks UPDATE, DELETE and TRUNCATE even for the table owner", async () => {
    const owner = await pgs.migrator.connect();
    try {
      await owner.query("begin");
      // FORCE RLS hides every row from the owner (no policy applies to it), so UPDATE/DELETE
      // would match nothing. Lift FORCE inside this transaction (rolled back below) to prove
      // that the trigger, not RLS, is what stops the owner.
      await owner.query("alter table audit_events no force row level security");
      expect((await owner.query("select 1 from audit_events")).rowCount).toBeGreaterThan(0);
      for (const sql of [
        "update audit_events set action = 'tampered'",
        "delete from audit_events",
        "truncate audit_events",
      ]) {
        await owner.query("savepoint s");
        const error = await pgError(owner.query(sql));
        expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
        expect(error.message, sql).toMatch(/append-only/);
        await owner.query("rollback to savepoint s");
      }
      await owner.query("rollback");
    } finally {
      owner.release();
    }
  });

  it("gives the app role no UPDATE/DELETE/TRUNCATE privilege on top of the trigger", async () => {
    const { rows } = await pgs.migrator.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where table_name = 'audit_events' and grantee = 'rocky_app' order by 1`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });
});

describe("retention purge path", () => {
  const DAY = 86_400_000;
  const plant = async (label: string, at: Date) =>
    db.withOrg(org.orgId, async ({ db: tx }) => {
      await tx.insert(schema.analyses).values({
        revisionId: org.revisionId,
        status: "failed",
        errorCode: label,
        createdAt: at,
      });
      await tx.insert(schema.jobs).values({
        kind: "analyse",
        idempotencyKey: label,
        status: "failed",
        createdAt: at,
        finishedAt: at,
      });
      await tx.insert(schema.auditEvents).values({
        actorType: "system",
        actorId: "test",
        action: `planted.${label}`,
        targetType: "org",
        targetId: org.orgId,
        createdAt: at,
      });
    });
  const remaining = () =>
    db.withOrg(org.orgId, async ({ db: tx }) => ({
      analyses: (await tx.select({ v: schema.analyses.errorCode }).from(schema.analyses))
        .map((r) => r.v)
        .filter((v): v is string => v !== null),
      jobs: (await tx.select({ v: schema.jobs.idempotencyKey }).from(schema.jobs)).map((r) => r.v),
      audit: (await tx.select({ v: schema.auditEvents.action }).from(schema.auditEvents)).map(
        (r) => r.v,
      ),
    }));

  it("cannot be steered to a recent cutoff: the period comes from the settings table and as_of is clamped to the database clock (review #3, #5)", async () => {
    await plant("ancient", new Date(Date.now() - 400 * DAY));
    await plant("recent", new Date(Date.now() - DAY));
    const future = new Date(Date.now() + 400 * DAY);
    for (const category of ["analyses", "logs", "audit"] as const) {
      const result = await db.purgeExpired(category, future);
      expect(result, category).toEqual([{ orgId: org.orgId, deleted: 1 }]);
    }
    const left = await remaining();
    expect(left.analyses).toContain("recent");
    expect(left.analyses).not.toContain("ancient");
    expect(left.jobs).toContain("recent");
    expect(left.jobs).not.toContain("ancient");
    expect(left.audit).toContain("planted.recent");
    expect(left.audit).not.toContain("planted.ancient");

    // Direct calls as the app role: an explicit future cutoff and the no-argument form.
    const app = new pg.Pool({ connectionString: pgs.appUrl, max: 1 });
    try {
      for (const sql of [
        "select * from retention.purge_analyses(now() + interval '1 day')",
        "select * from retention.purge_jobs(now() + interval '1 day')",
        "select * from retention.purge_audit_events(now() + interval '1 day')",
        "select * from retention.purge_analyses()",
        "select * from retention.purge_jobs()",
        "select * from retention.purge_audit_events()",
      ]) {
        expect((await app.query(sql)).rowCount, sql).toBe(0);
      }
      // The old shape (arbitrary cutoff deleting everything) must not exist in any form.
      const error = await pgError(app.query("select * from retention.purge_analyses(now(), true)"));
      expect(error.code).toBe("42883"); // undefined_function
    } finally {
      await app.end();
    }
    expect(await remaining()).toEqual(left);
  });

  it("the audit floor is the configured period itself: raising it protects older rows (review #5)", async () => {
    await plant("mid", new Date(Date.now() - 380 * DAY));
    await setRetentionSettings(pgs.migrator, { ...DEFAULT_RETENTION, auditDays: 400 });
    expect(await db.purgeExpired("audit", new Date())).toEqual([]);
    expect((await remaining()).audit).toContain("planted.mid");
    await setRetentionSettings(pgs.migrator, DEFAULT_RETENTION);
    expect(await db.purgeExpired("audit", new Date())).toEqual([{ orgId: org.orgId, deleted: 1 }]);
    expect((await remaining()).audit).not.toContain("planted.mid");
    // The table refuses an audit period under the floor even for the owner.
    const error = await pgError(
      pgs.migrator.query("update app.retention_settings set days = $1 where category = 'audit'", [
        AUDIT_MIN_RETENTION_DAYS - 1,
      ]),
    );
    expect(error.code).toBe("23514"); // check_violation
  });

  it("is owned by a NOLOGIN role that owns only the retention schema and its functions", async () => {
    const role = await pgs.migrator.query<{
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      "select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'rocky_retention'",
    );
    expect(role.rows[0]).toEqual({ rolcanlogin: false, rolbypassrls: false, rolsuper: false });
    const owned = await pgs.migrator.query<{ kind: string; name: string }>(
      `select 'table' as kind, relname as name from pg_class where relowner = 'rocky_retention'::regrole
       union all select 'schema', nspname from pg_namespace where nspowner = 'rocky_retention'::regrole
       union all select 'function', proname from pg_proc where proowner = 'rocky_retention'::regrole
       order by 1, 2`,
    );
    expect(owned.rows).toEqual([
      { kind: "function", name: "delete_org" },
      { kind: "function", name: "purge_analyses" },
      { kind: "function", name: "purge_audit_events" },
      { kind: "function", name: "purge_jobs" },
      { kind: "schema", name: "retention" },
    ]);
    const grants = await pgs.migrator.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'rocky_retention' order by 1, 2`,
    );
    expect(grants.rows).toEqual([
      { table_name: "analyses", privilege_type: "DELETE" },
      { table_name: "analyses", privilege_type: "SELECT" },
      { table_name: "audit_events", privilege_type: "DELETE" },
      { table_name: "audit_events", privilege_type: "INSERT" },
      { table_name: "audit_events", privilege_type: "SELECT" },
      { table_name: "jobs", privilege_type: "DELETE" },
      { table_name: "jobs", privilege_type: "SELECT" },
      { table_name: "orgs", privilege_type: "DELETE" },
      { table_name: "orgs", privilege_type: "SELECT" },
      { table_name: "retention_settings", privilege_type: "SELECT" },
    ]);
  });
});
