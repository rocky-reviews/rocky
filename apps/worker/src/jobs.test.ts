import { nothingStoredYet, type OrgId } from "@rocky-reviews/core";
import type { Db } from "@rocky-reviews/db";
import { createLogger } from "@rocky-reviews/log";
import { describe, expect, it } from "vitest";
import { retryDelaySeconds } from "./inbox.js";
import { startJobs } from "./jobs.js";

/** P3-3: the worker's timers. The jobs themselves run against Postgres in lifecycle.e2e.test.ts. */

const settings = {
  analysesDays: 90,
  logsDays: 30,
  auditDays: 365,
  orgDeletionGraceDays: 7,
  webhookDeliveriesDays: 30,
};

const stubDb = (overrides: Partial<Db> = {}) => {
  const calls: string[] = [];
  const db = {
    claimWebhookDeliveries: () => {
      calls.push("claim");
      return Promise.resolve([]);
    },
    orgsDueForDeletion: () => {
      calls.push("due");
      return Promise.resolve([]);
    },
    retentionSettings: () => Promise.resolve(settings),
    purgeExpired: () => {
      calls.push("purge");
      return Promise.resolve([]);
    },
    purgeWebhookDeliveries: () => {
      calls.push("purge_inbox");
      return Promise.resolve(0);
    },
    ...overrides,
  } as unknown as Db;
  return { db, calls };
};

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger("jobs-test", {
    destination: {
      write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>),
    },
  });
  return { log, lines };
};

const base = {
  clock: { now: () => new Date() },
  erasers: {
    object_storage: nothingStoredYet("object_storage"),
    embeddings: nothingStoredYet("embeddings"),
  },
  newOrgId: () => "00000000-0000-4000-8000-000000000000" as OrgId,
  intervals: { inboxMs: 5, sweepMs: 5, retentionMs: 5 },
};

const forge = { kind: "github" as const, getInstallation: () => Promise.resolve(null) };

describe("startJobs", () => {
  it("never touches installation events without app credentials (fail closed), but still sweeps and purges", async () => {
    const { db, calls } = stubDb();
    const { log, lines } = capture();
    const jobs = startJobs({ ...base, db, log, forge: undefined });
    await expect.poll(() => calls.includes("due") && calls.includes("purge_inbox")).toBe(true);
    await jobs.stop();
    expect(calls).not.toContain("claim");
    expect(
      lines.some((l) => String(l["msg"]).includes("installation events stay in the inbox")),
    ).toBe(true);
  });

  it("polls the inbox with credentials; stop() is idempotent and ends all scheduling", async () => {
    const { db, calls } = stubDb();
    const { log } = capture();
    const jobs = startJobs({ ...base, db, log, forge });
    await expect.poll(() => calls.filter((c) => c === "claim").length).toBeGreaterThan(2);
    await Promise.all([jobs.stop(), jobs.stop()]);
    const after = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.length).toBe(after);
  });

  it("logs a failing run by code only and keeps going", async () => {
    let failures = 0;
    const { db } = stubDb({
      orgsDueForDeletion: () => {
        failures++;
        return Promise.reject(
          Object.assign(new Error("connection to 10.0.0.5 failed for user secret"), {
            code: "ECONNREFUSED",
          }),
        );
      },
    });
    const { log, lines } = capture();
    const jobs = startJobs({ ...base, db, log, forge: undefined });
    await expect.poll(() => failures).toBeGreaterThan(2);
    await jobs.stop();
    const failed = lines.filter((l) => l["msg"] === "job failed");
    expect(failed[0]).toMatchObject({ job: "org_deletion_sweep", errorCode: "internal_error" });
    expect(JSON.stringify(lines)).not.toContain("10.0.0.5");
  });
});

describe("retryDelaySeconds", () => {
  it("backs off exponentially from 30 s to at most an hour", () => {
    expect([1, 2, 3, 4, 5, 8, 20].map(retryDelaySeconds)).toEqual([
      30, 60, 120, 240, 480, 3600, 3600,
    ]);
  });
});
