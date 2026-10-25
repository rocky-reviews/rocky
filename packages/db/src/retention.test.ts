import type { Clock } from "@rocky-reviews/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  AUDIT_MIN_RETENTION_DAYS,
  DEFAULT_RETENTION,
  expiryCutoff,
  retentionFromEnv,
  runRetention,
} from "./retention.js";
import * as schema from "./schema.js";
import {
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
} from "./testing/index.js";

/**
 * P2-6: time-travel test. The clock is injected; rows are planted just inside and just outside
 * each boundary. A row is expired iff `created_at < now - period` (strictly older): a row created
 * exactly `period` ago is kept.
 */

const DAY = 86_400_000;
const fixedClock = (at: Date): Clock => ({ now: () => at });

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let db: Db;
let orgA: SeededOrg;
let orgB: SeededOrg;
/** Real "now" minus a day, so the audit floor (which uses the database clock) is never crossed. */
const NOW = new Date(Date.now() - DAY);

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  orgA = await seedOrg(db, newOrgId(), { installationId: 1, createdAt: NOW });
  orgB = await seedOrg(db, newOrgId(), { installationId: 2, createdAt: NOW });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
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
    await tx.insert(schema.auditEvents).values({
      actorType: "system",
      actorId: "test",
      action: `planted.${label}`,
      targetType: "org",
      targetId: org.orgId,
      createdAt: at,
    });
  });
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
    expect(DEFAULT_RETENTION).toEqual({ analysesDays: 90, logsDays: 30, auditDays: 365 });
    expect(
      retentionFromEnv({
        RETENTION_ANALYSES_DAYS: "7",
        RETENTION_LOGS_DAYS: "14",
        RETENTION_AUDIT_DAYS: "730",
      }),
    ).toEqual({ analysesDays: 7, logsDays: 14, auditDays: 730 });
  });

  it("rejects non-integers, non-positive values and an audit period under the floor", () => {
    expect(() => retentionFromEnv({ RETENTION_ANALYSES_DAYS: "abc" })).toThrow(
      /RETENTION_ANALYSES_DAYS/,
    );
    expect(() => retentionFromEnv({ RETENTION_LOGS_DAYS: "0" })).toThrow(/RETENTION_LOGS_DAYS/);
    expect(() => retentionFromEnv({ RETENTION_LOGS_DAYS: "1.5" })).toThrow(/RETENTION_LOGS_DAYS/);
    expect(() =>
      retentionFromEnv({ RETENTION_AUDIT_DAYS: String(AUDIT_MIN_RETENTION_DAYS - 1) }),
    ).toThrow(/RETENTION_AUDIT_DAYS/);
    expect(
      retentionFromEnv({ RETENTION_AUDIT_DAYS: String(AUDIT_MIN_RETENTION_DAYS) }).auditDays,
    ).toBe(AUDIT_MIN_RETENTION_DAYS);
  });
});

describe("runRetention", () => {
  it("deletes exactly the expired rows in every org, keeps the boundary row, and audits the purge", async () => {
    const config = { analysesDays: 90, logsDays: 30, auditDays: 365 };
    for (const org of [orgA, orgB]) {
      // analyses (90 d) and jobs (30 d) and audit (365 d) are all planted at every age, so each
      // category must pick its own boundary and ignore the others'.
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

    const report = await runRetention(db, { clock: fixedClock(NOW), config });

    expect(report.ranAt).toEqual(NOW);
    expect(report.categories.map((c) => c.category)).toEqual(["analyses", "logs", "audit"]);
    const byCategory = Object.fromEntries(report.categories.map((c) => [c.category, c]));
    expect(byCategory["analyses"]).toMatchObject({ before: ageDays(90), deleted: 8, orgs: 2 });
    expect(byCategory["logs"]).toMatchObject({ before: ageDays(30), deleted: 14, orgs: 2 });
    expect(byCategory["audit"]).toMatchObject({ before: ageDays(365), deleted: 4, orgs: 2 });

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
      expect(purges.find((p) => p.targetId === "analyses")?.metadata).toEqual({
        category: "analyses",
        deleted: 4,
        before: ageDays(90).toISOString(),
      });
    }

    // Deleting analyses cascaded to findings_state but kept llm_usage (billing) with a null link.
    const usage = await db.withOrg(orgA.orgId, ({ db: tx }) => tx.select().from(schema.llmUsage));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.analysisId).toBe(orgA.analysisId);
  });

  it("is idempotent: a second run at the same instant deletes nothing", async () => {
    const report = await runRetention(db, { clock: fixedClock(NOW) });
    expect(report.categories.map((c) => c.deleted)).toEqual([0, 0, 0]);
    const events = await db.withOrg(orgA.orgId, ({ db: tx }) =>
      tx.select().from(schema.auditEvents),
    );
    expect(events.filter((e) => e.action === "retention.purged")).toHaveLength(3);
  });

  it("moves with the clock: one more day expires the next row", async () => {
    const report = await runRetention(db, {
      clock: fixedClock(new Date(NOW.getTime() + DAY)),
      config: { analysesDays: 90, logsDays: 30, auditDays: 365 },
    });
    const byCategory = Object.fromEntries(report.categories.map((c) => [c.category, c]));
    expect(byCategory["analyses"]?.deleted).toBe(2); // age-90d in both orgs
    expect(byCategory["logs"]?.deleted).toBe(2); // age-30d in both orgs
    expect(byCategory["audit"]?.deleted).toBe(2); // planted.age-365d in both orgs
  });

  it("refuses an audit period under the floor even if passed directly", async () => {
    await expect(
      runRetention(db, {
        clock: fixedClock(NOW),
        config: { analysesDays: 90, logsDays: 30, auditDays: AUDIT_MIN_RETENTION_DAYS - 1 },
      }),
    ).rejects.toThrow(/auditDays/);
  });
});
