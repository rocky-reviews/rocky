import { readFileSync } from "node:fs";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnalysisStoreError,
  completeAnalysis,
  enqueueAnalysis,
  failAnalysis,
  loadPreviousAnalysis,
  requeueAnalysis,
  startAnalysis,
} from "./analyses.js";
import { createDb, type Db } from "./client.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P4-3 (migration 0010, ADR 0014 §7): analysis rows as the application role, under RLS. Only a
 * document that validates is stored as `done`; a failure stores a code and nothing else; another
 * org's rows can be neither claimed, finished nor reused.
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

/** A new revision of the org's seeded pull request, and a running analysis of it. */
const running = async (org: SeededOrg, head: string): Promise<string> =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into pr_revisions (pull_request_id, head_sha, base_sha) values ($1, $2, $3)
       on conflict (org_id, pull_request_id, head_sha) do update set base_sha = excluded.base_sha
       returning id`,
      [org.pullRequestId, head, "b".repeat(40)],
    );
    const id = await enqueueAnalysis(tx, rows[0]!.id);
    expect(await startAnalysis(tx, id)).toBeDefined();
    return id;
  });

const row = async (id: string) =>
  (
    await superuser.query<{
      status: string;
      document: unknown;
      file_units: unknown;
      error_code: string | null;
    }>("select status, document, file_units, error_code from analyses where id = $1", [id])
  ).rows[0];

describe("analyses store", () => {
  it("queued → running returns the target; a second claim gets nothing", async () => {
    await db.withOrg(A.orgId, async (tx) => {
      const id = await enqueueAnalysis(tx, A.revisionId);
      const target = await startAnalysis(tx, id);
      expect(target).toMatchObject({
        analysisId: id,
        revisionId: A.revisionId,
        pullRequestId: A.pullRequestId,
        number: 847,
        title: "Invite flow",
        headSha: "a".repeat(40),
        forgeRepoId: 2001,
        diffTruncation: null,
      });
      expect(await startAnalysis(tx, id)).toBeUndefined();
    });
  });

  it("stores a valid document with its units, and offers it to the next revision", async () => {
    const first = await running(A, "c".repeat(40));
    expect(await db.withOrg(A.orgId, (tx) => completeAnalysis(tx, first, DOCUMENT, UNITS))).toBe(
      true,
    );
    expect(await row(first)).toMatchObject({ status: "done", file_units: UNITS, error_code: null });

    const second = await running(A, "d".repeat(40));
    const previous = await db.withOrg(A.orgId, (tx) =>
      loadPreviousAnalysis(tx, A.pullRequestId, second),
    );
    expect(previous?.units).toEqual(UNITS);
    expect(previous?.document.provenance.pullRequest.number).toBe(847);
    // Not offered to itself.
    expect(
      await db.withOrg(A.orgId, (tx) => loadPreviousAnalysis(tx, A.pullRequestId, first)),
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
    expect(await db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, id))).toBe(false);
  });

  it("a retryable failure puts the row back in the queue", async () => {
    const id = await running(A, "1".repeat(40));
    expect(await db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, id))).toBe(true);
    expect((await row(id))?.status).toBe("queued");
  });

  it("units without a finished document are refused by the database (CHECK)", async () => {
    const id = await running(A, "2".repeat(40));
    await expect(
      db.withOrg(A.orgId, (tx) =>
        tx.query("update analyses set file_units = '[]'::jsonb where id = $1", [id]),
      ),
    ).rejects.toThrow(/analyses_file_units_when_done/);
  });

  it("a stored document that no longer validates is not offered for reuse", async () => {
    const first = await running(B, "3".repeat(40));
    await db.withOrg(B.orgId, (tx) => completeAnalysis(tx, first, DOCUMENT, UNITS));
    await superuser.query(
      "update analyses set document = jsonb_set(document, '{findings,0,range,start}', '999') where id = $1",
      [first],
    );
    const second = await running(B, "4".repeat(40));
    expect(
      await db.withOrg(B.orgId, (tx) => loadPreviousAnalysis(tx, B.pullRequestId, second)),
    ).toBeUndefined();
  });

  describe("tenancy", () => {
    it("another org cannot claim, finish, requeue or reuse a row", async () => {
      const id = await running(A, "5".repeat(40));
      await db.withOrg(A.orgId, (tx) => requeueAnalysis(tx, id));
      await db.withOrg(B.orgId, async (tx) => {
        expect(await startAnalysis(tx, id)).toBeUndefined();
        expect(await completeAnalysis(tx, id, DOCUMENT, UNITS)).toBe(false);
        expect(await failAnalysis(tx, id, "internal_error")).toBe(false);
        expect(await requeueAnalysis(tx, id)).toBe(false);
        expect(await loadPreviousAnalysis(tx, A.pullRequestId, UNKNOWN)).toBeUndefined();
      });
      expect((await row(id))?.status).toBe("queued");
    });

    it("an org cannot queue an analysis of another org's revision (composite FK)", async () => {
      await expect(db.withOrg(B.orgId, (tx) => enqueueAnalysis(tx, A.revisionId))).rejects.toThrow(
        /analyses_revision_fk/,
      );
    });

    it("ids are shape-checked before any query", async () => {
      await db.withOrg(A.orgId, async (tx) => {
        await expect(startAnalysis(tx, "1; drop table analyses")).rejects.toThrow(
          /invalid analysis id/,
        );
        await expect(enqueueAnalysis(tx, "x")).rejects.toThrow(/invalid revision id/);
        await expect(loadPreviousAnalysis(tx, "x", UNKNOWN)).rejects.toThrow(
          /invalid pull request id/,
        );
      });
    });
  });
});
