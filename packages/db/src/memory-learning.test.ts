import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAX_ANALYSIS_MEMORY, type DraftAction } from "@rocky-reviews/core";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { decideDraft } from "./drafts.js";
import {
  createMemoryEntry,
  listMemoryEntries,
  setMemoryEntryDisabled,
  setRepoMemoryEnabled,
  supersedeMemoryEntry,
} from "./memory.js";
import {
  ANALYSIS_MEMORY_BOUNDS,
  learnFromReviewSubmission,
  loadAnalysisMemory,
  MemoryLearningError,
} from "./memory-learning.js";
import { beginReviewSubmission, finishReviewSubmission, loadReviewPlan } from "./reviews.js";
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
 * P8-2 (ADR 0037): learning from a posted review on a real Postgres as the
 * application role. Dismissals (intentional, not an issue, handled elsewhere) become dismissal
 * entries with the reason; accepted and edited drafts become conventions; not-worth-it and
 * dismissed critical findings teach nothing; a second post teaches nothing new; a later decision
 * about the same pattern supersedes the older entry; an unposted review, a removed reviewer and
 * another org's submission teach nothing.
 */

const DOCUMENT = JSON.parse(
  readFileSync(new URL("../../schema/fixtures/pr-847.json", import.meta.url), "utf8"),
) as AnalysisDocument;
const HEAD = "a".repeat(40);
const DOC_HEAD = DOCUMENT.provenance.head.sha;

let pgs: TestPostgres;
let db: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 4 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: 91 }),
    await seedOrg(w, newOrgId(), { installationId: 92 }),
  ]);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

/** A clean slate: the real pr-847 document on the seeded analysis, no decisions, no memory. */
const reset = async (org: SeededOrg, document: AnalysisDocument = DOCUMENT) => {
  // The application cannot delete attempts (N6): the superuser clears them between tests.
  await superuser.query("delete from review_submissions where org_id = $1", [org.orgId]);
  await superuser.query("delete from memory_entries where org_id = $1", [org.orgId]);
  await db.withOrg(org.orgId, async (tx) => {
    await tx.query("update analyses set document = $2::jsonb where id = $1", [
      org.analysisId,
      JSON.stringify(document),
    ]);
    await tx.query(
      "update pull_requests set head_sha = $2, author_login = 'carol', number = 847 where id = $1",
      [org.pullRequestId, HEAD],
    );
    await tx.query("update pr_revisions set head_sha = $2 where id = $1", [org.revisionId, HEAD]);
    await tx.query("delete from analyses where revision_id = $1 and id <> $2", [
      org.revisionId,
      org.analysisId,
    ]);
    await tx.query("delete from findings_state where analysis_id = $1", [org.analysisId]);
    await tx.query("delete from comments_pending where pull_request_id = $1", [org.pullRequestId]);
    await tx.query("update members set removed_at = null, role = 'admin' where id = $1", [
      org.memberId,
    ]);
    await tx.query("update repos set memory_enabled = true where id = $1", [org.repoId]);
  });
};

const decide = (
  org: SeededOrg,
  findingId: string,
  action: DraftAction,
  analysisId = org.analysisId,
) =>
  db.withOrg(org.orgId, async (tx) => {
    const result = await decideDraft(tx, { analysisId, memberId: org.memberId, findingId, action });
    if (result.outcome !== "ok") throw new Error(`decideDraft: ${result.outcome}`);
  });

/** Finish review as the page does it: the plan, the attempt, the forge's answer. */
const post = async (org: SeededOrg, answer: "posted" | "none" = "posted"): Promise<string> =>
  db.withOrg(org.orgId, async (tx) => {
    const plan = await loadReviewPlan(tx, {
      pullRequestId: org.pullRequestId,
      memberId: org.memberId,
    });
    if (plan === null) throw new Error("no plan");
    const begun = await beginReviewSubmission(tx, {
      memberId: org.memberId,
      pullRequestId: org.pullRequestId,
      idempotencyKey: randomUUID(),
      contentSha256: plan.contentSha256.toString("hex"),
      headSha: plan.headSha,
      verdict: "comment",
      body: "Reviewed.",
    });
    if (begun.outcome !== "started") throw new Error(`begin: ${begun.outcome}`);
    const id = begun.submission.submissionId;
    if (answer === "posted") {
      await finishReviewSubmission(
        tx,
        id,
        { posted: true, forgeReviewId: Math.floor(Math.random() * 1e9) + 1 },
        { type: "user", id: org.memberId },
      );
    }
    return id;
  });

