import { randomUUID } from "node:crypto";
import type { Clock } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  AUDIT_MIN_RETENTION_DAYS,
  DEFAULT_RETENTION,
  expiryCutoff,
  retentionFromEnv,
  runRetention,
  setRetentionSettings,
  WEBHOOK_DELIVERIES_MIN_RETENTION_DAYS,
} from "./retention.js";
import * as schema from "./schema.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  plantAuditEvent,
  plantWebhookDelivery,
  seedOrg,
  startPostgres,
  type SeededOrg,
  ignoreIdleError,
} from "./testing/index.js";

/**
 * P2-6: time-travel test. The clock is injected as `as_of`; rows are planted just inside and just
 * outside each boundary. A row is expired iff `created_at < as_of - period` (strictly older): a
 * row created exactly `period` ago is kept. Periods live in app.retention_settings (migrator-
 * owned); the app can only move `as_of` into the past, never the cutoff towards now.
 */

const DAY = 86_400_000;
const fixedClock = (at: Date): Clock => ({ now: () => at });

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let superuser: pg.Pool;
let db: Db;
let orgA: SeededOrg;
let orgB: SeededOrg;
/** Real "now" minus a day, so the injected clock is always behind the database clock. */
const NOW = new Date(Date.now() - DAY);

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  [orgA, orgB] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 1, createdAt: NOW }),
    await seedOrg(w, newOrgId(), { installationId: 2, createdAt: NOW }),
  ]);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

const ageDays = (days: number): Date => new Date(NOW.getTime() - days * DAY);

const plant = async (org: SeededOrg, label: string, at: Date): Promise<void> => {
  await db.withOrg(org.orgId, async ({ db: tx }) => {
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
  });
  // Audit rows cannot be backdated by the app (stamp trigger); plant them as the superuser.
  await plantAuditEvent(superuser, org.orgId, { action: `planted.${label}`, at });
};

const remaining = async (org: SeededOrg) =>
  db.withOrg(org.orgId, async ({ db: tx }) => ({
    analyses: (await tx.select({ v: schema.analyses.errorCode }).from(schema.analyses))
      .map((r) => r.v)
      .filter((v): v is string => v !== null)
      .sort(),
    jobs: (await tx.select({ v: schema.jobs.idempotencyKey }).from(schema.jobs))
      .map((r) => r.v)
      .sort(),
    audit: (await tx.select({ v: schema.auditEvents.action }).from(schema.auditEvents))
      .map((r) => r.v)
      .sort(),
  }));

describe("expiryCutoff", () => {
  it("subtracts whole days from the injected clock", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    expect(expiryCutoff(now, 90).toISOString()).toBe("2026-07-27T12:00:00.000Z");
    expect(expiryCutoff(now, 1).toISOString()).toBe("2026-10-24T12:00:00.000Z");
  });
});

describe("retentionFromEnv", () => {
  it("uses the defaults when unset and parses overrides", () => {
    expect(retentionFromEnv({})).toEqual(DEFAULT_RETENTION);
    expect(DEFAULT_RETENTION).toEqual({
      analysesDays: 90,
      logsDays: 30,
      auditDays: 365,
      orgDeletionGraceDays: 7,
      webhookDeliveriesDays: 30,
    });
    expect(
      retentionFromEnv({
        RETENTION_ANALYSES_DAYS: "7",
        RETENTION_LOGS_DAYS: "14",
        RETENTION_AUDIT_DAYS: "730",
        ORG_DELETION_GRACE_DAYS: "30",
        RETENTION_WEBHOOK_DELIVERIES_DAYS: "60",
      }),
    ).toEqual({
      analysesDays: 7,
      logsDays: 14,
      auditDays: 730,
      orgDeletionGraceDays: 30,
      webhookDeliveriesDays: 60,
    });
  });

  it("rejects non-integers, non-positive values and an audit period under the floor", () => {
    expect(() => retentionFromEnv({ RETENTION_ANALYSES_DAYS: "abc" })).toThrow(
      /RETENTION_ANALYSES_DAYS/,
    );
    expect(() => retentionFromEnv({ RETENTION_LOGS_DAYS: "0" })).toThrow(/RETENTION_LOGS_DAYS/);
    expect(() => retentionFromEnv({ RETENTION_LOGS_DAYS: "1.5" })).toThrow(/RETENTION_LOGS_DAYS/);
    expect(() => retentionFromEnv({ ORG_DELETION_GRACE_DAYS: "0" })).toThrow(
      /ORG_DELETION_GRACE_DAYS/,
    );
    expect(() =>
      retentionFromEnv({ RETENTION_AUDIT_DAYS: String(AUDIT_MIN_RETENTION_DAYS - 1) }),
    ).toThrow(/RETENTION_AUDIT_DAYS/);
    expect(
      retentionFromEnv({ RETENTION_AUDIT_DAYS: String(AUDIT_MIN_RETENTION_DAYS) }).auditDays,
    ).toBe(AUDIT_MIN_RETENTION_DAYS);
    expect(() =>
      retentionFromEnv({
        RETENTION_WEBHOOK_DELIVERIES_DAYS: String(WEBHOOK_DELIVERIES_MIN_RETENTION_DAYS - 1),
      }),
    ).toThrow(/RETENTION_WEBHOOK_DELIVERIES_DAYS/);
  });
});

