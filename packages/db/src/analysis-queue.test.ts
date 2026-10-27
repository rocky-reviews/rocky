import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANALYSIS_MAX_ATTEMPTS,
  approveAnalysisOverLimit,
  enqueueAnalysis,
  enqueueHeadAnalysis,
  failAnalysis,
  holdAnalysis,
  loadAnalysisTarget,
  renewAnalysisLease,
  requeueAnalysis,
  type ClaimedAnalysis,
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
 * P4-6 (migration 0012, ADR 0017): the analysis queue as Postgres runs it. The claim is
 * cross-tenant and the worker's alone; it leases rows, caps running rows per org, hands rows out
 * round-robin across orgs, and reclaims expired leases. Holding over the token limit and
 * "Analyze anyway" run under RLS as the application role.
 */

let pgs: TestPostgres;
let app: Db;
let worker: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;
let C: SeededOrg;

beforeAll(async () => {
  pgs = await startPostgres();
  app = createDb({ connectionString: pgs.appUrl, max: 2 });
  worker = createDb({ connectionString: pgs.workerUrl, max: 2 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 61 }));
  B = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 62 }));
  C = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 63 }));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await worker?.close();
  await superuser?.end();
  await pgs?.stop();
});

// Every test starts with an empty queue and orgs never served (the round tie-break): the claim
// is global.
beforeEach(async () => {
  await superuser.query(
    `update analyses set status = 'failed', error_code = 'test_reset', completed_at = now(),
            lease_id = null, lease_until = null
      where status in ('queued', 'running', 'awaiting_approval')`,
  );
  await superuser.query("update analyses set claimed_at = null");
});

let nextHead = 1;

/**
 * `n` new revisions (pushes) of the org's pull request, each with a queued analysis; ids in
 * order. The pull request's head moves to the last one.
 */
const queue = async (org: SeededOrg, n: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const head = (nextHead++).toString(16).padStart(40, "0");
    ids.push(
      await app.withOrg(org.orgId, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `insert into pr_revisions (pull_request_id, head_sha, base_sha) values ($1, $2, $3)
           returning id`,
          [org.pullRequestId, head, "b".repeat(40)],
        );
        await tx.query("update pull_requests set head_sha = $2, state = 'open' where id = $1", [
          org.pullRequestId,
          head,
        ]);
        return enqueueAnalysis(tx, rows[0]!.id);
      }),
    );
  }
  return ids;
};

const claim = (limit: number, orgConcurrency = 2, leaseSeconds = 600) =>
  worker.claimAnalyses({ limit, leaseSeconds, orgConcurrency });

const stateOf = async (id: string) =>
  (
    await superuser.query<{
      status: string;
      attempts: number;
      error_code: string | null;
      lease_id: string | null;
      estimated_tokens: number | null;
      limit_tokens: number | null;
      approved_tokens: number | null;
      approved_by: string | null;
    }>(
      `select status, attempts, error_code, lease_id::text, estimated_tokens, limit_tokens,
              approved_tokens, approved_by::text
         from analyses where id = $1`,
      [id],
    )
  ).rows[0]!;

const expireLease = (id: string) =>
  superuser.query("update analyses set lease_until = now() - interval '1 second' where id = $1", [
    id,
  ]);

const done = (claims: readonly ClaimedAnalysis[]) =>
  Promise.all(
    claims.map((c) => app.withOrg(c.orgId, (tx) => failAnalysis(tx, c, "internal_error"))),
  );