const learn = (org: SeededOrg, submissionId: string) =>
  db.withOrg(org.orgId, (tx) => learnFromReviewSubmission(tx, submissionId));

const entriesOf = (org: SeededOrg, includeSuperseded = false) =>
  db.withOrg(org.orgId, (tx) => listMemoryEntries(tx, { repoId: org.repoId, includeSuperseded }));

beforeEach(async () => {
  await reset(A);
  await reset(B);
});

describe("learnFromReviewSubmission (P8-2)", () => {
  it("learns dismissals with their reason and accepted or edited drafts as conventions, from a posted review", async () => {
    await decide(A, "F3", { kind: "accept" });
    await decide(A, "F6", { kind: "edit", body: "Please drop the email from this log line." });
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await decide(A, "F7", { kind: "dismiss", reason: "not_worth_it" });
    await decide(A, "F1", { kind: "dismiss", reason: "intentional" }); // critical
    await decide(A, "F5", { kind: "dismiss", reason: "handled_elsewhere" });
    const submission = await post(A);

    expect(await learn(A, submission)).toEqual({
      outcome: "learned",
      created: 4,
      superseded: 0,
      repeated: 0,
      skipped: 2,
    });
    const entries = await entriesOf(A);
    const byText = Object.fromEntries(entries.map((e) => [e.text, e]));
    expect(Object.keys(byText).sort()).toEqual([
      "Accepted in review: Invitations can be reused after they're accepted",
      "Accepted in review: Logs the invitee's email address",
      "Dismissed as handled elsewhere: Deleting an org won't remove its invitations",
      "Dismissed as intentional: No permission check: any logged-in user can invite to any org",
    ]);
    const dismissal =
      byText[
        "Dismissed as intentional: No permission check: any logged-in user can invite to any org"
      ]!;
    expect(dismissal).toMatchObject({
      kind: "dismissal",
      origin: "learned",
      reason: "intentional",
      confidence: 80,
      evidence: {
        path: "src/api/routes/invitations.ts",
        sha: DOC_HEAD,
        range: { start: 13, end: 13 },
        pullRequestNumber: 847,
      },
      author: { kind: "member", memberId: A.memberId, login: "alice" },
      supersededBy: null,
    });
    expect(byText["Accepted in review: Logs the invitee's email address"]).toMatchObject({
      kind: "convention",
      reason: null,
      confidence: 65,
    });
    expect(
      byText["Accepted in review: Invitations can be reused after they're accepted"]?.confidence,
    ).toBe(60);
  });

  it("teaches nothing from a review that was not posted", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    const submission = await post(A, "none");
    expect(await learn(A, submission)).toEqual({ outcome: "not_posted" });
    expect(await entriesOf(A)).toEqual([]);
  });

  it("a second post of the same revision teaches nothing new", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    const first = await post(A);
    await learn(A, first);
    const second = await post(A);
    expect(await learn(A, second)).toMatchObject({ created: 0, repeated: 1 });
    expect(await learn(A, first)).toMatchObject({ created: 0, repeated: 1 });
    expect(await entriesOf(A, true)).toHaveLength(1);
  });

  it("the same pattern dismissed again on another commit of the same PR supersedes the older entry, without corroborating it", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await learn(A, await post(A));
    const [older] = await entriesOf(A);

    // A later push: the same finding, read at another commit.
    await db.withOrg(A.orgId, (tx) =>
      tx.query("delete from findings_state where analysis_id = $1", [A.analysisId]),
    );
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update analyses set document = $2::jsonb where id = $1", [
        A.analysisId,
        JSON.stringify({
          ...DOCUMENT,
          provenance: {
            ...DOCUMENT.provenance,
            head: { ...DOCUMENT.provenance.head, sha: "d".repeat(40) },
          },
        }),
      ]),
    );
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    expect(await learn(A, await post(A))).toMatchObject({ created: 1, superseded: 1 });
    const current = await entriesOf(A);
    expect(current).toHaveLength(1);
    // One pull request never corroborates itself (fix round, N2).
    expect(current[0]).toMatchObject({ confidence: 80, evidence: { sha: "d".repeat(40) } });
    const all = await entriesOf(A, true);
    expect(all.find((e) => e.id === older!.id)?.supersededBy).toBe(current[0]!.id);
  });

  it("the same pattern dismissed on another pull request is corroborated: higher confidence", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await learn(A, await post(A));
    await db.withOrg(A.orgId, async (tx) => {
      await tx.query("delete from findings_state where analysis_id = $1", [A.analysisId]);
      await tx.query("update pull_requests set number = 848 where id = $1", [A.pullRequestId]);
    });
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    expect(await learn(A, await post(A))).toMatchObject({ created: 1, superseded: 1 });
    const current = await entriesOf(A);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ confidence: 90, evidence: { pullRequestNumber: 848 } });
  });

  it("records the dismissed finding's severity and the reviewer's role; accepts carry no severity", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" }); // high
    await decide(A, "F6", { kind: "accept" });
    await learn(A, await post(A));
    const { rows } = await superuser.query<{
      kind: string;
      severity: string | null;
      learner_role: string;
    }>("select kind, severity, learner_role from memory_entries where org_id = $1 order by kind", [
      A.orgId,
    ]);
    expect(rows).toEqual([
      { kind: "convention", severity: null, learner_role: "admin" },
      { kind: "dismissal", severity: "high", learner_role: "admin" },
    ]);
  });

  it("a reviewer who wrote the pull request teaches no dismissal from it, only conventions", async () => {
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update pull_requests set author_login = 'ALICE' where id = $1", [A.pullRequestId]),
    );
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await decide(A, "F5", { kind: "dismiss", reason: "handled_elsewhere" });
    await decide(A, "F6", { kind: "accept" });
    expect(await learn(A, await post(A))).toMatchObject({ created: 1, skipped: 2 });
    expect((await entriesOf(A)).map((e) => e.kind)).toEqual(["convention"]);
  });

  /** A second analysis of the same head, so the same finding can be decided again. */
  const rerunOf = (org: SeededOrg) =>
    db.withOrg(org.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into analyses (revision_id, status, document, completed_at)
         values ($1, 'done', $2::jsonb, now() + interval '1 hour') returning id`,
        [org.revisionId, JSON.stringify(DOCUMENT)],
      );
      return rows[0]!.id;
    });

  it("a lower role's opposite decision about a higher role's pattern is not learned", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await learn(A, await post(A));
    await superuser.query("update memory_entries set learner_role = 'owner' where org_id = $1", [
      A.orgId,
    ]);
    await decide(A, "F2", { kind: "accept" }, await rerunOf(A));
    expect(await learn(A, await post(A))).toMatchObject({ created: 0, superseded: 0, skipped: 1 });
    expect((await entriesOf(A)).map((e) => e.kind)).toEqual(["dismissal"]);
  });

  it("an owner's accept is not switched off by a member's later dismissal", async () => {
    await decide(A, "F2", { kind: "accept" });
    await learn(A, await post(A));
    await superuser.query("update memory_entries set learner_role = 'owner' where org_id = $1", [
      A.orgId,
    ]);
    await superuser.query("update members set role = 'member' where id = $1", [A.memberId]);
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" }, await rerunOf(A));
    expect(await learn(A, await post(A))).toMatchObject({ created: 0, skipped: 1 });
    const current = await entriesOf(A);
    expect(current.map((e) => e.kind)).toEqual(["convention"]);
    expect(current.some((e) => e.kind === "dismissal")).toBe(false);
  });

  it("the same or a higher role's opposite decision still supersedes", async () => {
    await decide(A, "F2", { kind: "accept" });
    await learn(A, await post(A));
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" }, await rerunOf(A));
    expect(await learn(A, await post(A))).toMatchObject({ created: 1, superseded: 1 });
    expect((await entriesOf(A)).map((e) => e.kind)).toEqual(["dismissal"]);
  });

  it("two learners of the same review at once store each entry once (the repository lock)", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await decide(A, "F6", { kind: "accept" });
    const submission = await post(A);
    const results = await Promise.all([learn(A, submission), learn(A, submission)]);
    const created = results.reduce((n, r) => n + (r.outcome === "learned" ? r.created : 0), 0);
    const repeated = results.reduce((n, r) => n + (r.outcome === "learned" ? r.repeated : 0), 0);
    expect({ created, repeated }).toEqual({ created: 2, repeated: 2 });
    expect(await entriesOf(A, true)).toHaveLength(2);
  });

  it("a later accept of a dismissed pattern supersedes the dismissal: the newest decision wins", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await learn(A, await post(A));
    // A re-run of the same head: the reviewer accepts the same finding this time.
    const rerun = await db.withOrg(A.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into analyses (revision_id, status, document, completed_at)
         values ($1, 'done', $2::jsonb, now() + interval '1 hour') returning id`,
        [A.revisionId, JSON.stringify(DOCUMENT)],
      );
      return rows[0]!.id;
    });
    await decide(A, "F2", { kind: "accept" }, rerun);
    expect(await learn(A, await post(A))).toMatchObject({ created: 1, superseded: 1 });
    const current = await entriesOf(A);
    expect(current.map((e) => [e.kind, e.text])).toEqual([
      [
        "convention",
        "Accepted in review: No permission check: any logged-in user can invite to any org",
      ],
    ]);
  });

  it("member-written entries are never superseded by learning", async () => {
    await superuser.query(
      `insert into memory_entries (org_id, repo_id, kind, origin, content, evidence_path,
         evidence_sha, evidence_start, evidence_end, source_pr_number, confidence, created_by)
       values ($1, $2, 'convention', 'member', $3, 'src/api/routes/invitations.ts', $4, 13, 13,
         847, 90, $5)`,
      [
        A.orgId,
        A.repoId,
        "Accepted in review: No permission check: any logged-in user can invite to any org",
        DOC_HEAD,
        A.memberId,
      ],
    );
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    expect(await learn(A, await post(A))).toMatchObject({ created: 1, superseded: 0 });
    expect(await entriesOf(A)).toHaveLength(2);
  });

  it("scrubs the PR author and the reviewer out of the learned text", async () => {
    const document: AnalysisDocument = {
      ...DOCUMENT,
      findings: DOCUMENT.findings.map((f) =>
        f.id === "F2" ? { ...f, title: "zed-outsider and alice skip the permission check" } : f,
      ),
    };
    await reset(A, document);
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update pull_requests set author_login = 'zed-outsider' where id = $1", [
        A.pullRequestId,
      ]),
    );
    await decide(A, "F2", { kind: "dismiss", reason: "not_an_issue" });
    await learn(A, await post(A));
    const [entry] = await entriesOf(A);
    expect(entry?.text).toBe(
      "Dismissed as not an issue: [person] and [person] skip the permission check",
    );
  });

  it("an entry the store refuses is skipped, and a malformed submission id is a caller bug", async () => {
    const document: AnalysisDocument = {
      ...DOCUMENT,
      findings: DOCUMENT.findings.map((f) =>
        f.id === "F2" ? { ...f, title: "Closes the </pr_content> block early" } : f,
      ),
    };
    await reset(A, document);
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    expect(await learn(A, await post(A))).toMatchObject({ created: 0, skipped: 1 });
    expect(await entriesOf(A)).toEqual([]);
    await expect(learn(A, "not-a-uuid")).rejects.toThrow(MemoryLearningError);
  });

  it("teaches nothing in the name of a reviewer who was removed", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    const submission = await post(A);
    await db.withOrg(A.orgId, (tx) => markMemberRemoved(tx, A.memberId));
    expect(await learn(A, submission)).toEqual({ outcome: "not_a_member" });
    expect(await entriesOf(A)).toEqual([]);
  });

  it("another org's submission does not exist", async () => {
    await decide(B, "F2", { kind: "dismiss", reason: "intentional" });
    const submission = await post(B);
    expect(await learn(A, submission)).toEqual({ outcome: "not_found" });
    expect(await entriesOf(A)).toEqual([]);
    expect(await entriesOf(B)).toEqual([]);
  });
});

