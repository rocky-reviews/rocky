import {
  corroboratedConfidence,
  isDismissReason,
  learnedEntry,
  MAX_LEARNED_PER_REVIEW,
  memorySourceLabel,
  memorySubject,
  type AnalysisMemoryEntry,
  type LearnedEntry,
  type ReviewDecision,
} from "@rocky-reviews/core";
import { parseAnalysisDocument, type AnalysisDocument, type Severity } from "@rocky-reviews/schema";
import type { TenantTx } from "./client.js";
import { createMemoryEntry, lockRepoMemory, supersedeMemoryEntry } from "./memory.js";

/**
 * Project memory around an analysis (P8-2, ADR 0037): what the worker gives a review
 * (`loadAnalysisMemory`) and what a posted review teaches (`learnFromReviewSubmission`). Both
 * run in the caller's `withOrg` transaction (RLS keeps them to that org; the explicit filters are
 * defence in depth) and touch one repository only.
 *
 * Learning happens once a review is **posted** (the submission's status is `posted`), not at each
 * decision: a decision can be undone until then, the reviewer chose to submit it, and GitHub then
 * holds the review it came from. A review that is never posted teaches nothing. Results are
 * counts; nothing here logs or returns entry text.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LearnerRole = "owner" | "admin" | "member";
const ROLE_RANK: Readonly<Record<LearnerRole, number>> = { owner: 2, admin: 1, member: 0 };
const isLearnerRole = (value: unknown): value is LearnerRole =>
  value === "owner" || value === "admin" || value === "member";
/** A learned entry without a recorded role ranks as `member`. */
const roleRank = (value: string | null): number => (isLearnerRole(value) ? ROLE_RANK[value] : 0);

export class MemoryLearningError extends Error {
  override readonly name = "MemoryLearningError";
}

/**
 * How many current entries of each group an analysis loads, newest first in each (fix round,
 * M2/S5): member-written entries, learned dismissals and other learned entries are bounded
 * separately, so neither a burst of learned entries can push out what people wrote nor newer
 * conventions push out the dismissals. Together `MAX_ANALYSIS_MEMORY`.
 */
export const ANALYSIS_MEMORY_BOUNDS = {
  member: 100,
  learnedDismissals: 100,
  learnedOther: 50,
} as const;

/**
 * The repository's current entries as the pipeline takes them (`AnalysisRequest.memory`): each
 * group of `ANALYSIS_MEMORY_BOUNDS`, newest first. The pipeline re-checks each one before use.
 * Entries an admin switched off, and every entry of a repository whose memory is switched off,
 * are never offered (P8-3, ADR 0039).
 */
export const loadAnalysisMemory = async (
  tx: TenantTx,
  repoId: string,
): Promise<AnalysisMemoryEntry[]> => {
  const { rows } = await tx.query<{
    id: string;
    kind: AnalysisMemoryEntry["kind"];
    origin: AnalysisMemoryEntry["origin"];
    reason: AnalysisMemoryEntry["reason"];
    severity: AnalysisMemoryEntry["severity"];
    content: string;
    evidence_path: string;
    source_pr_number: number;
    confidence: number;
  }>(
    `select id, kind, origin, reason, severity, content, evidence_path, source_pr_number,
            confidence
       from (select e.*, row_number() over (
                      partition by case when origin = 'member' then 'member'
                                        when kind = 'dismissal' then 'dismissal'
                                        else 'other' end
                      order by created_at desc, id desc) as n
               from memory_entries e
              where org_id = $1 and repo_id = $2 and superseded_by is null
                and disabled_at is null
                -- P8-3: memory switched off for the repository offers nothing.
                and exists (select 1 from repos r
                             where r.org_id = e.org_id and r.id = e.repo_id and r.memory_enabled)
            ) ranked
      where (origin = 'member' and n <= $3)
         or (origin = 'learned' and kind = 'dismissal' and n <= $4)
         or (origin = 'learned' and kind <> 'dismissal' and n <= $5)
      order by created_at desc, id desc`,
    [
      tx.orgId,
      repoId,
      ANALYSIS_MEMORY_BOUNDS.member,
      ANALYSIS_MEMORY_BOUNDS.learnedDismissals,
      ANALYSIS_MEMORY_BOUNDS.learnedOther,
    ],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    reason: row.reason,
    severity: row.severity,
    text: row.content,
    path: row.evidence_path,
    source: memorySourceLabel({
      kind: row.kind,
      evidence: { pullRequestNumber: row.source_pr_number },
    }),
    confidence: row.confidence,
  }));
};

