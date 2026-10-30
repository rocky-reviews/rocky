import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { lockReviewPlan } from "./reviews.js";
import {
  addOwnComment,
  decideDraft,
  deleteOwnComment,
  DraftStoreError,
  listReviewDrafts,
} from "./drafts.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  setAnalysisDocument,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P6-4 (migration 0015, ADR 0027): draft decisions and pending comments on a real Postgres as
 * the application role. Every transition is persisted and read back from a new transaction
 * ("refresh keeps state"), per reviewer, inside one org, and only what the analysis says is
 * stored as a draft's location and body.
 */

let pgs: TestPostgres;
let db: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;
let bob: string;

const F1 = pr847.findings.find((f) => f.id === "F1")!;
const F2 = pr847.findings.find((f) => f.id === "F2")!;

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 6 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 71 }),
    await seedOrg(w, newOrgId(), { installationId: 72 }),
  ]);
  await setAnalysisDocument(db, A.orgId, A.analysisId, pr847);
  await setAnalysisDocument(db, B.orgId, B.analysisId, pr847);
  bob = await db.withOrg(A.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into members (forge_user_id, login) values (1002, 'bob') returning id",
    );
    return rows[0]!.id;
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

beforeEach(async () => {
  for (const org of [A, B]) {
    await db.withOrg(org.orgId, async (tx) => {
      await tx.query("delete from comments_pending where analysis_id is not null");
      await tx.query("delete from findings_state where finding_id <> 'f-1'");
    });
  }
  // The attempt tables grant no DELETE to the app role (ADR 0026): the superuser clears them.
  await superuser.query("delete from review_submissions where org_id = $1 and id <> $2", [
    A.orgId,
    A.reviewSubmissionId,
  ]);
});

const me = () => ({ analysisId: A.analysisId, memberId: A.memberId });
const decide = (findingId: string, action: Parameters<typeof decideDraft>[1]["action"]) =>
  db.withOrg(A.orgId, (tx) => decideDraft(tx, { ...me(), findingId, action }));
/** A fresh transaction, as a page reload would read it. */
const reload = (memberId = A.memberId) =>
  db.withOrg(A.orgId, (tx) => listReviewDrafts(tx, { analysisId: A.analysisId, memberId }));
const pending = async () =>
  (
    await superuser.query(
      `select author_id, analysis_id, finding_id, source, path, start_line, line, body, revision_id, pull_request_id
         from comments_pending where org_id = $1 and analysis_id is not null order by created_at`,
      [A.orgId],
    )
  ).rows;

