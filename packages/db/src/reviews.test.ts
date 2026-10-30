import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalReviewPlan, findingCommentBody } from "@rocky-reviews/core";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  beginReviewSubmission,
  finishReviewSubmission,
  loadReviewPlan,
  loadReviewSubmission,
  recordedReviewIds,
  ReviewStoreError,
  sha256,
  type BeginReviewSubmissionInput,
} from "./reviews.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  markMemberRemoved,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P3-5 (ADR 0026) on a real Postgres as the application role: the plan is exactly the member's
 * own accepted drafts and comments on the head revision, a submission is recorded before the
 * forge is called and cannot be started twice, and every refusal is a fixed code.
 */

const DOCUMENT = JSON.parse(
  readFileSync(new URL("../../schema/fixtures/pr-847.json", import.meta.url), "utf8"),
) as AnalysisDocument;
const HEAD = "a".repeat(40);
const UNKNOWN = "5d1e9f00-dddd-4bcd-9e00-000000000010";

let pgs: TestPostgres;
let db: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;
/** A second member of A (bob), with no decisions of his own. */
let bob: string;

const findingBy = (id: string) => {
  const finding = DOCUMENT.findings.find((f) => f.id === id);
  if (finding === undefined) throw new Error(`no finding ${id}`);
  return finding;
};

/** The seeded analysis gets the real pr-847 document and accepted drafts F1 and F3 by alice. */
const prepare = async (org: SeededOrg, memberId: string, findings = ["F1", "F3"]) =>
  db.withOrg(org.orgId, async (tx) => {
    await tx.query("update analyses set document = $2::jsonb where id = $1", [
      org.analysisId,
      JSON.stringify(DOCUMENT),
    ]);
    await tx.query("delete from findings_state where analysis_id = $1", [org.analysisId]);
    await tx.query("delete from review_submission_items where org_id = $1", [org.orgId]);
    await tx.query("delete from review_submissions where org_id = $1", [org.orgId]);
    await tx.query("delete from comments_pending where pull_request_id = $1", [org.pullRequestId]);
    const ids: Record<string, string> = {};
    for (const [i, id] of findings.entries()) {
      const { rows } = await tx.query<{ id: string }>(
        `insert into findings_state (analysis_id, finding_id, state, decided_by, decided_at)
         values ($1, $2, 'accepted', $3, now() + make_interval(secs => $4)) returning id`,
        [org.analysisId, id, memberId, i],
      );
      ids[id] = rows[0]!.id;
    }
    return ids;
  });

const comment = (
  org: SeededOrg,
  authorId: string,
  body: string,
  options: { path?: string | null; line?: number | null; revisionId?: string } = {},
) =>
  db.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into comments_pending (pull_request_id, revision_id, author_id, path, line, body)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        org.pullRequestId,
        options.revisionId ?? org.revisionId,
        authorId,
        options.path === undefined ? "src/invite.ts" : options.path,
        options.line === undefined ? 12 : options.line,
        body,
      ],
    );
    return rows[0]!.id;
  });

const planOf = (org: SeededOrg, memberId: string) =>
  db.withOrg(org.orgId, (tx) => loadReviewPlan(tx, { pullRequestId: org.pullRequestId, memberId }));

const inputFor = (
  org: SeededOrg,
  memberId: string,
  plan: { contentSha256: Buffer; headSha: string },
  over: Partial<BeginReviewSubmissionInput> = {},
): BeginReviewSubmissionInput => ({
  memberId,
  pullRequestId: org.pullRequestId,
  idempotencyKey: randomUUID(),
  contentSha256: plan.contentSha256.toString("hex"),
  headSha: plan.headSha,
  verdict: "comment",
  body: "Looks fine overall.",
  ...over,
});

