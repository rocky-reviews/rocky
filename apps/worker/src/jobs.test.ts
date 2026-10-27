import { ForgeReadError, nothingStoredYet, type OrgId } from "@rocky-reviews/core";
import type { Db } from "@rocky-reviews/db";
import { createLogger } from "@rocky-reviews/log";
import { describe, expect, it } from "vitest";
import { createAppCheck } from "./app-check.js";
import { failureKindOf, leaseSecondsFor, retryDelaySeconds, ROW_BUDGET_SECONDS } from "./inbox.js";
import { ContradictionError, ParkDeliveryError, StaleOrgError } from "./installations.js";
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

const forge = {
  kind: "github" as const,
  getInstallation: () => Promise.resolve(null),
  verifyApp: () => Promise.resolve(),
};

describe("startJobs", () => {
  it("never touches installation events or erases orgs without app credentials (fail closed), but still purges", async () => {
    const { db, calls } = stubDb();
    const { log, lines } = capture();
    const jobs = startJobs({ ...base, db, log, forge: undefined });
    await expect.poll(() => calls.filter((c) => c === "purge_inbox").length).toBeGreaterThan(2);
    await jobs.stop();
    expect(calls).not.toContain("claim");
    // The sweep re-verifies every uninstall with GitHub first (review round 1, S1c).
    expect(calls).not.toContain("due");
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
    const jobs = startJobs({ ...base, db, log, forge });
    await expect.poll(() => failures).toBeGreaterThan(2);
    await jobs.stop();
    const failed = lines.filter((l) => l["msg"] === "job failed");
    expect(failed[0]).toMatchObject({ job: "org_deletion_sweep", errorCode: "internal_error" });
    expect(JSON.stringify(lines)).not.toContain("10.0.0.5");
  });
});

describe("the inbox re-loop rule (review round 3)", () => {
  const fullBatch = () =>
    Array.from({ length: 10 }, (_, i) => ({
      forge: "github" as const,
      deliveryId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      eventType: "installation.created" as const,
      installationId: i + 1,
      event: null,
      attempts: 1,
      strikes: 0,
      leaseToken: "00000000-0000-4000-8000-000000000000",
      leaseUntil: new Date(Date.now() + 3_600_000),
    }));

  const run = async (failResult: "retry" | "parked") => {
    let claims = 0;
    const { db } = stubDb({
      claimWebhookDeliveries: () => {
        claims++;
        return Promise.resolve(fullBatch());
      },
      // Every row is undecodable (event null) and fails; the stub decides what the database said.
      failWebhookDelivery: () => Promise.resolve(failResult),
    } as Partial<Db>);
    const { log } = capture();
    const jobs = startJobs({
      ...base,
      intervals: { inboxMs: 400, sweepMs: 60_000, retentionMs: 60_000 },
      db,
      log,
      forge,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await jobs.stop();
    return claims;
  };

  it("loops at once only after a full batch that all went through", async () => {
    // All parked (progress): the next batch is claimed right away.
    expect(await run("parked")).toBeGreaterThan(3);
  });

  it("a full batch with released or retried rows waits for the next tick (no hot loop)", async () => {
    expect(await run("retry")).toBe(1);
  });
});

describe("the app check gate (review round 1, M2)", () => {
  it("claims nothing and erases nothing until GET /app proves the configured app, then starts", async () => {
    const { db, calls } = stubDb();
    const { log, lines } = capture();
    let mismatch = true;
    let checks = 0;
    const gated = {
      ...forge,
      verifyApp: () => {
        checks++;
        return mismatch ? Promise.reject(new ForgeReadError("app_mismatch")) : Promise.resolve();
      },
    };
    const jobs = startJobs({ ...base, db, log, forge: gated });
    await expect.poll(() => checks).toBeGreaterThan(3);
    expect(calls).not.toContain("claim");
    expect(calls).not.toContain("due");
    const failed = lines.filter((l) => String(l["msg"]).startsWith("forge app check failed"));
    expect(failed[0]).toMatchObject({ level: 50, errorCode: "forge_app_mismatch" });
    // Logged once while the same failure persists, not on every poll.
    expect(failed).toHaveLength(1);
    mismatch = false;
    await expect.poll(() => calls.includes("claim") && calls.includes("due")).toBe(true);
    await jobs.stop();
  });

  it("trusts a pass for the recheck period, then asks again", async () => {
    let now = 0;
    let checks = 0;
    const { log } = capture();
    const check = createAppCheck({
      forge: { ...forge, verifyApp: () => (checks++, Promise.resolve()) },
      clock: { now: () => new Date(now) },
      log,
      recheckMs: 1000,
    });
    expect(await check.ready()).toBe(true);
    now = 999;
    expect(await check.ready()).toBe(true);
    expect(checks).toBe(1);
    now = 1000;
    expect(await check.ready()).toBe(true);
    expect(checks).toBe(2);
  });
});

describe("failure classification (review round 1, S3)", () => {
  it("does not count outages against a row; does count bad answers; parks the impossible", () => {
    for (const error of [
      new ForgeReadError("timeout"),
      new ForgeReadError("network"),
      new ForgeReadError("http_status", 503),
      new ForgeReadError("http_status", 429),
      new ForgeReadError("http_status", 401),
      new ForgeReadError("http_status", 403),
      new ForgeReadError("app_mismatch"),
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
      Object.assign(new Error("could not serialize"), { code: "40001" }),
      Object.assign(new Error("connection failure"), { code: "08006" }),
    ]) {
      expect(failureKindOf(error), String((error as { code?: string }).code)).toBe("transient");
    }
    for (const error of [
      new ForgeReadError("invalid_response"),
      new ForgeReadError("http_status", 422),
      new ContradictionError(),
      new StaleOrgError(),
      Object.assign(new Error("duplicate key"), { code: "23505" }),
      new Error("no code"),
    ]) {
      expect(failureKindOf(error), error.name).toBe("strike");
    }
    expect(failureKindOf(new ParkDeliveryError("account_mismatch"))).toBe("permanent");
  });
});

describe("lease sizing (review round 1, S4)", () => {
  it("covers every row's worst case: two forge reads at the timeout, plus slack", () => {
    expect(ROW_BUDGET_SECONDS).toBeGreaterThanOrEqual(2 * 10 + 5);
    // Strictly more than the batch's worst case (review round 2, SF3): a batch of one leaves its
    // row a full budget.
    for (const batch of [1, 2, 10, 100]) {
      expect(leaseSecondsFor(batch)).toBeGreaterThan(batch * ROW_BUDGET_SECONDS);
      expect(leaseSecondsFor(batch) - ROW_BUDGET_SECONDS).toBeGreaterThanOrEqual(
        batch * ROW_BUDGET_SECONDS,
      );
    }
    expect(leaseSecondsFor(10, 60)).toBe(11 * ROW_BUDGET_SECONDS);
    expect(leaseSecondsFor(1, 900)).toBe(900);
    // Within what the claim accepts (it clamps to 3600 s).
    expect(leaseSecondsFor(100)).toBeLessThanOrEqual(3600);
  });
});

describe("retryDelaySeconds", () => {
  it("backs off exponentially from 30 s to at most an hour", () => {
    expect([1, 2, 3, 4, 5, 8, 20].map(retryDelaySeconds)).toEqual([
      30, 60, 120, 240, 480, 3600, 3600,
    ]);
  });
});