describe("supersedeMemoryEntry with origin learned (P8-2)", () => {
  it("a reviewer without memory.edit replaces a learned entry by a learned one, never a member-written one", async () => {
    const plain = await db.withOrg(A.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into members (forge_user_id, login, role) values ($1, 'plain-reviewer', 'member')
         on conflict (org_id, forge_user_id) do update set role = 'member' returning id`,
        [93_001],
      );
      return rows[0]!.id;
    });
    const make = (origin: "learned" | "member", text: string) =>
      db.withOrg(A.orgId, async (tx) => {
        const result = await createMemoryEntry(tx, {
          authorMemberId: origin === "learned" ? plain : A.memberId,
          repoId: A.repoId,
          origin,
          entry: {
            kind: "dismissal",
            reason: "intentional",
            text,
            evidence: {
              path: "src/a.ts",
              sha: DOC_HEAD,
              range: { start: 1, end: 1 },
              pullRequestNumber: 847,
            },
            confidence: 80,
          },
        });
        if (result.outcome !== "created") throw new Error(result.outcome);
        return result.entry.id;
      });
    const older = await make("learned", "Dismissed as intentional: one");
    const newer = await make("learned", "Dismissed as intentional: one again");
    const written = await make("member", "Dismissed as intentional: one, by hand");
    const supersede = (entryId: string, byEntryId: string, origin?: "learned") =>
      db.withOrg(A.orgId, (tx) =>
        supersedeMemoryEntry(tx, {
          actorMemberId: plain,
          entryId,
          byEntryId,
          ...(origin === undefined ? {} : { origin }),
        }),
      );
    expect(await supersede(older, newer)).toBe("not_permitted");
    expect(await supersede(written, newer, "learned")).toBe("not_permitted");
    expect(await supersede(newer, written, "learned")).toBe("not_permitted");
    expect(await supersede(older, newer, "learned")).toBe("superseded");
  });
});

describe("loadAnalysisMemory (P8-2)", () => {
  it("gives the analysis its repository's current entries, newest first, with their source labels", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await learn(A, await post(A));
    await decide(B, "F5", { kind: "dismiss", reason: "handled_elsewhere" });
    await learn(B, await post(B));
    const memory = await db.withOrg(A.orgId, (tx) => loadAnalysisMemory(tx, A.repoId));
    expect(memory).toEqual([
      {
        id: expect.any(String),
        kind: "dismissal",
        origin: "learned",
        reason: "intentional",
        severity: "high",
        text: "Dismissed as intentional: No permission check: any logged-in user can invite to any org",
        path: "src/api/routes/invitations.ts",
        source: "dismissal · PR #847",
        confidence: 80,
      },
    ]);
    // Org A cannot read org B's repository's memory, even by its id.
    expect(await db.withOrg(A.orgId, (tx) => loadAnalysisMemory(tx, B.repoId))).toEqual([]);
  });
});

describe("loadAnalysisMemory bounds (fix round, M2/S5)", () => {
  it("member-written entries, learned dismissals and other learned entries are bounded apart", async () => {
    const insert = (count: number, kind: string, origin: string, offset: number) =>
      superuser.query(
        `insert into memory_entries (org_id, repo_id, kind, origin, content, evidence_path,
           evidence_sha, evidence_start, evidence_end, source_pr_number, confidence, reason,
           created_at)
         select $1, $2, $3, $4, $3 || ' ' || g, 'src/a.ts', $5, 1, 1, 847, 70,
                case when $3 = 'dismissal' then 'intentional' end,
                now() - make_interval(secs => g + $7)
           from generate_series(1, $6) g`,
        [A.orgId, A.repoId, kind, origin, DOC_HEAD, count, offset],
      );
    // Oldest first: the dismissals, then members' entries, then a burst of newer conventions.
    await insert(130, "dismissal", "learned", 2000);
    await insert(120, "decision", "member", 1000);
    await insert(300, "convention", "learned", 0);
    const memory = await db.withOrg(A.orgId, (tx) => loadAnalysisMemory(tx, A.repoId));
    const count = (kind: string, origin: string) =>
      memory.filter((e) => e.kind === kind && e.origin === origin).length;
    expect(count("convention", "learned")).toBe(ANALYSIS_MEMORY_BOUNDS.learnedOther);
    expect(count("dismissal", "learned")).toBe(ANALYSIS_MEMORY_BOUNDS.learnedDismissals);
    expect(count("decision", "member")).toBe(ANALYSIS_MEMORY_BOUNDS.member);
    expect(memory).toHaveLength(MAX_ANALYSIS_MEMORY);
  });
});

describe("switching memory off (P8-3, ADR 0039)", () => {
  const switchEntry = (entryId: string, disabled: boolean) =>
    db.withOrg(A.orgId, (tx) =>
      setMemoryEntryDisabled(tx, { actorMemberId: A.memberId, entryId, disabled }),
    );
  const switchRepo = (enabled: boolean) =>
    db.withOrg(A.orgId, (tx) =>
      setRepoMemoryEnabled(tx, { actorMemberId: A.memberId, repoId: A.repoId, enabled }),
    );
  const analysisMemory = () => db.withOrg(A.orgId, (tx) => loadAnalysisMemory(tx, A.repoId));

  it("a switched-off entry is never offered to a review; switched on, it is again", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await decide(A, "F3", { kind: "accept" });
    await learn(A, await post(A));
    const [first] = await entriesOf(A);
    expect(await analysisMemory()).toHaveLength(2);
    expect(await switchEntry(first!.id, true)).toMatchObject({ outcome: "switched" });
    const offered = await analysisMemory();
    expect(offered).toHaveLength(1);
    expect(offered.map((e) => e.id)).not.toContain(first!.id);
    await switchEntry(first!.id, false);
    expect(await analysisMemory()).toHaveLength(2);
  });

  it("memory switched off for the repository offers nothing and learns nothing; the entries stay", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await learn(A, await post(A));
    expect(await switchRepo(false)).toBe("switched");
    expect(await analysisMemory()).toEqual([]);
    await decide(A, "F3", { kind: "accept" });
    expect(await learn(A, await post(A))).toEqual({ outcome: "memory_disabled" });
    expect(await entriesOf(A)).toHaveLength(1);
    expect(await switchRepo(true)).toBe("switched");
    expect(await analysisMemory()).toHaveLength(1);
  });

  it("a pattern an admin switched off is not learned again beside it; the opposite decision still is", async () => {
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    await learn(A, await post(A));
    const [dismissal] = await entriesOf(A);
    await switchEntry(dismissal!.id, true);

    // The same dismissal on another pull request: nothing new, the switched-off entry stays.
    await db.withOrg(A.orgId, async (tx) => {
      await tx.query("delete from findings_state where analysis_id = $1", [A.analysisId]);
      await tx.query("update pull_requests set number = 848 where id = $1", [A.pullRequestId]);
    });
    await decide(A, "F2", { kind: "dismiss", reason: "intentional" });
    expect(await learn(A, await post(A))).toMatchObject({ created: 0, skipped: 1 });
    expect((await entriesOf(A)).map((e) => [e.id, e.disabledAt !== null])).toEqual([
      [dismissal!.id, true],
    ]);
    expect(await analysisMemory()).toEqual([]);

    // An accept of the same finding is the opposite decision: learned, and it replaces the
    // switched-off dismissal (the newest decision wins).
    await db.withOrg(A.orgId, (tx) =>
      tx.query("delete from findings_state where analysis_id = $1", [A.analysisId]),
    );
    await decide(A, "F2", { kind: "accept" });
    expect(await learn(A, await post(A))).toMatchObject({ created: 1, superseded: 1 });
    expect((await entriesOf(A)).map((e) => e.kind)).toEqual(["convention"]);
  });
});