export type LearnFromReviewResult =
  | {
      readonly outcome: "learned";
      /** New entries stored. */
      readonly created: number;
      /** Older learned entries the new ones replaced (same path and subject). */
      readonly superseded: number;
      /** Decisions already learned from the same evidence (a second post of the same revision). */
      readonly repeated: number;
      /** Decisions that teach nothing, or whose entry the store refused. */
      readonly skipped: number;
    }
  | { readonly outcome: "not_found" }
  /** The submission is not `posted` (yet): nothing is learned from an unposted review. */
  | { readonly outcome: "not_posted" }
  /** The reviewer is no longer an active member: entries are written in their name only. */
  | { readonly outcome: "not_a_member" }
  /** Memory is switched off for the repository (P8-3): nothing is learned. */
  | { readonly outcome: "memory_disabled" };

interface Decided {
  readonly analysisId: string;
  readonly findingId: string;
  readonly decision: ReviewDecision;
}

/**
 * Learns from one posted review: the drafts it carried (accepted, as is or edited) and the
 * reviewer's dismissed drafts on the same analyses (the analyses the carried drafts came from
 * and the revision's latest finished one). Each decision goes through core `learnedEntry`; at
 * most `MAX_LEARNED_PER_REVIEW` entries per review, dismissals first (they are what a later
 * review acts on). The whole run holds the repository's memory lock, so two learners (a post and
 * its reconcile, two reviewers) never both store the same entry (fix round, S4).
 *
 * A reviewer who wrote the pull request teaches no dismissal from it: an author must not be able
 * to switch a finding off for the repository by dismissing it on their own PR (fix round, M2).
 * A dismissal records the dismissed finding's severity, the highest it will cover, and every
 * learned entry records the reviewer's role. For each entry, in order:
 *
 * 1. an entry already learned from the same evidence (kind, reason, path, sha, lines, PR) is a
 *    repeat: nothing is written (posting twice on a revision teaches once);
 * 2. a current learned entry on the same path with the same kind and subject, learned from
 *    **another** pull request, corroborates it: the new entry's confidence is raised by a step
 *    (`corroboratedConfidence`). One PR never corroborates itself (fix round, N2);
 * 3. the entry is stored by `createMemoryEntry` as the reviewer (scrubbed with the org's member
 *    logins, the PR author and the reviewer as known people);
 * 4. current learned entries on the same path with the same subject, of any kind, are
 *    superseded by it, unless a reviewer with a higher role taught them (owner > admin >
 *    member; fix round, L2): the newest decision about a pattern wins, and history is kept.
 *    When a higher role taught the opposite kind, the candidate is not stored at all (step 2b,
 *    fix round 2): it would otherwise stay current beside it and, as a dismissal, hide it.
 *
 * Member-written entries (P8-3) are never superseded by learning.
 */