describe("retention settings", () => {
  it("are seeded with the defaults, readable by the app, and written only by the owner", async () => {
    expect(await db.retentionSettings()).toEqual(DEFAULT_RETENTION);
    await setRetentionSettings(pgs.migrator, { ...DEFAULT_RETENTION, logsDays: 45 });
    expect((await db.retentionSettings()).logsDays).toBe(45);
    await setRetentionSettings(pgs.migrator, DEFAULT_RETENTION);
    await expect(
      setRetentionSettings(pgs.migrator, {
        ...DEFAULT_RETENTION,
        auditDays: AUDIT_MIN_RETENTION_DAYS - 1,
      }),
    ).rejects.toThrow(/auditDays/);
    expect(await db.retentionSettings()).toEqual(DEFAULT_RETENTION);
  });
});

describe("runRetention", () => {
  it("deletes exactly the expired rows in every org, keeps the boundary row, and audits the purge in the same statement", async () => {
    for (const org of [orgA, orgB]) {
      // Every category is planted at every age, so each must pick its own boundary.
      await plant(org, "age-400d", ageDays(400));
      await plant(org, "age-365d-plus-1s", new Date(ageDays(365).getTime() - 1000));
      await plant(org, "age-365d", ageDays(365));
      await plant(org, "age-91d", ageDays(91));
      await plant(org, "age-90d", ageDays(90));
      await plant(org, "age-89d", ageDays(89));
      await plant(org, "age-31d", ageDays(31));
      await plant(org, "age-30d", ageDays(30));
      await plant(org, "age-29d", ageDays(29));
      await plant(org, "age-0d", NOW);
    }
    // The webhook inbox has no org: one row per age, 30-day period.
    for (const days of [400, 31, 30, 29, 0]) {
      await plantWebhookDelivery(superuser, { deliveryId: randomUUID(), at: ageDays(days) });
    }

    const report = await runRetention(db, { clock: fixedClock(NOW) });

    expect(report.ranAt).toEqual(NOW);
    expect(report.categories.map((c) => c.category)).toEqual([
      "analyses",
      "logs",
      "audit",
      "webhook_deliveries",
    ]);
    const byCategory = Object.fromEntries(report.categories.map((c) => [c.category, c]));
    expect(byCategory["analyses"]).toMatchObject({ before: ageDays(90), deleted: 8, orgs: 2 });
    expect(byCategory["logs"]).toMatchObject({ before: ageDays(30), deleted: 14, orgs: 2 });
    expect(byCategory["audit"]).toMatchObject({ before: ageDays(365), deleted: 4, orgs: 2 });
    expect(byCategory["webhook_deliveries"]).toMatchObject({
      before: ageDays(30),
      deleted: 2, // 400 and 31 days; the 30-day row is the kept boundary
      orgs: 0,
    });

    for (const org of [orgA, orgB]) {
      const left = await remaining(org);
      expect(left.analyses).toEqual([
        "age-0d",
        "age-29d",
        "age-30d",
        "age-31d",
        "age-89d",
        "age-90d",
      ]);
      expect(left.jobs).toEqual(
        [`analyse:${org.revisionId}`, "age-0d", "age-29d", "age-30d"].sort(),
      );
      expect(left.audit).toEqual(
        [
          "fixture.seeded",
          "planted.age-365d",
          "planted.age-91d",
          "planted.age-90d",
          "planted.age-89d",
          "planted.age-31d",
          "planted.age-30d",
          "planted.age-29d",
          "planted.age-0d",
          "retention.purged",
          "retention.purged",
          "retention.purged",
        ].sort(),
      );
      const events = await db.withOrg(org.orgId, ({ db: tx }) =>
        tx.select().from(schema.auditEvents),
      );
      const purges = events.filter((e) => e.action === "retention.purged");
      expect(purges.map((p) => p.targetId).sort()).toEqual(["analyses", "audit_events", "jobs"]);
      expect(purges.every((p) => p.actorType === "system" && p.targetType === "table")).toBe(true);
      const analysesPurge = purges.find((p) => p.targetId === "analyses")?.metadata;
      expect(analysesPurge).toMatchObject({ category: "analyses", deleted: 4 });
      expect(new Date(String(analysesPurge?.["before"])).getTime()).toBe(ageDays(90).getTime());
    }

    // Deleting analyses cascaded to findings_state but kept llm_usage (billing) with its link.
    const usage = await db.withOrg(orgA.orgId, ({ db: tx }) => tx.select().from(schema.llmUsage));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.analysisId).toBe(orgA.analysisId);
  });

  it("is idempotent: a second run at the same instant deletes nothing and audits nothing", async () => {
    const report = await runRetention(db, { clock: fixedClock(NOW) });
    expect(report.categories.map((c) => c.deleted)).toEqual([0, 0, 0, 0]);
    const events = await db.withOrg(orgA.orgId, ({ db: tx }) =>
      tx.select().from(schema.auditEvents),
    );
    expect(events.filter((e) => e.action === "retention.purged")).toHaveLength(3);
  });

  it("moves with the clock: one more day expires the next row", async () => {
    const report = await runRetention(db, { clock: fixedClock(new Date(NOW.getTime() + DAY)) });
    const byCategory = Object.fromEntries(report.categories.map((c) => [c.category, c]));
    expect(byCategory["analyses"]?.deleted).toBe(2); // age-90d in both orgs
    expect(byCategory["logs"]?.deleted).toBe(2); // age-30d in both orgs
    expect(byCategory["audit"]?.deleted).toBe(2); // planted.age-365d in both orgs
    expect(byCategory["webhook_deliveries"]?.deleted).toBe(1); // the 30-day row
  });

  it("cannot be pushed forward: a clock in the future is clamped to the database clock", async () => {
    for (const org of [orgA, orgB]) {
      await plant(org, "clamp-fresh", NOW);
      await plant(org, "clamp-old", ageDays(400));
    }
    const fresh = randomUUID();
    await plantWebhookDelivery(superuser, { deliveryId: fresh, at: NOW });
    for (const days of [400, 401]) {
      await plantWebhookDelivery(superuser, { deliveryId: randomUUID(), at: ageDays(days) });
    }
    const report = await runRetention(db, {
      clock: fixedClock(new Date(Date.now() + 365 * DAY)),
    });
    for (const c of report.categories) expect(c.deleted, c.category).toBeGreaterThanOrEqual(2);
    for (const org of [orgA, orgB]) {
      const left = await remaining(org);
      expect(left.analyses).toContain("clamp-fresh");
      expect(left.analyses).not.toContain("clamp-old");
      expect(left.jobs).toContain("clamp-fresh");
      expect(left.jobs).not.toContain("clamp-old");
      expect(left.audit).toContain("planted.clamp-fresh");
      expect(left.audit).not.toContain("planted.clamp-old");
    }
    const { rows } = await superuser.query(
      "select 1 from app.webhook_deliveries where delivery_id = $1",
      [fresh],
    );
    expect(rows).toHaveLength(1);
  });
});