/** Some backend is waiting for a lock (the second decision, queued behind the first). */
const waitingOnLock = async () =>
  (
    await superuser.query(
      "select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    )
  ).rowCount! > 0;

describe("every transition is persisted (refresh keeps state)", () => {
  it("accept: the draft becomes the reviewer's pending comment with the finding's body and location", async () => {
    const result = await decide("F1", { kind: "accept" });
    expect(result).toMatchObject({
      outcome: "ok",
      draft: { findingId: "F1", state: "accepted", edited: false, body: F1.body, reason: null },
    });
    const view = await reload();
    expect(view?.drafts).toEqual([
      expect.objectContaining({ findingId: "F1", state: "accepted", edited: false, body: F1.body }),
    ]);
    expect(await pending()).toEqual([
      {
        author_id: A.memberId,
        analysis_id: A.analysisId,
        finding_id: "F1",
        source: "ai",
        path: F1.path,
        start_line: null,
        line: F1.range.end,
        body: F1.body,
        revision_id: A.revisionId,
        pull_request_id: A.pullRequestId,
      },
    ]);
  });

  it("edit: the reviewer's body is stored, marked edited", async () => {
    const result = await decide("F2", { kind: "edit", body: "  Please add `requireOrgRole`. " });
    expect(result).toMatchObject({
      outcome: "ok",
      draft: { state: "accepted", edited: true, body: "Please add `requireOrgRole`." },
    });
    expect((await reload())?.drafts[0]).toMatchObject({ edited: true, state: "accepted" });
    expect(await pending()).toEqual([
      expect.objectContaining({ finding_id: "F2", source: "ai_edited", path: F2.path }),
    ]);
  });

  it("dismiss: the reason code is kept for project memory; nothing will be posted", async () => {
    expect(await decide("F1", { kind: "dismiss", reason: "intentional" })).toMatchObject({
      outcome: "ok",
      draft: { state: "dismissed", reason: "intentional", body: null },
    });
    expect((await reload())?.drafts).toEqual([
      expect.objectContaining({ findingId: "F1", state: "dismissed", reason: "intentional" }),
    ]);
    expect(await pending()).toEqual([]);
    const row = await superuser.query(
      "select reason, decided_by, decided_at is not null as decided from findings_state where org_id = $1 and finding_id = 'F1'",
      [A.orgId],
    );
    expect(row.rows).toEqual([{ reason: "intentional", decided_by: A.memberId, decided: true }]);
  });

  it("undo from accepted, edited and dismissed: back to a draft, the pending comment is gone", async () => {
    for (const action of [
      { kind: "accept" },
      { kind: "edit", body: "mine" },
      { kind: "dismiss", reason: "not_worth_it" },
    ] as const) {
      await decide("F1", action);
      expect(await decide("F1", { kind: "undo" })).toMatchObject({
        outcome: "ok",
        draft: { state: "draft", reason: null, body: null, edited: false },
      });
      expect(await pending()).toEqual([]);
      // An undone draft that was never sent to an agent is just a draft: nothing to show.
      expect((await reload())?.drafts).toEqual([]);
    }
  });

  it("send to agent: noted with a time, the draft stays undecided", async () => {
    const result = await decide("F1", { kind: "send_to_agent" });
    expect(result).toMatchObject({ outcome: "ok", draft: { state: "draft" } });
    const [draft] = (await reload())!.drafts;
    expect(draft).toMatchObject({ findingId: "F1", state: "draft" });
    expect(draft?.agentPromptCopiedAt).toBeInstanceOf(Date);
    // The note survives a later decision and its undo.
    await decide("F1", { kind: "accept" });
    await decide("F1", { kind: "undo" });
    expect((await reload())!.drafts[0]?.agentPromptCopiedAt).toBeInstanceOf(Date);
  });

  it("refuses transitions the state machine refuses, and reports the current state", async () => {
    await decide("F1", { kind: "accept" });
    expect(await decide("F1", { kind: "dismiss", reason: "intentional" })).toMatchObject({
      outcome: "invalid_transition",
      draft: { state: "accepted" },
    });
    expect(await decide("F2", { kind: "undo" })).toMatchObject({
      outcome: "invalid_transition",
      draft: { state: "draft" },
    });
    expect(await decide("F2", { kind: "edit", body: "   " })).toEqual({ outcome: "invalid_body" });
    expect(await pending()).toHaveLength(1);
  });

  it("two concurrent decisions on one draft: exactly one wins, one pending comment", async () => {
    const results = await Promise.all([
      decide("F1", { kind: "accept" }),
      decide("F1", { kind: "dismiss", reason: "intentional" }),
      decide("F1", { kind: "edit", body: "x" }),
    ]);
    const won = results.filter((r) => r.outcome === "ok");
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "invalid_transition")).toHaveLength(2);
    const winner = won[0]!.draft;
    if (winner.state === "dismissed") {
      expect(await pending()).toEqual([]);
    } else {
      expect(winner.state).toBe("accepted");
      expect(await pending()).toEqual([
        expect.objectContaining({
          finding_id: "F1",
          source: winner.edited ? "ai_edited" : "ai",
          body: winner.edited ? "x" : F1.body,
        }),
      ]);
    }
    // Every loser is told the winner's state, body included.
    for (const r of results.filter((x) => x.outcome === "invalid_transition"))
      expect(r).toMatchObject({ draft: winner });
  });

  it("a request that waited for the lock answers with the winner's committed body (409)", async () => {
    // The row exists already, so the second request does not wait on the insert.
    await decide("F1", { kind: "send_to_agent" });
    let lockTaken!: () => void;
    const locked = new Promise<void>((resolve) => (lockTaken = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The first request holds its locks before it writes anything, in decideDraft's order: the
    // posting lock (ADR 0026 S2), then the row.
    const first = db.withOrg(A.orgId, async (tx) => {
      await lockReviewPlan(tx, A.pullRequestId, A.memberId);
      await tx.query(
        `select 1 from findings_state
          where analysis_id = $1 and member_id = $2 and finding_id = 'F1' for update`,
        [A.analysisId, A.memberId],
      );
      lockTaken();
      await held;
      return decideDraft(tx, {
        ...me(),
        findingId: "F1",
        action: { kind: "edit", body: "The winner's words." },
      });
    });
    await locked;
    const second = decide("F1", { kind: "accept" });
    await expect.poll(waitingOnLock, { timeout: 5000 }).toBe(true);
    release();
    expect(await first).toMatchObject({
      outcome: "ok",
      draft: { state: "accepted", edited: true },
    });
    expect(await second).toEqual({
      outcome: "invalid_transition",
      draft: expect.objectContaining({
        state: "accepted",
        edited: true,
        body: "The winner's words.",
      }),
    });
  });
});

describe("drafts are per reviewer, per analysis, per org", () => {
  it("another reviewer of the same PR sees their own drafts, not mine", async () => {
    await decide("F1", { kind: "accept" });
    expect((await reload(bob))?.drafts).toEqual([]);
    await db.withOrg(A.orgId, (tx) =>
      decideDraft(tx, {
        analysisId: A.analysisId,
        memberId: bob,
        findingId: "F1",
        action: { kind: "dismiss", reason: "not_an_issue" },
      }),
    );
    expect((await reload())?.drafts[0]).toMatchObject({ state: "accepted" });
    expect((await reload(bob))?.drafts[0]).toMatchObject({ state: "dismissed" });
  });

  it("an analysis of another org is not found (RLS), and nothing is written there", async () => {
    const result = await db.withOrg(A.orgId, (tx) =>
      decideDraft(tx, {
        analysisId: B.analysisId,
        memberId: A.memberId,
        findingId: "F1",
        action: { kind: "accept" },
      }),
    );
    expect(result).toEqual({ outcome: "not_found" });
    expect(
      await db.withOrg(A.orgId, (tx) =>
        listReviewDrafts(tx, { analysisId: B.analysisId, memberId: A.memberId }),
      ),
    ).toBeNull();
    const rows = await superuser.query(
      "select 1 from findings_state where org_id = $1 and finding_id = 'F1'",
      [B.orgId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("a finding id the document does not have is unknown (the client cannot invent drafts)", async () => {
    expect(await decide("F99", { kind: "accept" })).toEqual({ outcome: "unknown_finding" });
    expect(await decide("../F1", { kind: "accept" })).toEqual({ outcome: "unknown_finding" });
  });

  it("an analysis that is not done has no drafts", async () => {
    const queued = await db.withOrg(A.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "insert into analyses (revision_id, status) values ($1, 'queued') returning id",
        [A.revisionId],
      );
      return rows[0]!.id;
    });
    const result = await db.withOrg(A.orgId, (tx) =>
      decideDraft(tx, { ...me(), analysisId: queued, findingId: "F1", action: { kind: "accept" } }),
    );
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("ids are validated before any query", async () => {
    await expect(
      db.withOrg(A.orgId, (tx) =>
        listReviewDrafts(tx, { analysisId: "x' or 1=1", memberId: A.memberId }),
      ),
    ).rejects.toBeInstanceOf(DraftStoreError);
  });
});

describe("own comments", () => {
  const add = (input: { path: string; line: number; body: string }, memberId = A.memberId) =>
    db.withOrg(A.orgId, (tx) =>
      addOwnComment(tx, { analysisId: A.analysisId, memberId, ...input }),
    );

  it("are stored on a new-side line inside a hunk, listed back, and deleted by their author only", async () => {
    const created = await add({ path: "src/api/index.ts", line: 21, body: " Nice. " });
    expect(created).toMatchObject({
      outcome: "created",
      comment: { path: "src/api/index.ts", line: 21, body: "Nice." },
    });
    if (created.outcome !== "created") throw new Error("not created");
    expect((await reload())?.comments).toEqual([
      expect.objectContaining({ id: created.comment.id, path: "src/api/index.ts", line: 21 }),
    ]);
    expect((await reload(bob))?.comments).toEqual([]);
    const byBob = await db.withOrg(A.orgId, (tx) =>
      deleteOwnComment(tx, {
        analysisId: A.analysisId,
        memberId: bob,
        commentId: created.comment.id,
      }),
    );
    expect(byBob).toBe("not_found");
    const mine = await db.withOrg(A.orgId, (tx) =>
      deleteOwnComment(tx, { ...me(), commentId: created.comment.id }),
    );
    expect(mine).toBe("deleted");
    expect((await reload())?.comments).toEqual([]);
  });

  it("refuses a location outside the diff and an empty body", async () => {
    for (const input of [
      { path: "src/api/index.ts", line: 2, body: "x" }, // before the first hunk
      { path: "src/api/index.ts", line: 999, body: "x" },
      { path: "not/in/the/pr.ts", line: 1, body: "x" },
      { path: "src/auth/invitations.ts", line: 0, body: "x" },
      { path: "src/auth/invitations.ts", line: 1.5, body: "x" },
    ]) {
      expect(await add(input), JSON.stringify(input)).toEqual({ outcome: "invalid_location" });
    }
    expect(await add({ path: "src/auth/invitations.ts", line: 1, body: " " })).toEqual({
      outcome: "invalid_body",
    });
  });

  it("an accepted draft cannot be deleted as a comment: only its undo removes it", async () => {
    await decide("F1", { kind: "accept" });
    const [row] = await pending();
    expect(row).toBeDefined();
    const { rows } = await superuser.query<{ id: string }>(
      "select id from comments_pending where org_id = $1 and finding_id = 'F1'",
      [A.orgId],
    );
    expect(
      await db.withOrg(A.orgId, (tx) => deleteOwnComment(tx, { ...me(), commentId: rows[0]!.id })),
    ).toBe("not_found");
  });
});

describe("posted items are flagged (P6-6: read-only once carried by an attempt)", () => {
  /** An attempt as P3-5 records it before the forge call, carrying the given items. */
  const attempt = async (
    status: "posting" | "posted" | "failed",
    items: readonly { kind: "draft" | "comment"; itemId: string }[],
  ) =>
    db.withOrg(A.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into review_submissions
           (pull_request_id, revision_id, submitted_by, idempotency_key, head_sha, verdict,
            content_sha256, body_sha256, draft_count, comment_count, status, forge_review_id,
            error_code, finished_at)
         values ($1, $2, $3, gen_random_uuid(), repeat('a', 40), 'comment', decode(repeat('00', 32), 'hex'),
                 decode(repeat('00', 32), 'hex'), 0, 0, $4, $5, $6, $7)
         returning id`,
        [
          A.pullRequestId,
          A.revisionId,
          A.memberId,
          status,
          status === "posted" ? 77 : null,
          status === "failed" ? "lost" : null,
          status === "posting" ? null : new Date(),
        ],
      );
      for (const [seq, item] of items.entries()) {
        await tx.query(
          `insert into review_submission_items (submission_id, seq, kind, item_id, body_sha256)
           values ($1, $2, $3, $4, decode(repeat('00', 32), 'hex'))`,
          [rows[0]!.id, seq, item.kind, item.itemId],
        );
      }
    });
  const stateId = async (findingId: string) =>
    (
      await superuser.query<{ id: string }>(
        "select id from findings_state where org_id = $1 and analysis_id = $2 and finding_id = $3",
        [A.orgId, A.analysisId, findingId],
      )
    ).rows[0]!.id;

  it("an accepted draft and an own comment carried by a posting or posted attempt say so; a failed attempt releases them", async () => {
    await decide("F1", { kind: "accept" });
    await decide("F2", { kind: "accept" });
    const created = await db.withOrg(A.orgId, (tx) =>
      addOwnComment(tx, { ...me(), path: "src/api/index.ts", line: 21, body: "Nice." }),
    );
    if (created.outcome !== "created") throw new Error("not created");
    const before = await reload();
    expect(before?.drafts.map((d) => [d.findingId, d.posted])).toEqual([
      ["F1", null],
      ["F2", null],
    ]);
    expect(before?.comments[0]?.posted).toBeNull();

    await attempt("posted", [{ kind: "draft", itemId: await stateId("F1") }]);
    await attempt("posting", [{ kind: "comment", itemId: created.comment.id }]);
    await attempt("failed", [{ kind: "draft", itemId: await stateId("F2") }]);
    const after = await reload();
    expect(after?.drafts.map((d) => [d.findingId, d.posted])).toEqual([
      ["F1", "posted"],
      ["F2", null],
    ]);
    expect(after?.comments[0]?.posted).toBe("posting");
    // Another reviewer's view is untouched (their own rows are not carried).
    expect((await reload(bob))?.drafts).toEqual([]);
  });
});

describe("the database refuses inconsistent rows (migration 0015)", () => {
  const insert = (sql: string, values: unknown[]) =>
    db
      .withOrg(A.orgId, (tx) => tx.query(sql, values))
      .then(
        () => null,
        (error: { constraint?: string }) => error.constraint ?? "error",
      );

  it("a free-text dismissal reason, a reason on a non-dismissed row, a malformed finding id", async () => {
    const base =
      "insert into findings_state (analysis_id, member_id, finding_id, state, reason, decided_at) values ($1, $2, $3, $4, $5, $6)";
    expect(
      await insert(base, [A.analysisId, A.memberId, "F5", "dismissed", "they said so", new Date()]),
    ).toBe("findings_state_reason_code");
    expect(
      await insert(base, [A.analysisId, A.memberId, "F5", "accepted", "intentional", new Date()]),
    ).toBe("findings_state_reason_only_dismissed");
    expect(await insert(base, [A.analysisId, A.memberId, "../x", "draft", null, null])).toBe(
      "findings_state_finding_id_shape",
    );
  });

  it("a draft comment without its analysis, an own comment naming a finding, two rows for one draft", async () => {
    const base =
      "insert into comments_pending (pull_request_id, revision_id, author_id, analysis_id, finding_id, source, path, line, body) values ($1, $2, $3, $4, $5, $6, 'a.ts', 3, 'x')";
    const ids = [A.pullRequestId, A.revisionId, A.memberId];
    expect(await insert(base, [...ids, null, "F1", "ai"])).toBe(
      "comments_pending_draft_has_analysis",
    );
    expect(await insert(base, [...ids, A.analysisId, "F1", "own"])).toBe(
      "comments_pending_finding_source",
    );
    expect(await insert(base, [...ids, A.analysisId, "F7", "ai"])).toBeNull();
    expect(await insert(base, [...ids, A.analysisId, "F7", "ai_edited"])).toBe(
      "comments_pending_one_per_draft",
    );
  });
});