describe("claim (worker.claim_analyses)", () => {
  it("leases queued rows: running, a token, a deadline, one attempt; nothing twice", async () => {
    const [id] = await queue(A, 1);
    const [claimed, ...rest] = await claim(10);
    expect(rest).toEqual([]);
    expect(claimed).toMatchObject({ orgId: A.orgId, analysisId: id, attempts: 1 });
    expect(claimed!.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed!.leaseUntil.getTime()).toBeGreaterThan(Date.now() + 500_000);
    expect(await stateOf(id!)).toMatchObject({
      status: "running",
      lease_id: claimed!.leaseId,
    });
    expect(await claim(10)).toEqual([]);
    expect(await app.withOrg(A.orgId, (tx) => loadAnalysisTarget(tx, claimed!))).toBeDefined();
  });

  it("only the worker login may claim; the server's gets insufficient_privilege", async () => {
    await queue(A, 1);
    const server = new pg.Pool({ connectionString: pgs.appUrl, max: 1 }).on(
      "error",
      ignoreIdleError,
    );
    try {
      await expect(
        server.query("select * from worker.claim_analyses(1, 60, 1)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app.claimAnalyses({ limit: 1, leaseSeconds: 60, orgConcurrency: 1 }),
      ).rejects.toMatchObject({ name: "AnalysisStoreError", code: "42501" });
    } finally {
      await server.end();
    }
    expect(await claim(1)).toHaveLength(1);
  });

  it("caps running rows per org, across claims, until one finishes", async () => {
    await queue(A, 5);
    const first = await claim(10, 2);
    expect(first.map((c) => c.orgId)).toEqual([A.orgId, A.orgId]);
    expect(await claim(10, 2)).toEqual([]);
    await done(first.slice(0, 1));
    const next = await claim(10, 2);
    expect(next).toHaveLength(1);
    // A larger cap on a later claim lets more through (the cap is the claimer's setting).
    expect(await claim(10, 4)).toHaveLength(2);
  });

  it("hands rows out round-robin: an org with 50 waiting cannot keep another out", async () => {
    // A's backlog is older than every row of B and C.
    await queue(A, 50);
    const b = await queue(B, 3);
    const c = await queue(C, 1);
    const claims = await claim(5, 3);
    // Round 1: every org's oldest row; round 2: the second ones (C has none); then round 3.
    expect(claims.map((x) => x.orgId)).toEqual([A.orgId, B.orgId, C.orgId, A.orgId, B.orgId]);
    expect(claims.filter((x) => x.orgId === B.orgId).map((x) => x.analysisId)).toEqual(
      b.slice(0, 2),
    );
    expect(claims.some((x) => x.analysisId === c[0])).toBe(true);
    // Equally busy orgs tie on the round and the older row goes first; A is now at its cap.
    const third = await claim(1, 3);
    expect(third.map((x) => x.orgId)).toEqual([A.orgId]);
    // B's two finish: its last row goes out, and nothing of A's 47 waiting rows.
    await done(claims.filter((x) => x.orgId === B.orgId));
    const last = await claim(5, 3);
    expect(last.map((x) => x.analysisId)).toEqual([b[2]]);
    // An idle org goes before a busy one, whatever the ages: with A running 1 and B none, B's
    // new row (round 1) is handed out before A's older ones (round 2, then 3).
    await done([...claims.filter((x) => x.orgId === A.orgId), ...last]);
    const [b4] = await queue(B, 1);
    const next = await claim(3, 3);
    expect(next.map((x) => x.orgId)).toEqual([B.orgId, A.orgId, A.orgId]);
    expect(next[0]!.analysisId).toBe(b4);
  });

  /** One claim at a time, each finished before the next (one worker with one slot). */
  const singleClaims = async (n: number): Promise<string[]> => {
    const order: string[] = [];
    for (let i = 0; i < n; i++) {
      const [c] = await claim(1, 2);
      if (c === undefined) break;
      order.push(c.orgId === A.orgId ? "A" : c.orgId === B.orgId ? "B" : "C");
      await done([c]);
    }
    return order;
  };

  it("review round 1, SF1: single claims alternate by least recent service, not row age", async () => {
    await queue(A, 10);
    await queue(B, 1);
    const order = await singleClaims(11);
    expect(order).toHaveLength(11);
    // B's only row is older than none of A's, yet it goes within the first two claims.
    expect(order.indexOf("B")).toBeLessThanOrEqual(1);
  });

  it("review round 1, SF1 (mutation check): row age as the tie-break would fail that bound", async () => {
    // Swap the claim for one whose only change is the tie-break (row age instead of the org's
    // last service), run the same scenario, and expect B to wait behind A's whole backlog.
    const { rows } = await superuser.query<{ def: string }>(
      "select pg_get_functiondef('worker.claim_analyses(integer, integer, integer)'::regprocedure) as def",
    );
    const original = rows[0]!.def;
    const fifo = original.replace(
      "ORDER BY k.round, k.served NULLS FIRST, k.available_at, k.created_at, k.id",
      "ORDER BY k.round, k.available_at, k.created_at, k.id",
    );
    expect(fifo).not.toBe(original);
    await superuser.query(fifo);
    try {
      await queue(A, 10);
      await queue(B, 1);
      expect((await singleClaims(11)).indexOf("B")).toBe(10);
    } finally {
      await superuser.query(original);
    }
  });

  it("skips orgs scheduled for deletion, and rows waiting for approval or a retry", async () => {
    const [a] = await queue(A, 1);
    const [b] = await queue(B, 1);
    const [c] = await queue(C, 1);
    await superuser.query("update orgs set delete_after = now() where id = $1", [C.orgId]);
    try {
      const [held] = await claim(1);
      expect(held!.analysisId).toBe(a);
      await app.withOrg(A.orgId, (tx) =>
        holdAnalysis(tx, held!, { estimatedTokens: 200_000, tokenLimit: 150_000 }),
      );
      const [retried] = await claim(1);
      expect(retried!.analysisId).toBe(b);
      await app.withOrg(B.orgId, (tx) => requeueAnalysis(tx, retried!, "llm_overloaded", 60_000));
      expect(await claim(10)).toEqual([]);
      // Once the delay has passed, the retry is claimable again; the held row and C's still not.
      await superuser.query("update analyses set available_at = now() where id = $1", [b]);
      expect((await claim(10)).map((x) => x.analysisId)).toEqual([b]);
      expect((await stateOf(c!)).status).toBe("queued");
    } finally {
      await superuser.query("update orgs set delete_after = null where id = $1", [C.orgId]);
    }
  });

  it("reclaims an expired lease (a crash); the old holder can no longer finish or renew", async () => {
    const [id] = await queue(A, 1);
    const [first] = await claim(1);
    await expireLease(id!);
    const [second] = await claim(1);
    expect(second).toMatchObject({ analysisId: id, attempts: 2 });
    expect(second!.leaseId).not.toBe(first!.leaseId);
    await app.withOrg(A.orgId, async (tx) => {
      expect(await loadAnalysisTarget(tx, first!)).toBeUndefined();
      expect(await failAnalysis(tx, first!, "internal_error")).toBe(false);
      expect(await requeueAnalysis(tx, first!, "internal_error", 0)).toBe(false);
      expect(await renewAnalysisLease(tx, first!, 600)).toBe(false);
    });
    expect(await stateOf(id!)).toMatchObject({
      status: "running",
      lease_id: second!.leaseId,
    });
  });

  it(`fails a row as lease_expired once ${ANALYSIS_MAX_ATTEMPTS} claims expired`, async () => {
    const [id] = await queue(A, 1);
    for (let attempt = 1; attempt <= ANALYSIS_MAX_ATTEMPTS; attempt++) {
      const [c] = await claim(1);
      expect(c).toMatchObject({ analysisId: id, attempts: attempt });
      await expireLease(id!);
    }
    expect(await claim(1)).toEqual([]);
    expect(await stateOf(id!)).toMatchObject({
      status: "failed",
      error_code: "lease_expired",
      lease_id: null,
    });
  });

  it("a live lease is renewed; an expired one is not", async () => {
    await queue(A, 1);
    const [c] = await claim(1, 2, 30);
    expect(c!.leaseUntil.getTime()).toBeLessThan(Date.now() + 40_000);
    expect(await app.withOrg(A.orgId, (tx) => renewAnalysisLease(tx, c!, 900))).toBe(true);
    const { rows } = await superuser.query<{ left: number }>(
      "select extract(epoch from lease_until - now())::int as left from analyses where id = $1",
      [c!.analysisId],
    );
    expect(rows[0]!.left).toBeGreaterThan(800);
    await expect(app.withOrg(A.orgId, (tx) => renewAnalysisLease(tx, c!, 5))).rejects.toThrow(
      /invalid lease seconds/,
    );
    await expireLease(c!.analysisId);
    expect(await app.withOrg(A.orgId, (tx) => renewAnalysisLease(tx, c!, 900))).toBe(false);
  });

  it("refuses claim bounds that are not integers before any query", async () => {
    await expect(
      worker.claimAnalyses({ limit: 1.5, leaseSeconds: 60, orgConcurrency: 1 }),
    ).rejects.toThrow(/invalid claim bounds/);
  });
});

describe("per-PR token limit and Analyze anyway", () => {
  const hold = async (org: SeededOrg) => {
    const [id] = await queue(org, 1);
    const [c] = await claim(1);
    expect(c!.analysisId).toBe(id);
    expect(
      await app.withOrg(org.orgId, (tx) =>
        holdAnalysis(tx, c!, { estimatedTokens: 212_345, tokenLimit: 150_000 }),
      ),
    ).toBe(true);
    return c!;
  };

  it("holding stores the estimate and the limit, and releases the lease", async () => {
    const c = await hold(A);
    expect(await stateOf(c.analysisId)).toMatchObject({
      status: "awaiting_approval",
      estimated_tokens: 212_345,
      limit_tokens: 150_000,
      lease_id: null,
      attempts: 1,
    });
    // The holder's lease is spent: it cannot finish the row behind the person's back.
    expect(await app.withOrg(A.orgId, (tx) => failAnalysis(tx, c, "internal_error"))).toBe(false);
    await expect(
      app.withOrg(A.orgId, (tx) => holdAnalysis(tx, c, { estimatedTokens: -1, tokenLimit: 1 })),
    ).rejects.toThrow(/invalid estimate/);
    await expect(
      app.withOrg(A.orgId, (tx) => holdAnalysis(tx, c, { estimatedTokens: 1, tokenLimit: 0 })),
    ).rejects.toThrow(/invalid token limit/);
  });

  it("Analyze anyway: queued again for this row, approved up to the estimate, audited", async () => {
    const c = await hold(A);
    const approval = await app.withOrg(A.orgId, (tx) =>
      approveAnalysisOverLimit(tx, c.analysisId, { memberId: A.memberId }),
    );
    expect(approval).toMatchObject({
      analysisId: c.analysisId,
      estimatedTokens: 212_345,
      tokenLimit: 150_000,
    });
    expect(await stateOf(c.analysisId)).toMatchObject({
      status: "queued",
      attempts: 0,
      approved_tokens: 212_345,
      approved_by: A.memberId,
    });
    const events = await superuser.query<{
      actor_type: string;
      actor_id: string;
      metadata: Record<string, unknown>;
    }>(
      `select actor_type, actor_id, metadata from audit_events
        where org_id = $1 and action = 'analysis.limit_overridden' and target_id = $2`,
      [A.orgId, c.analysisId],
    );
    expect(events.rows).toEqual([
      {
        actor_type: "user",
        actor_id: A.memberId,
        metadata: {
          revisionId: approval!.revisionId,
          estimatedTokens: 212_345,
          tokenLimit: 150_000,
        },
      },
    ]);
    // Only once: the row is no longer waiting.
    expect(
      await app.withOrg(A.orgId, (tx) =>
        approveAnalysisOverLimit(tx, c.analysisId, { memberId: A.memberId }),
      ),
    ).toBeUndefined();
    // The next claim carries the approval to the run.
    const [again] = await claim(1);
    expect(again).toMatchObject({ analysisId: c.analysisId, attempts: 1 });
    const target = await app.withOrg(A.orgId, (tx) => loadAnalysisTarget(tx, again!));
    expect(target?.approvedTokens).toBe(212_345);
  });

  it("is refused for another org's row, a non-member, or a row that is not waiting", async () => {
    const c = await hold(A);
    expect(
      await app.withOrg(B.orgId, (tx) =>
        approveAnalysisOverLimit(tx, c.analysisId, { memberId: B.memberId }),
      ),
    ).toBeUndefined();
    // B's member id is not a member of A.
    expect(
      await app.withOrg(A.orgId, (tx) =>
        approveAnalysisOverLimit(tx, c.analysisId, { memberId: B.memberId }),
      ),
    ).toBeUndefined();
    await expect(
      app.withOrg(A.orgId, (tx) => approveAnalysisOverLimit(tx, c.analysisId, { memberId: "x" })),
    ).rejects.toThrow(/invalid member id/);
    expect((await stateOf(c.analysisId)).status).toBe("awaiting_approval");
    const [queued] = await queue(A, 1);
    expect(
      await app.withOrg(A.orgId, (tx) =>
        approveAnalysisOverLimit(tx, queued!, { memberId: A.memberId }),
      ),
    ).toBeUndefined();
    const audited = await superuser.query(
      "select 1 from audit_events where action = 'analysis.limit_overridden' and target_id = $1",
      [c.analysisId],
    );
    expect(audited.rowCount).toBe(0);
  });

  it("review round 1, SF3: refused once the revision is superseded by a push, or the PR is closed", async () => {
    const old = await hold(A);
    // A push: the pull request's head moves on.
    await queue(A, 1);
    expect(
      await app.withOrg(A.orgId, (tx) =>
        approveAnalysisOverLimit(tx, old.analysisId, { memberId: A.memberId }),
      ),
    ).toBeUndefined();
    expect((await stateOf(old.analysisId)).status).toBe("awaiting_approval");
    await superuser.query(
      "update analyses set status = 'failed', completed_at = now() where org_id = $1 and status = 'queued'",
      [A.orgId],
    );
    const head = await hold(A);
    await superuser.query("update pull_requests set state = 'closed' where id = $1", [
      A.pullRequestId,
    ]);
    try {
      expect(
        await app.withOrg(A.orgId, (tx) =>
          approveAnalysisOverLimit(tx, head.analysisId, { memberId: A.memberId }),
        ),
      ).toBeUndefined();
    } finally {
      await superuser.query("update pull_requests set state = 'open' where id = $1", [
        A.pullRequestId,
      ]);
    }
    expect(
      await app.withOrg(A.orgId, (tx) =>
        approveAnalysisOverLimit(tx, head.analysisId, { memberId: A.memberId }),
      ),
    ).toBeDefined();
  });

  it("a held row is not claimable, and blocks a second analysis of its revision", async () => {
    const c = await hold(A);
    expect(await claim(10)).toEqual([]);
    const { rows } = await superuser.query<{ revision_id: string }>(
      "select revision_id from analyses where id = $1",
      [c.analysisId],
    );
    expect(await app.withOrg(A.orgId, (tx) => enqueueAnalysis(tx, rows[0]!.revision_id))).toBe(
      c.analysisId,
    );
  });
});

describe("enqueueHeadAnalysis (the mirror)", () => {
  const revision = (org: SeededOrg, head: string, reading: "read" | "unavailable" | "none") =>
    superuser.query(
      `insert into pr_revisions (org_id, pull_request_id, head_sha, base_sha, diff_bytes,
                                 diff_sha256, diff_truncation, diff_truncated)
       values ($1, $2, $3, $4, $5, $6, $7::text, $7::text is not null)`,
      [
        org.orgId,
        org.pullRequestId,
        head,
        "b".repeat(40),
        reading === "none" ? null : 10,
        reading === "none" ? null : Buffer.alloc(32),
        reading === "unavailable" ? "unavailable" : null,
      ],
    );

  it("queues a head revision once, and only one whose diff was read", async () => {
    await revision(A, "e1".repeat(20), "read");
    await revision(A, "e2".repeat(20), "unavailable");
    await revision(A, "e3".repeat(20), "none");
    await app.withOrg(A.orgId, async (tx) => {
      const id = await enqueueHeadAnalysis(tx, A.pullRequestId, "e1".repeat(20));
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await enqueueHeadAnalysis(tx, A.pullRequestId, "e1".repeat(20))).toBeUndefined();
      expect(await enqueueHeadAnalysis(tx, A.pullRequestId, "e2".repeat(20))).toBeUndefined();
      expect(await enqueueHeadAnalysis(tx, A.pullRequestId, "e3".repeat(20))).toBeUndefined();
      await expect(enqueueHeadAnalysis(tx, A.pullRequestId, "nothex")).rejects.toThrow(
        /invalid head sha/,
      );
    });
    // Another org's pull request id matches nothing under RLS.
    expect(
      await app.withOrg(B.orgId, (tx) => enqueueHeadAnalysis(tx, A.pullRequestId, "e1".repeat(20))),
    ).toBeUndefined();
    // A finished analysis also counts: the mirror never queues a revision twice.
    const [c] = await claim(1);
    await app.withOrg(A.orgId, (tx) => failAnalysis(tx, c!, "internal_error"));
    expect(
      await app.withOrg(A.orgId, (tx) => enqueueHeadAnalysis(tx, A.pullRequestId, "e1".repeat(20))),
    ).toBeUndefined();
  });
});