export const learnFromReviewSubmission = async (
  tx: TenantTx,
  submissionId: string,
): Promise<LearnFromReviewResult> => {
  if (typeof submissionId !== "string" || !UUID.test(submissionId)) {
    throw new MemoryLearningError("memory learning: submission id must be a uuid");
  }
  const { rows } = await tx.query<{
    status: string;
    submitted_by: string;
    revision_id: string;
    repo_id: string;
    number: number;
    author_login: string | null;
    reviewer_login: string | null;
    reviewer_role: string | null;
    reviewer_active: boolean | null;
  }>(
    `select s.status, s.submitted_by, s.revision_id, p.repo_id, p.number, p.author_login,
            m.login as reviewer_login, m.role as reviewer_role,
            (m.removed_at is null) as reviewer_active
       from review_submissions s
       join pull_requests p on p.org_id = s.org_id and p.id = s.pull_request_id
       left join members m on m.org_id = s.org_id and m.id = s.submitted_by
      where s.org_id = $1 and s.id = $2`,
    [tx.orgId, submissionId.toLowerCase()],
  );
  const submission = rows[0];
  if (submission === undefined) return { outcome: "not_found" };
  if (submission.status !== "posted") return { outcome: "not_posted" };
  if (submission.reviewer_active !== true) return { outcome: "not_a_member" };
  const reviewer = submission.submitted_by;
  const role = isLearnerRole(submission.reviewer_role) ? submission.reviewer_role : "member";
  await lockRepoMemory(tx, submission.repo_id);
  // Read again under the lock: switching memory off takes it too (P8-3), so the switch and a
  // learner in flight never interleave.
  const enabled = await tx.query<{ memory_enabled: boolean }>(
    "select memory_enabled from repos where org_id = $1 and id = $2",
    [tx.orgId, submission.repo_id],
  );
  if (enabled.rows[0]?.memory_enabled !== true) return { outcome: "memory_disabled" };
  const ownPullRequest =
    submission.author_login !== null &&
    submission.reviewer_login !== null &&
    submission.author_login.toLowerCase() === submission.reviewer_login.toLowerCase();

  // The drafts this review carried, with whether the reviewer edited them.
  const carried = await tx.query<{
    analysis_id: string;
    finding_id: string;
    source: string | null;
  }>(
    `select g.analysis_id, g.finding_id, c.source
       from review_submission_items i
       join findings_state g on g.org_id = i.org_id and g.id = i.item_id
       left join comments_pending c
         on c.org_id = g.org_id and c.analysis_id = g.analysis_id and c.author_id = g.member_id
        and c.finding_id = g.finding_id and c.source in ('ai', 'ai_edited')
      where i.org_id = $1 and i.submission_id = $2 and i.kind = 'draft'
        and g.member_id = $3 and g.state = 'accepted'
      order by i.seq`,
    [tx.orgId, submissionId, reviewer],
  );
  const latest = await tx.query<{ id: string }>(
    `select id from analyses
      where org_id = $1 and revision_id = $2 and status = 'done'
      order by completed_at desc nulls last, created_at desc, id limit 1`,
    [tx.orgId, submission.revision_id],
  );
  const analysisIds = [
    ...new Set([...carried.rows.map((r) => r.analysis_id), ...latest.rows.map((r) => r.id)]),
  ];
  const dismissed = await tx.query<{ analysis_id: string; finding_id: string; reason: string }>(
    `select analysis_id, finding_id, reason from findings_state
      where org_id = $1 and member_id = $2 and state = 'dismissed'
        and analysis_id = any($3::uuid[])
      order by analysis_id, finding_id`,
    [tx.orgId, reviewer, analysisIds],
  );
  // Dismissals first: within the per-review cap they are what a later review acts on (N1).
  const decided: Decided[] = [
    ...dismissed.rows.flatMap((r) =>
      isDismissReason(r.reason)
        ? [
            {
              analysisId: r.analysis_id,
              findingId: r.finding_id,
              decision: { kind: "dismissed", reason: r.reason } as const,
            },
          ]
        : [],
    ),
    ...carried.rows.map((r) => ({
      analysisId: r.analysis_id,
      findingId: r.finding_id,
      decision: { kind: "accepted", edited: r.source === "ai_edited" } as const,
    })),
  ];

  const documents = new Map<string, AnalysisDocument>();
  if (analysisIds.length > 0) {
    const docs = await tx.query<{ id: string; document: unknown }>(
      `select id, document from analyses
        where org_id = $1 and id = any($2::uuid[]) and status = 'done'`,
      [tx.orgId, analysisIds],
    );
    for (const row of docs.rows) {
      // Validated again at the read: a document that does not parse teaches nothing.
      const parsed = parseAnalysisDocument(row.document);
      if (parsed.ok) documents.set(row.id, parsed.value);
    }
  }

  const candidates: { readonly entry: LearnedEntry; readonly severity: Severity | null }[] = [];
  let skipped = 0;
  for (const { analysisId, findingId, decision } of decided) {
    const document = documents.get(analysisId);
    const finding = document?.findings.find((f) => f.id === findingId);
    const learned =
      document === undefined ||
      finding === undefined ||
      (ownPullRequest && decision.kind === "dismissed")
        ? null
        : // The PR as the mirror knows it (the store looks its author up by this number); the
          // commit the finding's lines were read at, from the document.
          learnedEntry(decision, finding, {
            pullRequestNumber: submission.number,
            headSha: document.provenance.head.sha,
          });
    if (learned === null || candidates.length >= MAX_LEARNED_PER_REVIEW) skipped++;
    else
      candidates.push({
        entry: learned,
        severity: learned.kind === "dismissal" ? (finding?.severity ?? null) : null,
      });
  }

  // The logins Rocky saw around these decisions: the PR's author and the reviewer (the store adds
  // every member login of the org too). The mirror stores no commenters or requested reviewers.
  const people = [submission.author_login, submission.reviewer_login].filter(
    (login): login is string => typeof login === "string" && login.length > 0,
  );

  let created = 0;
  let superseded = 0;
  let repeated = 0;
  for (const { entry: candidate, severity } of candidates) {
    const { evidence } = candidate;
    const repeat = await tx.query(
      `select 1 from memory_entries
        where org_id = $1 and repo_id = $2 and kind = $3 and reason is not distinct from $4
          and evidence_path = $5 and evidence_sha = $6 and evidence_start = $7
          and evidence_end = $8 and source_pr_number = $9 and origin = 'learned'
        limit 1`,
      [
        tx.orgId,
        submission.repo_id,
        candidate.kind,
        candidate.reason,
        evidence.path,
        evidence.sha,
        evidence.range.start,
        evidence.range.end,
        evidence.pullRequestNumber,
      ],
    );
    if (repeat.rowCount !== 0) {
      repeated++;
      continue;
    }
    const near = await tx.query<{
      id: string;
      kind: string;
      confidence: number;
      source_pr_number: number;
      learner_role: string | null;
      origin: string;
      learned_subject: string | null;
      disabled: boolean;
    }>(
      // Current entries of either origin: an edited entry (origin member) still holds its
      // pattern's switch-off and its decision (P8-3 fix round, S2), matched on the subject it was
      // learned with, whatever its text says now (fix round 2).
      `select id, kind, confidence, source_pr_number, learner_role, origin,
              learned_subject, (disabled_at is not null) as disabled
         from memory_entries
        where org_id = $1 and repo_id = $2 and evidence_path = $3
          and superseded_by is null
        order by created_at desc, id desc`,
      [tx.orgId, submission.repo_id, evidence.path],
    );
    const subject = memorySubject(candidate.text);
    // An admin switched this very pattern off (P8-3): learning it again beside the switched-off
    // entry would undo that, so nothing is learned. The opposite decision is learned, and it
    // stays switched off (below).
    const switchedOff = near.rows.some(
      (row) =>
        row.disabled &&
        row.kind === candidate.kind &&
        subject !== null &&
        row.learned_subject === subject,
    );
    if (switchedOff) {
      skipped++;
      continue;
    }
    const corroborating = near.rows.find(
      (row) =>
        !row.disabled &&
        row.origin === "learned" &&
        row.kind === candidate.kind &&
        row.source_pr_number !== evidence.pullRequestNumber &&
        row.learned_subject === subject,
    );
    // A higher role's opposite decision about the pattern stands: a member's dismissal must not
    // switch off what an owner asked for (nor the reverse), so nothing is learned (fix round 2,
    // S1). The same decision from a lower role adds nothing either way.
    const overruled = near.rows.some(
      (row) =>
        row.kind !== candidate.kind &&
        roleRank(row.learner_role) > ROLE_RANK[role] &&
        row.learned_subject === subject,
    );
    if (overruled) {
      skipped++;
      continue;
    }
    const result = await createMemoryEntry(tx, {
      authorMemberId: reviewer,
      repoId: submission.repo_id,
      // Learned: written in the reviewer's name, who needs to be an active member, not to hold
      // `memory.edit` (ADR 0036 fix round).
      origin: "learned",
      entry: {
        ...candidate,
        confidence: corroboratedConfidence(candidate.confidence, corroborating?.confidence),
      },
      people,
    });
    if (result.outcome !== "created") {
      skipped++;
      continue;
    }
    created++;
    // Compared on the stored (scrubbed) texts, so a scrubbed title still matches its older entry.
    const storedSubject = memorySubject(result.entry.text);
    await tx.query(
      `update memory_entries set severity = $3, learner_role = $4, learned_subject = $5
        where org_id = $1 and id = $2`,
      [tx.orgId, result.entry.id, severity, role, storedSubject],
    );
    // The opposite decision about a switched-off pattern is learned switched off too, so learning
    // never undoes an admin's decision in two steps (P8-3 fix round, S3); only a person switches
    // it on again. Compared on the stored subject, like superseding below.
    const carriesSwitchOff =
      storedSubject !== null &&
      near.rows.some((row) => row.disabled && row.learned_subject === storedSubject);
    for (const row of near.rows) {
      if (row.origin !== "learned") continue;
      if (storedSubject === null || row.learned_subject !== storedSubject) continue;
      // A higher role's decision is not overturned by a lower one's (L2).
      if (roleRank(row.learner_role) > ROLE_RANK[role]) continue;
      const replaced = await supersedeMemoryEntry(tx, {
        actorMemberId: reviewer,
        entryId: row.id,
        byEntryId: result.entry.id,
        origin: "learned",
      });
      if (replaced === "superseded") superseded++;
    }
    if (carriesSwitchOff)
      await tx.query(
        `update memory_entries set disabled_at = now(), updated_at = now()
          where org_id = $1 and id = $2`,
        [tx.orgId, result.entry.id],
      );
  }
  return { outcome: "learned", created, superseded, repeated, skipped };
};