const begin = (org: SeededOrg, input: BeginReviewSubmissionInput) =>
  db.withOrg(org.orgId, (tx) => beginReviewSubmission(tx, input));

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 4 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 81 }));
  B = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 82 }));
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
  await prepare(A, A.memberId);
  await prepare(B, B.memberId);
  await db.withOrg(A.orgId, (tx) =>
    tx.query("update members set role = 'member', removed_at = null where id = $1", [bob]),
  );
});

describe("loadReviewPlan", () => {
  it("lists the member's accepted drafts in document order and their own line comments, as they will be posted", async () => {
    const mine = await comment(A, A.memberId, "Validate the email first.");
    await comment(A, A.memberId, "Second thought.", { path: "src/mailer.ts", line: 40 });
    const plan = await planOf(A, A.memberId);
    expect(plan).not.toBeNull();
    expect(plan!.headSha).toBe(HEAD);
    expect(plan!.number).toBe(847);
    expect(plan!.revisionId).toBe(A.revisionId);
    expect(plan!.forgeRepoId).toBe(2001);
    expect(plan!.repositoryFullName).toBe("org-81/api");
    expect(plan!.items.map((i) => [i.kind, i.path, i.line, i.startLine])).toEqual([
      ["draft", "src/auth/invitations.ts", 28, null],
      ["draft", "src/auth/invitations.ts", 23, null],
      ["comment", "src/invite.ts", 12, null],
      ["comment", "src/mailer.ts", 40, null],
    ]);
    expect(plan!.items[0]?.body).toBe(findingCommentBody(findingBy("F1")));
    expect(plan!.items[1]?.body).toBe(findingCommentBody(findingBy("F3")));
    expect(plan!.items[2]).toMatchObject({ id: mine, body: "Validate the email first." });
    expect(plan!.contentSha256).toEqual(sha256(canonicalReviewPlan(HEAD, plan!.items)));
  });

  it("leaves out other people's drafts and comments, dismissed and undecided drafts, other revisions, and comments without a line", async () => {
    await comment(A, bob, "bob's comment");
    await comment(A, A.memberId, "no line", { path: "src/invite.ts", line: null });
    await comment(A, A.memberId, "no path", { path: null, line: null });
    const other = await db.withOrg(A.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into pr_revisions (pull_request_id, head_sha, base_sha)
         values ($1, repeat('c', 40), repeat('b', 40)) returning id`,
        [A.pullRequestId],
      );
      await tx.query(
        `insert into findings_state (analysis_id, finding_id, state, reason, decided_by, decided_at)
         values ($1, 'F2', 'dismissed', 'not here', $2, now()), ($1, 'F4', 'draft', null, null, null)`,
        [A.analysisId, A.memberId],
      );
      // A draft bob accepted on the same analysis is bob's to post, not alice's.
      await tx.query(
        `insert into findings_state (analysis_id, finding_id, state, decided_by, decided_at)
         values ($1, 'F5', 'accepted', $2, now())`,
        [A.analysisId, bob],
      );
      return rows[0]!.id;
    });
    await comment(A, A.memberId, "older revision", { revisionId: other });
    const alice = await planOf(A, A.memberId);
    expect(alice!.items.map((i) => i.kind)).toEqual(["draft", "draft"]);
    const bobs = await planOf(A, bob);
    expect(bobs!.items.map((i) => [i.kind, i.body])).toEqual([
      ["draft", findingCommentBody(findingBy("F5"))],
      ["comment", "bob's comment"],
    ]);
    // Bob and alice cannot see each other's items (the hash differs, so a swap would be stale).
    expect(alice!.contentSha256.equals(bobs!.contentSha256)).toBe(false);
  });

  it("offers nothing when the head has no mirrored revision, the analysis is not done, or the document does not parse", async () => {
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update pull_requests set head_sha = repeat('e', 40) where id = $1", [
        A.pullRequestId,
      ]),
    );
    const moved = await planOf(A, A.memberId);
    expect(moved).toMatchObject({ revisionId: null, items: [], headSha: "e".repeat(40) });
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update pull_requests set head_sha = $2 where id = $1", [A.pullRequestId, HEAD]),
    );
    await db.withOrg(A.orgId, (tx) =>
      tx.query(
        `update analyses set document = '{"version":"test","findings":[]}'::jsonb where id = $1`,
        [A.analysisId],
      ),
    );
    expect((await planOf(A, A.memberId))!.items).toEqual([]);
  });

  it("is null for another org's pull request, empty for someone who is not a member here, and refuses malformed ids", async () => {
    // A member id of another org names nobody in A: nothing to post (membership is re-checked
    // when an attempt begins).
    expect((await planOf(A, B.memberId))!.items).toEqual([]);
    expect(
      await db.withOrg(B.orgId, (tx) =>
        loadReviewPlan(tx, { pullRequestId: A.pullRequestId, memberId: B.memberId }),
      ),
    ).toBeNull();
    expect(
      await db.withOrg(A.orgId, (tx) =>
        loadReviewPlan(tx, { pullRequestId: UNKNOWN, memberId: A.memberId }),
      ),
    ).toBeNull();
    await expect(
      db.withOrg(A.orgId, (tx) =>
        loadReviewPlan(tx, { pullRequestId: "x' or 1=1 --", memberId: A.memberId }),
      ),
    ).rejects.toBeInstanceOf(ReviewStoreError);
  });
});

describe("beginReviewSubmission", () => {
  it("records the attempt as posting with its items, the digests and counts, and the exact review to post", async () => {
    const mine = await comment(A, A.memberId, "Validate the email first.");
    const plan = (await planOf(A, A.memberId))!;
    const result = await begin(A, inputFor(A, A.memberId, plan));
    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") return;
    expect(result.review).toEqual({
      headSha: HEAD,
      verdict: "comment",
      body: "Looks fine overall.",
      comments: plan.items.map((i) => ({
        path: i.path,
        line: i.line,
        startLine: i.startLine,
        body: i.body,
      })),
    });
    expect(result.submission).toMatchObject({
      pullRequestId: A.pullRequestId,
      revisionId: A.revisionId,
      submittedBy: A.memberId,
      headSha: HEAD,
      verdict: "comment",
      draftCount: 2,
      commentCount: 1,
      status: "posting",
      forgeReviewId: null,
      errorCode: null,
      finishedAt: null,
    });
    expect(result.submission.contentSha256).toEqual(plan.contentSha256);
    expect(result.submission.bodySha256).toEqual(sha256("Looks fine overall."));
    const items = await superuser.query(
      `select seq, kind, item_id, encode(body_sha256, 'hex') as body from review_submission_items
        where submission_id = $1 order by seq`,
      [result.submission.submissionId],
    );
    expect(items.rows).toEqual([
      {
        seq: 0,
        kind: "draft",
        item_id: plan.items[0]!.id,
        body: sha256(plan.items[0]!.body).toString("hex"),
      },
      {
        seq: 1,
        kind: "draft",
        item_id: plan.items[1]!.id,
        body: sha256(plan.items[1]!.body).toString("hex"),
      },
      {
        seq: 2,
        kind: "comment",
        item_id: mine,
        body: sha256("Validate the email first.").toString("hex"),
      },
    ]);
    const audit = await superuser.query(
      "select actor_id, action, target_id, metadata from audit_events where org_id = $1 and action = 'review.submission_started'",
      [A.orgId],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: A.memberId,
        action: "review.submission_started",
        target_id: A.pullRequestId,
        metadata: {
          submissionId: result.submission.submissionId,
          verdict: "comment",
          draftCount: 2,
          commentCount: 1,
          contentSha256: plan.contentSha256.toString("hex"),
        },
      },
    ]);
    // No body text anywhere in the new tables.
    const dump = await superuser.query(
      "select row_to_json(s)::text as s from review_submissions s where org_id = $1",
      [A.orgId],
    );
    expect(dump.rows.map((r) => r.s).join()).not.toMatch(/Looks fine|Validate the email/);
    // The items are now taken: the next plan is empty and the stored items are what was shown.
    expect((await planOf(A, A.memberId))!.items).toEqual([]);
  });

  it("refuses a list that changed since it was shown (stale) and a head that moved, writing nothing", async () => {
    const plan = (await planOf(A, A.memberId))!;
    await comment(A, A.memberId, "Added after the preview.");
    expect(await begin(A, inputFor(A, A.memberId, plan))).toEqual({ outcome: "stale" });
    const fresh = (await planOf(A, A.memberId))!;
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update comments_pending set body = 'edited' where pull_request_id = $1", [
        A.pullRequestId,
      ]),
    );
    expect(await begin(A, inputFor(A, A.memberId, fresh))).toEqual({ outcome: "stale" });
    const edited = (await planOf(A, A.memberId))!;
    await db.withOrg(A.orgId, (tx) =>
      tx.query(
        "update findings_state set state = 'dismissed', reason = 'no' where finding_id = 'F1'",
      ),
    );
    expect(await begin(A, inputFor(A, A.memberId, edited))).toEqual({ outcome: "stale" });
    const again = (await planOf(A, A.memberId))!;
    expect(await begin(A, inputFor(A, A.memberId, again, { headSha: "f".repeat(40) }))).toEqual({
      outcome: "head_moved",
    });
    expect(
      (await superuser.query("select 1 from review_submissions where org_id = $1", [A.orgId]))
        .rowCount,
    ).toBe(0);
  });

  it("answers the same key with the earlier attempt and refuses the key for other content", async () => {
    const plan = (await planOf(A, A.memberId))!;
    const input = inputFor(A, A.memberId, plan);
    const first = await begin(A, input);
    expect(first.outcome).toBe("started");
    const replay = await begin(A, input);
    expect(replay).toEqual({
      outcome: "existing",
      submission: (first as { submission: unknown }).submission,
    });
    expect(await begin(A, { ...input, body: "other" })).toEqual({ outcome: "key_reused" });
    expect(await begin(A, { ...input, verdict: "approve" })).toEqual({ outcome: "key_reused" });
    expect(await begin(A, { ...input, contentSha256: "0".repeat(64) })).toEqual({
      outcome: "key_reused",
    });
    // Another member of the org reusing the key gets the same refusal, never the row.
    expect(await begin(A, { ...input, memberId: bob })).toEqual({ outcome: "key_reused" });
  });

  it("refuses a second attempt while one is in flight, and releases the items when it fails", async () => {
    const plan = (await planOf(A, A.memberId))!;
    const first = await begin(A, inputFor(A, A.memberId, plan));
    expect(first.outcome).toBe("started");
    if (first.outcome !== "started") return;
    // A fresh plan is empty (the items are in flight), so a new key on the old plan is stale,
    // and on the empty plan it is in_progress.
    expect(await begin(A, inputFor(A, A.memberId, plan))).toEqual({ outcome: "stale" });
    const empty = (await planOf(A, A.memberId))!;
    expect(empty.items).toEqual([]);
    expect(await begin(A, inputFor(A, A.memberId, empty, { verdict: "approve" }))).toEqual({
      outcome: "in_progress",
      submission: first.submission,
    });
    const failed = await db.withOrg(A.orgId, (tx) =>
      finishReviewSubmission(
        tx,
        first.submission.submissionId,
        { posted: false, errorCode: "rejected" },
        { type: "user", id: A.memberId },
      ),
    );
    expect(failed).toMatchObject({ status: "failed", errorCode: "rejected" });
    expect(failed!.finishedAt).toBeInstanceOf(Date);
    // Released: the same items are offered again, and a new attempt starts.
    const released = (await planOf(A, A.memberId))!;
    expect(released.items.map((i) => i.id)).toEqual(plan.items.map((i) => i.id));
    expect((await begin(A, inputFor(A, A.memberId, released))).outcome).toBe("started");
  });

  it("the database itself refuses two attempts in flight for one member and pull request", async () => {
    const plan = (await planOf(A, A.memberId))!;
    const first = await begin(A, inputFor(A, A.memberId, plan));
    expect(first.outcome).toBe("started");
    await expect(
      superuser.query(
        `insert into review_submissions
           (org_id, pull_request_id, revision_id, submitted_by, idempotency_key, head_sha, verdict,
            content_sha256, body_sha256, draft_count, comment_count)
         values ($1, $2, $3, $4, gen_random_uuid(), $5, 'comment', $6, $6, 0, 0)`,
        [A.orgId, A.pullRequestId, A.revisionId, A.memberId, HEAD, Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // And it refuses a row without a person, a finished row without its answer, a bad verdict.
    for (const [sql, code] of [
      [
        `insert into review_submissions (org_id, pull_request_id, revision_id, submitted_by, idempotency_key, head_sha, verdict, content_sha256, body_sha256, draft_count, comment_count)
         values ($1, $2, $3, nullif($4::uuid, $4::uuid), gen_random_uuid(), $5, 'comment', $6, $6, 0, 0)`,
        "23502",
      ],
      [
        `insert into review_submissions (org_id, pull_request_id, revision_id, submitted_by, idempotency_key, head_sha, verdict, content_sha256, body_sha256, draft_count, comment_count, status)
         values ($1, $2, $3, $4, gen_random_uuid(), $5, 'comment', $6, $6, 0, 0, 'posted')`,
        "23514",
      ],
      [
        `insert into review_submissions (org_id, pull_request_id, revision_id, submitted_by, idempotency_key, head_sha, verdict, content_sha256, body_sha256, draft_count, comment_count)
         values ($1, $2, $3, $4, gen_random_uuid(), $5, 'APPROVE', $6, $6, 0, 0)`,
        "23514",
      ],
    ] as const) {
      await expect(
        superuser.query(sql, [A.orgId, A.pullRequestId, A.revisionId, bob, HEAD, Buffer.alloc(32)]),
      ).rejects.toMatchObject({ code });
    }
  });

  it("serialises concurrent attempts: exactly one starts, the other is stale or in progress", async () => {
    const plan = (await planOf(A, A.memberId))!;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => begin(A, inputFor(A, A.memberId, plan))),
    );
    const outcomes = results.map((r) => r.outcome).toSorted();
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "stale")).toHaveLength(3);
    const rows = await superuser.query("select 1 from review_submissions where org_id = $1", [
      A.orgId,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("re-checks the actor: a removed member, a member of another org, or a bad input cannot start", async () => {
    const plan = (await planOf(A, bob))!;
    await db.withOrg(A.orgId, (tx) => markMemberRemoved(tx, bob));
    expect(await begin(A, inputFor(A, bob, plan, { verdict: "approve" }))).toEqual({
      outcome: "not_permitted",
    });
    expect(await begin(A, inputFor(A, B.memberId, plan, { verdict: "approve" }))).toEqual({
      outcome: "not_permitted",
    });
    expect(await begin(B, inputFor(A, B.memberId, plan, { verdict: "approve" }))).toEqual({
      outcome: "not_found",
    });
    expect(
      await begin(A, inputFor(A, A.memberId, plan, { verdict: "comment", body: "   " })),
    ).toEqual({ outcome: "stale" });
    const own = (await planOf(A, A.memberId))!;
    expect(
      await begin(A, {
        ...inputFor(A, A.memberId, own, { verdict: "comment", body: "   " }),
      }),
    ).toEqual({
      outcome: "started",
      submission: expect.anything(),
      plan: expect.anything(),
      review: expect.anything(),
    });
    const emptyOrg = await prepare(A, A.memberId, []);
    expect(emptyOrg).toEqual({});
    const nothing = (await planOf(A, A.memberId))!;
    expect(await begin(A, inputFor(A, A.memberId, nothing, { body: "" }))).toEqual({
      outcome: "invalid",
      reason: "empty_review",
    });
    expect(await begin(A, inputFor(A, A.memberId, nothing, { verdict: "x" as never }))).toEqual({
      outcome: "invalid",
      reason: "invalid_verdict",
    });
    await expect(
      begin(A, inputFor(A, A.memberId, nothing, { contentSha256: "zz" })),
    ).rejects.toBeInstanceOf(ReviewStoreError);
    await expect(
      begin(A, inputFor(A, A.memberId, nothing, { idempotencyKey: "1" })),
    ).rejects.toBeInstanceOf(ReviewStoreError);
  });

  it("no revision for the head: refused before anything is written", async () => {
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update pull_requests set head_sha = repeat('e', 40) where id = $1", [
        A.pullRequestId,
      ]),
    );
    const plan = (await planOf(A, A.memberId))!;
    expect(await begin(A, inputFor(A, A.memberId, plan, { verdict: "approve" }))).toEqual({
      outcome: "no_revision",
    });
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update pull_requests set head_sha = $2 where id = $1", [A.pullRequestId, HEAD]),
    );
  });
});

describe("finishReviewSubmission", () => {
  it("records a posted review once, audits it, and ignores a second finish", async () => {
    const plan = (await planOf(A, A.memberId))!;
    const started = await begin(A, inputFor(A, A.memberId, plan));
    if (started.outcome !== "started") throw new Error(started.outcome);
    const id = started.submission.submissionId;
    const posted = await db.withOrg(A.orgId, (tx) =>
      finishReviewSubmission(
        tx,
        id,
        { posted: true, forgeReviewId: 880011 },
        { type: "user", id: A.memberId },
      ),
    );
    expect(posted).toMatchObject({ status: "posted", forgeReviewId: 880011, errorCode: null });
    expect(
      await db.withOrg(A.orgId, (tx) =>
        finishReviewSubmission(
          tx,
          id,
          { posted: false, errorCode: "late" },
          { type: "system", id: "reconcile" },
        ),
      ),
    ).toBeNull();
    expect(await db.withOrg(A.orgId, (tx) => loadReviewSubmission(tx, id))).toMatchObject({
      status: "posted",
      forgeReviewId: 880011,
    });
    expect(await db.withOrg(A.orgId, (tx) => recordedReviewIds(tx, A.pullRequestId))).toEqual([
      880011,
    ]);
    // Posted items stay off the plan for good.
    expect((await planOf(A, A.memberId))!.items).toEqual([]);
    const audit = await superuser.query(
      `select action, actor_type, metadata from audit_events
        where org_id = $1 and action like 'review.%' and metadata ->> 'submissionId' = $2 order by id`,
      [A.orgId, id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["review.submission_started", "review.posted"]);
    expect(audit.rows[1]?.metadata).toEqual({
      submissionId: id,
      submittedBy: A.memberId,
      verdict: "comment",
      draftCount: 2,
      commentCount: 0,
      forgeReviewId: 880011,
    });
    // Not visible from another org, and not finishable from there.
    expect(await db.withOrg(B.orgId, (tx) => loadReviewSubmission(tx, id))).toBeNull();
    expect(
      await db.withOrg(B.orgId, (tx) =>
        finishReviewSubmission(
          tx,
          id,
          { posted: false, errorCode: "x" },
          { type: "user", id: B.memberId },
        ),
      ),
    ).toBeNull();
  });

  it("validates its inputs", async () => {
    for (const result of [
      { posted: true, forgeReviewId: 0 },
      { posted: true, forgeReviewId: 1.5 },
      { posted: false, errorCode: "Not A Code" },
      { posted: false, errorCode: "" },
    ] as const) {
      await expect(
        db.withOrg(A.orgId, (tx) =>
          finishReviewSubmission(tx, A.reviewSubmissionId, result, {
            type: "user",
            id: A.memberId,
          }),
        ),
      ).rejects.toBeInstanceOf(ReviewStoreError);
    }
  });
});
