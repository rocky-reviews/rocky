import { readFileSync } from "node:fs";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnalysisStoreError,
  completeAnalysis,
  enqueueAnalysis,
  failAnalysis,
  loadAnalysisTarget,
  loadPreviousAnalysis,
  requeueAnalysis,
  type AnalysisLease,
} from "./analyses.js";
import { createDb, type Db } from "./client.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  plantAnalysisLease,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P4-3 (migration 0010, ADR 0014 §7): analysis rows as the application role, under RLS. Only a
 * document that validates is stored as `done`; a failure stores a code and nothing else; another
 * org's rows can be neither claimed, finished nor reused. Since P4-6 (migration 0012) every
 * finishing write needs the row's lease; leases here are planted as the claim would hand them
 * out, and the claim itself is tested in analysis-queue.test.ts.
 */

let pgs: TestPostgres;
let db: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;

const DOCUMENT = JSON.parse(
  readFileSync(new URL("../../schema/fixtures/pr-847.json", import.meta.url), "utf8"),
) as AnalysisDocument;
const UNITS = DOCUMENT.triage.files.map((file, i) => ({
  path: file.path,
  key: i.toString(16).padStart(64, "0"),
  reviewMinutes: file.reviewMinutes,
}));
const UNKNOWN = "5d1e9f00-dddd-4bcd-9e00-000000000010";

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 71 }));
  B = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 72 }));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

