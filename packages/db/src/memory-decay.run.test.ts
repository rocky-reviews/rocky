import type { OrgId } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { MAX_LIVE_ORGS_PAGE, type Db, type TenantTx } from "./client.js";
import { runMemoryDecay } from "./memory-decay.js";
import { DEFAULT_RETENTION } from "./retention.js";

/**
 * P8-4: the run loop over orgs, without a database: paging through `liveOrgs`, one org's
 * failure recorded by code only while the others still run, and the windows checked before any
 * org is visited. The per-org rules run on Postgres in memory-decay.test.ts.
 */

const orgId = (n: number): OrgId =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as OrgId;

const fakeDb = (options: {
  readonly orgs: readonly OrgId[];
  readonly failing?: ReadonlySet<OrgId>;
  readonly settings?: Partial<typeof DEFAULT_RETENTION>;
}) => {
  const pages: { after: OrgId | null; limit: number }[] = [];
  const visited: OrgId[] = [];
  const db = {
    retentionSettings: () => Promise.resolve({ ...DEFAULT_RETENTION, ...options.settings }),
    liveOrgs: (after: OrgId | null, limit: number) => {
      pages.push({ after, limit });
      const start = after === null ? 0 : options.orgs.indexOf(after) + 1;
      return Promise.resolve(options.orgs.slice(start, start + limit));
    },
    withOrg: <T>(id: OrgId, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
      visited.push(id);
      if (options.failing?.has(id) === true) {
        return Promise.reject(
          Object.assign(new Error("deadlock detected while deleting 'Planted entry'"), {
            code: "40P01",
          }),
        );
      }
      const tx = {
        orgId: id,
        query: () => Promise.resolve({ rowCount: 0, rows: [] }),
      } as unknown as TenantTx;
      return fn(tx);
    },
  } as unknown as Db;
  return { db, pages, visited };
};

describe("runMemoryDecay (the loop)", () => {
  it("pages through the org list with the last id as the cursor and visits every org once", async () => {
    const orgs = Array.from({ length: MAX_LIVE_ORGS_PAGE + 2 }, (_, i) => orgId(i + 1));
    const { db, pages, visited } = fakeDb({ orgs });
    const report = await runMemoryDecay(db, { clock: { now: () => new Date(0) } });
    expect(pages).toEqual([
      { after: null, limit: MAX_LIVE_ORGS_PAGE },
      { after: orgs[MAX_LIVE_ORGS_PAGE - 1], limit: MAX_LIVE_ORGS_PAGE },
    ]);
    expect(visited).toEqual(orgs);
    expect(report).toMatchObject({ orgs: orgs.length, decayed: 0, retired: 0, purged: 0 });
    expect(report.failures).toEqual([]);
  });

  it("records one org's failure by code only and still visits the others", async () => {
    const orgs = [orgId(1), orgId(2), orgId(3)];
    const { db, visited } = fakeDb({ orgs, failing: new Set([orgId(2)]) });
    const report = await runMemoryDecay(db, { clock: { now: () => new Date(0) } });
    expect(visited).toEqual(orgs);
    expect(report.failures).toEqual([{ orgId: orgId(2), errorCode: "40P01" }]);
    expect(JSON.stringify(report)).not.toContain("Planted");
  });

  it("refuses settings below the floor before visiting any org", async () => {
    const { db, visited } = fakeDb({ orgs: [orgId(1)], settings: { memoryUnusedDays: 0 } });
    await expect(runMemoryDecay(db, { clock: { now: () => new Date(0) } })).rejects.toThrow(
      /memoryUnusedDays/,
    );
    expect(visited).toEqual([]);
  });
});
