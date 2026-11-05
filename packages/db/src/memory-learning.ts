import {
  corroboratedConfidence,
  isDismissReason,
  learnedEntry,
  MAX_ANALYSIS_MEMORY,
  MAX_LEARNED_PER_REVIEW,
  memorySourceLabel,
  memorySubject,
  type AnalysisMemoryEntry,
  type LearnedEntry,
  type ReviewDecision,
} from "@rocky-reviews/core";
import { parseAnalysisDocument, type AnalysisDocument } from "@rocky-reviews/schema";
import type { TenantTx } from "./client.js";
import { createMemoryEntry, listMemoryEntries, supersedeMemoryEntry } from "./memory.js";

/**
 * Project memory around an analysis (P8-2, ADR 0036 amendment): what the worker gives a review
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

export class MemoryLearningError extends Error {
  override readonly name = "MemoryLearningError";
}

/**
 * The repository's current entries as the pipeline takes them (`AnalysisRequest.memory`), newest
 * first, at most `MAX_ANALYSIS_MEMORY`. The pipeline re-checks each one before use.
 */
export const loadAnalysisMemory = async (
  tx: TenantTx,
  repoId: string,
): Promise<AnalysisMemoryEntry[]> => {
  const entries = await listMemoryEntries(tx, { repoId, limit: MAX_ANALYSIS_MEMORY });
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    reason: entry.reason,
    text: entry.text,
    path: entry.evidence.path,
    source: memorySourceLabel(entry),
    confidence: entry.confidence,
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
  | { readonly outcome: "not_a_member" };

interface Decided {
  readonly analysisId: string;
  readonly findingId: string;
  readonly decision: ReviewDecision;
}

/**
 * Learns from one posted review: the drafts it carried (accepted, as is or edited) and the
 * reviewer's dismissed drafts on the same analyses (the analyses the carried drafts came from
 * and the revision's latest finished one). Each decision goes through core `learnedEntry`; at
 * most `MAX_LEARNED_PER_REVIEW` entries per review. For each entry, in order:
 *
 * 1. an entry already learned from the same evidence (kind, reason, path, sha, lines, PR) is a
 *    repeat: nothing is written (posting twice on a revision teaches once);
 * 2. a current learned entry on the same path with the same kind and subject corroborates it:
 *    the new entry's confidence is raised by a step (`corroboratedConfidence`);
 * 3. the entry is stored by `createMemoryEntry` as the reviewer (scrubbed with the org's member
 *    logins, the PR author and the reviewer as known people);
 * 4. current learned entries on the same path with the same subject, of any kind, are
 *    superseded by it: the newest human decision about a pattern wins, and history is kept.
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
    reviewer_active: boolean | null;
  }>(
    `select s.status, s.submitted_by, s.revision_id, p.repo_id, p.number, p.author_login,
            m.login as reviewer_login, (m.removed_at is null) as reviewer_active
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
  const decided: Decided[] = [
    ...carried.rows.map((r) => ({
      analysisId: r.analysis_id,
      findingId: r.finding_id,
      decision: { kind: "accepted", edited: r.source === "ai_edited" } as const,
    })),
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

  const candidates: LearnedEntry[] = [];
  let skipped = 0;
  for (const { analysisId, findingId, decision } of decided) {
    const document = documents.get(analysisId);
    const finding = document?.findings.find((f) => f.id === findingId);
    const learned =
      document === undefined || finding === undefined
        ? null
        : // The PR as the mirror knows it (the store looks its author up by this number); the
          // commit the finding's lines were read at, from the document.
          learnedEntry(decision, finding, {
            pullRequestNumber: submission.number,
            headSha: document.provenance.head.sha,
          });
    if (learned === null || candidates.length >= MAX_LEARNED_PER_REVIEW) skipped++;
    else candidates.push(learned);
  }

  // The logins Rocky saw around these decisions: the PR's author and the reviewer (the store adds
  // every member login of the org too). The mirror stores no commenters or requested reviewers.
  const people = [submission.author_login, submission.reviewer_login].filter(
    (login): login is string => typeof login === "string" && login.length > 0,
  );

  let created = 0;
  let superseded = 0;
  let repeated = 0;
  for (const candidate of candidates) {
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
    const near = await tx.query<{ id: string; kind: string; content: string; confidence: number }>(
      `select id, kind, content, confidence from memory_entries
        where org_id = $1 and repo_id = $2 and evidence_path = $3 and origin = 'learned'
          and superseded_by is null
        order by created_at desc, id desc`,
      [tx.orgId, submission.repo_id, evidence.path],
    );
    const subject = memorySubject(candidate.text);
    const corroborating = near.rows.find(
      (row) => row.kind === candidate.kind && memorySubject(row.content) === subject,
    );
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
    for (const row of near.rows) {
      if (storedSubject === null || memorySubject(row.content) !== storedSubject) continue;
      const replaced = await supersedeMemoryEntry(tx, {
        actorMemberId: reviewer,
        entryId: row.id,
        byEntryId: result.entry.id,
        origin: "learned",
      });
      if (replaced === "superseded") superseded++;
    }
  }
  return { outcome: "learned", created, superseded, repeated, skipped };
};