/** A new revision of the org's seeded pull request, and a running analysis of it (its lease). */
const running = async (org: SeededOrg, head: string): Promise<AnalysisLease> => {
  const id = await db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into pr_revisions (pull_request_id, head_sha, base_sha) values ($1, $2, $3)
       on conflict (org_id, pull_request_id, head_sha) do update set base_sha = excluded.base_sha
       returning id`,
      [org.pullRequestId, head, "b".repeat(40)],
    );
    return enqueueAnalysis(tx, rows[0]!.id);
  });
  const lease = await plantAnalysisLease(superuser, id);
  expect(await db.withOrg(org.orgId, (tx) => loadAnalysisTarget(tx, lease))).toBeDefined();
  return lease;
};

const row = async (lease: AnalysisLease | string) =>
  (
    await superuser.query<{
      status: string;
      document: unknown;
      file_units: unknown;
      error_code: string | null;
    }>("select status, document, file_units, error_code from analyses where id = $1", [
      typeof lease === "string" ? lease : lease.analysisId,
    ])
  ).rows[0];

describe("analyses store", () => {
  it("the lease holder loads the target; another token, or none, gets nothing", async () => {
    const id = await db.withOrg(A.orgId, (tx) => enqueueAnalysis(tx, A.revisionId));
    // Queued, not leased yet: nothing to load.
    await db.withOrg(A.orgId, async (tx) => {
      expect(await loadAnalysisTarget(tx, { analysisId: id, leaseId: UNKNOWN })).toBeUndefined();
    });
    const lease = await plantAnalysisLease(superuser, id);
    await db.withOrg(A.orgId, async (tx) => {
      expect(await loadAnalysisTarget(tx, lease)).toEqual({
        analysisId: id,
        revisionId: A.revisionId,
        pullRequestId: A.pullRequestId,
        number: 847,
        title: "Invite flow",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        forgeRepoId: 2001,
        fullName: expect.stringMatching(/\/api$/) as unknown as string,
        diffTruncation: null,
        approvedTokens: null,
        // The seeded pull request's head is this revision, and it is open.
        superseded: false,
      });
      expect(await loadAnalysisTarget(tx, { ...lease, leaseId: UNKNOWN })).toBeUndefined();
    });
    // Enqueueing the same revision again returns the live row instead of a second one.
    expect(await db.withOrg(A.orgId, (tx) => enqueueAnalysis(tx, A.revisionId))).toBe(id);
    expect(await db.withOrg(A.orgId, (tx) => failAnalysis(tx, lease, "internal_error"))).toBe(true);
  });

  it("stores a valid document with its units, and offers it to the next revision", async () => {
    const first = await running(A, "c".repeat(40));
    expect(await db.withOrg(A.orgId, (tx) => completeAnalysis(tx, first, DOCUMENT, UNITS))).toBe(
      true,
    );
    expect(await row(first)).toMatchObject({ status: "done", file_units: UNITS, error_code: null });

    const second = await running(A, "d".repeat(40));
    const previous = await db.withOrg(A.orgId, (tx) =>
      loadPreviousAnalysis(tx, A.pullRequestId, second.analysisId),
    );
    expect(previous?.units).toEqual(UNITS);
    expect(previous?.document.provenance.pullRequest.number).toBe(847);
    // Not offered to itself.
    expect(
      await db.withOrg(A.orgId, (tx) =>
        loadPreviousAnalysis(tx, A.pullRequestId, first.analysisId),
      ),
    ).toBeUndefined();
  });

  it("refuses an invalid document or units: nothing partial is stored", async () => {
    const id = await running(A, "e".repeat(40));
    const broken = {
      ...DOCUMENT,
      findings: [{ ...DOCUMENT.findings[0]!, range: { start: 999, end: 999 } }],
    };
    await expect(
      db.withOrg(A.orgId, (tx) => completeAnalysis(tx, id, broken, UNITS)),
    ).rejects.toThrow(AnalysisStoreError);
    await expect(
      db.withOrg(A.orgId, (tx) =>
        completeAnalysis(tx, id, DOCUMENT, [
          { path: "pnpm-lock.yaml", key: "0".repeat(64), reviewMinutes: 0 },
        ]),
      ),
    ).rejects.toThrow(/invalid file units/);
    await expect(
      db.withOrg(A.orgId, (tx) =>
        completeAnalysis(tx, id, DOCUMENT, [{ path: "x.ts", key: "nothex", reviewMinutes: 0 }]),
      ),
    ).rejects.toThrow(/invalid file units/);
    expect(await row(id)).toMatchObject({ status: "running", document: null, file_units: null });
  });

  it("refuses a document whose verdict sits below an unanalysed auth or migration file (review round 1, Fix A)", async () => {
    const id = await running(A, "6".repeat(40));
    const auth = DOCUMENT.triage.files.find((f) => f.path === "src/auth/invitations.ts")!;
    const lowered = {
      ...DOCUMENT,
      provenance: {
        ...DOCUMENT.provenance,
        unanalysed: [{ path: auth.path, reason: "analysis-failed" }],
      },
      triage: {
        ...DOCUMENT.triage,
        files: DOCUMENT.triage.files.filter((f) => f.path !== auth.path),
      },
      findings: DOCUMENT.findings.filter((f) => f.path !== auth.path && f.severity !== "high"),
      briefing: {
        ...DOCUMENT.briefing,
        verdict: { level: "low", reason: "Looks fine." },
        reviewPath: DOCUMENT.briefing.reviewPath.filter((s) => s.path !== auth.path),
        memoryApplied: [],
      },
    };
    lowered.findings = lowered.findings.map((f) => ({ ...f, memory: [] }));
    const units = UNITS.filter((u) => u.path !== auth.path);
    await expect(
      db.withOrg(A.orgId, (tx) => completeAnalysis(tx, id, lowered, units)),
    ).rejects.toThrow(/invalid document verdict/);
    const raised = {
      ...lowered,
      briefing: { ...lowered.briefing, verdict: { level: "high", reason: "x" } },
    };
    expect(await db.withOrg(A.orgId, (tx) => completeAnalysis(tx, id, raised, units))).toBe(true);
  });

  it("refuses a verdict below high next to a file triaged critical (P4-4 review round 1, item 2)", async () => {
    const id = await running(A, "5".repeat(40));
    const doc = {
      ...DOCUMENT,
      findings: DOCUMENT.findings
        .filter((f) => f.severity === "medium" || f.severity === "low")
        .map((f) => ({ ...f, memory: [] })),
      briefing: {
        ...DOCUMENT.briefing,
        verdict: { level: "medium", reason: "x" },
        memoryApplied: [],
      },
    };
    await expect(db.withOrg(A.orgId, (tx) => completeAnalysis(tx, id, doc, UNITS))).rejects.toThrow(
      /invalid document verdict/,
    );
    const high = { ...doc, briefing: { ...doc.briefing, verdict: { level: "high", reason: "x" } } };
    expect(await db.withOrg(A.orgId, (tx) => completeAnalysis(tx, id, high, UNITS))).toBe(true);
  });

  it("refuses a verdict below medium next to any unanalysed file (review round 2, SF2)", async () => {
    const id = await running(A, "9".repeat(40));
    const page = "web/src/pages/InvitePage.tsx";
    const doc = {
      ...DOCUMENT,
      provenance: { ...DOCUMENT.provenance, unanalysed: [{ path: page, reason: "too-large" }] },
      // No file triaged critical, so only the unanalysed floor applies (the triage floor is P4-4's).
      triage: {
        ...DOCUMENT.triage,
        files: DOCUMENT.triage.files
          .filter((f) => f.path !== page)
          .map((f) =>
            f.level === "critical" ? { ...f, level: "important" as const, score: 70 } : f,
          ),
      },
      findings: DOCUMENT.findings
        .filter((f) => f.path !== page && (f.severity === "medium" || f.severity === "low"))
        .map((f) => ({ ...f, memory: [] })),
      briefing: { ...DOCUMENT.briefing, verdict: { level: "low", reason: "x" }, memoryApplied: [] },
    };
    const units = UNITS.filter((u) => u.path !== page);
    await expect(db.withOrg(A.orgId, (tx) => completeAnalysis(tx, id, doc, units))).rejects.toThrow(
      /invalid document verdict/,
    );
    const medium = {
      ...doc,
      briefing: { ...doc.briefing, verdict: { level: "medium", reason: "x" } },
    };
    expect(await db.withOrg(A.orgId, (tx) => completeAnalysis(tx, id, medium, units))).toBe(true);
  });

  it("a failure stores a fixed code and no document; codes are shape-checked", async () => {
    const id = await running(A, "f".repeat(40));
    await expect(
      db.withOrg(A.orgId, (tx) => failAnalysis(tx, id, "Contains PR text!")),
    ).rejects.toThrow(/invalid error code/);
    expect(await db.withOrg(A.orgId, (tx) => failAnalysis(tx, id, "briefing_failed"))).toBe(true);
    expect(await row(id)).toMatchObject({
      status: "failed",
      document: null,
      error_code: "briefing_failed",
    });
    // Finished rows are final.
    expect(await db.withOrg(A.orgId, (tx) => completeAnalysis(tx, id, DOCUMENT, UNITS))).toBe(
      false,
    );
    expect(await db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, id, "llm_rate_limited", 0))).toBe(
      false,
    );
  });

  it("a retryable failure puts the row back in the queue, after its delay, without the lease", async () => {
    const id = await running(A, "1".repeat(40));
    await expect(
      db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, id, "llm_rate_limited", -1)),
    ).rejects.toThrow(/invalid retry delay/);
    await expect(
      db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, id, "Has PR text", 0)),
    ).rejects.toThrow(/invalid error code/);
    expect(
      await db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, id, "llm_rate_limited", 90_000)),
    ).toBe(true);
    const { rows } = await superuser.query<{
      status: string;
      error_code: string;
      lease_id: string | null;
      delay: number;
    }>(
      `select status, error_code, lease_id,
              extract(epoch from available_at - now())::int as delay
         from analyses where id = $1`,
      [id.analysisId],
    );
    expect(rows[0]).toMatchObject({
      status: "queued",
      error_code: "llm_rate_limited",
      lease_id: null,
    });
    expect(rows[0]!.delay).toBeGreaterThan(80);
    expect(rows[0]!.delay).toBeLessThanOrEqual(90);
    // The old lease is spent.
    expect(await db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, id, "llm_rate_limited", 0))).toBe(
      false,
    );
  });

  it("units without a finished document are refused by the database (CHECK)", async () => {
    const id = await running(A, "2".repeat(40));
    await expect(
      db.withOrg(A.orgId, (tx) =>
        tx.query("update analyses set file_units = '[]'::jsonb where id = $1", [id.analysisId]),
      ),
    ).rejects.toThrow(/analyses_file_units_when_done/);
  });

  it("a stored document that no longer validates is not offered for reuse", async () => {
    const first = await running(B, "3".repeat(40));
    await db.withOrg(B.orgId, (tx) => completeAnalysis(tx, first, DOCUMENT, UNITS));
    await superuser.query(
      "update analyses set document = jsonb_set(document, '{findings,0,range,start}', '999') where id = $1",
      [first.analysisId],
    );
    const second = await running(B, "4".repeat(40));
    expect(
      await db.withOrg(B.orgId, (tx) =>
        loadPreviousAnalysis(tx, B.pullRequestId, second.analysisId),
      ),
    ).toBeUndefined();
  });

  it("old-shape units (no reviewMinutes) are not offered for reuse (review round 2)", async () => {
    const first = await running(B, "7".repeat(40));
    await db.withOrg(B.orgId, (tx) => completeAnalysis(tx, first, DOCUMENT, UNITS));
    await superuser.query(
      `update analyses set file_units = (select jsonb_agg(u - 'reviewMinutes') from jsonb_array_elements(file_units) u)
        where id = $1`,
      [first.analysisId],
    );
    const second = await running(B, "8".repeat(40));
    expect(
      await db.withOrg(B.orgId, (tx) =>
        loadPreviousAnalysis(tx, B.pullRequestId, second.analysisId),
      ),
    ).toBeUndefined();
  });

  describe("tenancy", () => {
    it("another org cannot load, finish, requeue or reuse a row, even with its lease", async () => {
      const lease = await running(A, "5".repeat(40));
      await db.withOrg(B.orgId, async (tx) => {
        expect(await loadAnalysisTarget(tx, lease)).toBeUndefined();
        expect(await completeAnalysis(tx, lease, DOCUMENT, UNITS)).toBe(false);
        expect(await failAnalysis(tx, lease, "internal_error")).toBe(false);
        expect(await requeueAnalysis(tx, lease, "internal_error", 0)).toBe(false);
        expect(await loadPreviousAnalysis(tx, A.pullRequestId, UNKNOWN)).toBeUndefined();
      });
      expect((await row(lease))?.status).toBe("running");
      expect(
        await db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, lease, "internal_error", 0)),
      ).toBe(true);
    });

    it("an org cannot queue an analysis of another org's revision (composite FK)", async () => {
      await expect(db.withOrg(B.orgId, (tx) => enqueueAnalysis(tx, A.revisionId))).rejects.toThrow(
        /analyses_revision_fk/,
      );
    });

    it("ids are shape-checked before any query", async () => {
      await db.withOrg(A.orgId, async (tx) => {
        await expect(
          loadAnalysisTarget(tx, { analysisId: "1; drop table analyses", leaseId: UNKNOWN }),
        ).rejects.toThrow(/invalid analysis id/);
        await expect(loadAnalysisTarget(tx, { analysisId: UNKNOWN, leaseId: "x" })).rejects.toThrow(
          /invalid lease/,
        );
        await expect(enqueueAnalysis(tx, "x")).rejects.toThrow(/invalid revision id/);
        await expect(loadPreviousAnalysis(tx, "x", UNKNOWN)).rejects.toThrow(
          /invalid pull request id/,
        );
      });
    });
  });
});
