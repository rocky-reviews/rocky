/**
 * The inbox (P6-7, ADR 0029): open pull requests across the org's repositories, sorted by risk,
 * and which of them Rocky offers to approve in a batch.
 *
 * "Safe to bulk-approve" is a grouping, never an action. It is computed from the stored analysis
 * (model output, already schema-validated) plus facts that no model writes: the PR's state and
 * author, its size, whether its diff was read in full, the pipeline-owned provenance (unanalysed
 * files, read-by-hand files, Rocky's own briefing) and Rocky's path rules (migrations, auth).
 * A PR is offered only when every check passes. Nothing here approves anything: an approval
 * happens only when a person confirms a batch (the server's approvals route), which re-runs this
 * assessment on the stored rows and refuses the batch if any PR no longer qualifies or has moved
 * past the commit the person saw.
 */
import {
  type AnalysisDocument,
  FullSha,
  parseAnalysisDocument,
  RepoName,
  RepoOwner,
} from "@rocky-reviews/schema";
import { z } from "zod";
import { preTriage } from "./analysis/rules.js";
import { belowVerdictFloor } from "./analysis/verdict.js";
import type { OrgId } from "./ports.js";

/** Risk as the inbox sorts it: `unknown` (no current analysis) sits between medium and low. */
export const INBOX_RISKS = ["critical", "high", "medium", "unknown", "low"] as const;
export type InboxRisk = (typeof INBOX_RISKS)[number];

/** Where the PR's analysis stands. `out_of_date`: the latest analysis is of an older push. */
export const INBOX_ANALYSIS_STATES = [
  "none",
  "queued",
  "running",
  "awaiting_approval",
  "failed",
  "out_of_date",
  "done",
] as const;
export type InboxAnalysisState = (typeof INBOX_ANALYSIS_STATES)[number];

/** Why a PR is not offered for bulk approval. Fixed codes; the UI maps them to fixed text. */
export const BULK_APPROVE_BLOCKERS = [
  "not_open",
  "own_pull_request",
  "no_current_analysis",
  "risk_not_low",
  "verdict_below_floor",
  "findings",
  "risky_files",
  "sensitive_paths",
  "unanalysed_files",
  "read_by_hand",
  "briefing_by_rocky",
  "noise_files",
  "diff_incomplete",
  "diff_not_read",
  "too_large",
] as const;
export type BulkApproveBlocker = (typeof BULK_APPROVE_BLOCKERS)[number];

/** Above this many changed lines a PR is never offered, whatever the analysis says. */
export const MAX_BULK_APPROVE_LINES = 300;
/** The most pull requests one confirmation approves. */
export const MAX_BULK_APPROVE_BATCH = 20;
/** The most pull requests the inbox lists (most recently updated first, then sorted by risk). */
export const MAX_INBOX_ITEMS = 100;

/** The analysis statuses the database stores (migration 0012). */
export type StoredAnalysisStatus = "queued" | "running" | "awaiting_approval" | "done" | "failed";

/** What the assessment needs about one pull request. */
export interface InboxFacts {
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string;
  readonly authorLogin: string | null;
  /** The viewer's own login in this org; a PR they wrote is never offered (GitHub refuses it). */
  readonly viewerLogin: string | null;
  /** Size of the current head; `null` when the head's diff was never read. */
  readonly size: { readonly additions: number; readonly deletions: number } | null;
  /** The head's diff was cut short (or never read): the analysis did not see all of it. */
  readonly diffIncomplete: boolean;
  /** The latest analysis, or `null` when there is none. */
  readonly analysis: {
    readonly status: StoredAnalysisStatus;
    /** The head commit of the revision the analysis is for. */
    readonly headSha: string;
    /** The validated document of a `done` analysis; `null` when it is missing or invalid. */
    readonly document: AnalysisDocument | null;
  } | null;
}

export interface FindingCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export interface InboxAssessment {
  readonly risk: InboxRisk;
  readonly analysis: InboxAnalysisState;
  readonly findings: FindingCounts;
  readonly estimatedMinutes: number | null;
  readonly bulkApproval: {
    readonly eligible: boolean;
    readonly blockers: readonly BulkApproveBlocker[];
  };
}

const NO_FINDINGS: FindingCounts = { critical: 0, high: 0, medium: 0, low: 0 };

const sameLogin = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

const countFindings = (document: AnalysisDocument): FindingCounts => {
  const counts = { ...NO_FINDINGS };
  for (const finding of document.findings) counts[finding.severity] += 1;
  return counts;
};

/** The document this PR's analysis stands on, and whether it is for the current head. */
const analysisState = (facts: InboxFacts): InboxAnalysisState => {
  const { analysis } = facts;
  if (analysis === null) return "none";
  if (analysis.headSha !== facts.headSha) {
    return analysis.status === "done" && analysis.document !== null ? "out_of_date" : "none";
  }
  if (analysis.status === "done") return analysis.document === null ? "failed" : "done";
  return analysis.status;
};

/**
 * The inbox's view of one pull request. Pure: the server runs it on stored rows, the web's
 * fixture source on fixture documents, and the approvals route again before any approval.
 */
export const assessPullRequest = (facts: InboxFacts): InboxAssessment => {
  const state = analysisState(facts);
  const document =
    (state === "done" || state === "out_of_date") && facts.analysis !== null
      ? facts.analysis.document
      : null;
  // A document must describe the commit its revision names; otherwise it is not used at all.
  const usable =
    document !== null && document.provenance.head.sha === facts.analysis?.headSha ? document : null;
  const analysis = document !== null && usable === null ? "failed" : state;
  const risk: InboxRisk = usable === null ? "unknown" : usable.briefing.verdict.level;

  const blockers: BulkApproveBlocker[] = [];
  const block = (blocker: BulkApproveBlocker, when: boolean) => {
    if (when) blockers.push(blocker);
  };
  block("not_open", facts.state !== "open");
  block("own_pull_request", sameLogin(facts.authorLogin, facts.viewerLogin));
  block("no_current_analysis", analysis !== "done");
  if (analysis === "done" && usable !== null) {
    const provenance = usable.provenance;
    block("risk_not_low", usable.briefing.verdict.level !== "low");
    block("verdict_below_floor", belowVerdictFloor(usable));
    block("findings", usable.findings.length > 0);
    block(
      "risky_files",
      usable.triage.files.some((file) => file.level === "critical" || file.level === "important"),
    );
    // Rocky's own rules, not the model: a migration or an auth path is always read by a person,
    // on either side of a rename (moving a file out of `auth/` is an auth change) and when it is
    // deleted (the deleted path is `path`).
    block(
      "sensitive_paths",
      provenance.files.some((file) =>
        [file.path, file.previousPath].some((path) => {
          if (path === undefined) return false;
          const rule = preTriage(path);
          return rule.kind === "analyse" && rule.floor !== undefined;
        }),
      ),
    );
    // Noise (lockfiles, generated-looking paths) is decided from the path alone and never read
    // by the model: a "generated" backdoor or a lockfile pointing at another tarball would pass
    // every other check. The PR page says "the AI did not read it"; the bulk group must not
    // skip that page.
    block("noise_files", usable.triage.noise.length > 0);
    block("unanalysed_files", provenance.unanalysed.length > 0);
    block("read_by_hand", provenance.readByHand.length > 0);
    block("briefing_by_rocky", provenance.briefingUnavailable !== undefined);
  }
  block("diff_incomplete", facts.size !== null && facts.diffIncomplete);
  block("diff_not_read", facts.size === null);
  block(
    "too_large",
    facts.size !== null && facts.size.additions + facts.size.deletions > MAX_BULK_APPROVE_LINES,
  );

  return {
    risk,
    analysis,
    findings: usable === null ? NO_FINDINGS : countFindings(usable),
    estimatedMinutes: usable === null ? null : usable.briefing.estimatedReviewMinutes,
    bulkApproval: { eligible: blockers.length === 0, blockers },
  };
};

/**
 * A stored analysis document, validated, and only when it describes this very pull request
 * (GitHub treats owner and repository names case-insensitively); otherwise `null`.
 */
export const readInboxDocument = (
  raw: unknown,
  pull: { readonly owner: string; readonly name: string; readonly number: number },
): AnalysisDocument | null => {
  if (raw === null || raw === undefined) return null;
  const parsed = parseAnalysisDocument(raw);
  if (!parsed.ok) return null;
  const { repo, pullRequest } = parsed.value.provenance;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return same(repo.owner, pull.owner) &&
    same(repo.name, pull.name) &&
    pullRequest.number === pull.number
    ? parsed.value
    : null;
};

/** `owner/name` split into names that pass the forge's rules, or `null`. */
export const splitRepoFullName = (
  fullName: string,
): { readonly owner: string; readonly name: string } | null => {
  const [owner, name, extra] = fullName.split("/");
  if (extra !== undefined || owner === undefined || name === undefined) return null;
  if (!RepoOwner.safeParse(owner).success || !RepoName.safeParse(name).success) return null;
  return name === "." || name === ".." ? null : { owner, name };
};

// ---------- the wire format (server → web) ----------

/** A login shown as text (author), including app bots (`dependabot[bot]`). */
const DisplayLogin = z.string().regex(/^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/, "must be a login");
const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must be a uuid");
const Count = z.int().min(0).max(100_000_000);
/** GitHub caps titles at 256 characters; a little slack for other forges later. */
const MAX_TITLE_LENGTH = 1024;

export const InboxItem = z
  .strictObject({
    /** Rocky's id of the pull request (the mirror row). */
    id: Uuid,
    repo: z.strictObject({ owner: RepoOwner, name: RepoName }),
    number: z.int().min(1).max(1_000_000_000),
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    author: DisplayLogin.nullable(),
    headSha: FullSha,
    updatedAt: z.iso.datetime(),
    size: z.strictObject({ additions: Count, deletions: Count, files: Count }).nullable(),
    risk: z.enum(INBOX_RISKS),
    analysis: z.enum(INBOX_ANALYSIS_STATES),
    findings: z.strictObject({ critical: Count, high: Count, medium: Count, low: Count }),
    estimatedMinutes: Count.nullable(),
    bulkApproval: z
      .strictObject({
        eligible: z.boolean(),
        blockers: z.array(z.enum(BULK_APPROVE_BLOCKERS)).max(BULK_APPROVE_BLOCKERS.length),
      })
      // Eligible means exactly "nothing blocks it": a source cannot claim both.
      .refine((b) => b.eligible === (b.blockers.length === 0), "eligible must match blockers"),
  })
  .describe("One open pull request in the inbox.");
export type InboxItem = z.infer<typeof InboxItem>;

export const InboxResponse = z.strictObject({
  items: z
    .array(InboxItem)
    .max(MAX_INBOX_ITEMS)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, "duplicate ids"),
  /** More open pull requests exist than the inbox lists. */
  truncated: z.boolean(),
});
export type InboxResponse = z.infer<typeof InboxResponse>;

/** One confirmed batch: each pull request at the commit the person saw. */
export const BulkApproveRequest = z.strictObject({
  pullRequests: z
    .array(z.strictObject({ id: Uuid, headSha: FullSha }))
    .min(1)
    .max(MAX_BULK_APPROVE_BATCH)
    .refine((prs) => new Set(prs.map((p) => p.id)).size === prs.length, "duplicate ids"),
});
export type BulkApproveRequest = z.infer<typeof BulkApproveRequest>;

/**
 * Why a batch was refused before anything was approved: one entry per pull request that no
 * longer qualifies. `head_moved`: someone pushed after the person looked.
 */
export const BULK_APPROVE_REFUSALS = ["head_moved", "not_eligible"] as const;
export type BulkApproveRefusal = (typeof BULK_APPROVE_REFUSALS)[number];

/**
 * One PR's outcome. `head_moved`: GitHub's live head (or state) no longer matched the commit
 * the person confirmed, so nothing was submitted for it.
 */
export const BULK_APPROVE_OUTCOMES = ["approved", "head_moved", "failed"] as const;
export type BulkApproveOutcome = (typeof BULK_APPROVE_OUTCOMES)[number];

export const BulkApproveResponse = z.strictObject({
  results: z
    .array(z.strictObject({ id: Uuid, outcome: z.enum(BULK_APPROVE_OUTCOMES) }))
    .max(MAX_BULK_APPROVE_BATCH),
});
export type BulkApproveResponse = z.infer<typeof BulkApproveResponse>;

/**
 * The port that submits one approving review on the forge as the person who confirmed the batch
 * (P3-5 fills it: the member's own token, a review with the APPROVE event and no body, pinned
 * to `headSha`). Called only by the approvals route, after a CSRF-checked request from a
 * signed-in member and every re-check; never by the worker, never from model output.
 *
 * Requirements on the implementation (ADR 0029 §3):
 * - **Live head.** The mirror can lag GitHub (a push before its synchronize webhook is
 *   processed), and an approval at an older `commit_id` still counts for merge unless the repo
 *   dismisses stale approvals. So it must read the live PR from GitHub, as the member, right
 *   before submitting, and answer `head_moved` without submitting when `head.sha !== headSha`
 *   or `state !== "open"`.
 * - **Idempotent per (member, PR, head).** A second call for the same member, pull request and
 *   `headSha` (a retry after an unclear answer, another server process, a re-submitted batch)
 *   must not submit a second review: it answers `approved` if this member's approval at that
 *   commit exists, and submits nothing more.
 * - Anything it cannot confirm answers `failed` (or throws, which the route reports as
 *   `failed`); it never logs the token or forge error text.
 */
export interface PullRequestApprover {
  approve(request: {
    readonly orgId: OrgId;
    /** The member who clicked: the review is theirs. */
    readonly memberId: string;
    readonly pullRequestId: string;
    readonly headSha: string;
  }): Promise<BulkApproveOutcome>;
}

// ---------- sorting, filtering, grouping ----------

const RISK_RANK: Readonly<Record<InboxRisk, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  unknown: 3,
  low: 4,
};

export const riskRank = (risk: InboxRisk): number => RISK_RANK[risk];

type Sortable = Pick<InboxItem, "risk" | "findings" | "updatedAt" | "repo" | "number">;

/**
 * Riskiest first; within a level, more serious findings first, then the PR waiting longest,
 * then repository and number so the order is stable.
 */
export const compareInboxItems = (a: Sortable, b: Sortable): number =>
  RISK_RANK[a.risk] - RISK_RANK[b.risk] ||
  b.findings.critical - a.findings.critical ||
  b.findings.high - a.findings.high ||
  b.findings.medium - a.findings.medium ||
  Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
  `${a.repo.owner}/${a.repo.name}`.localeCompare(`${b.repo.owner}/${b.repo.name}`) ||
  a.number - b.number;

export const sortInbox = <T extends Sortable>(items: readonly T[]): T[] =>
  items.toSorted(compareInboxItems);

export interface InboxFilter {
  /** `owner/name`, or `null` for every repository. */
  readonly repo: string | null;
  readonly risk: InboxRisk | null;
  /** Matches the title, `owner/name` or `#number`, ignoring case. */
  readonly query: string;
}

export const NO_FILTER: InboxFilter = { repo: null, risk: null, query: "" };

export const repoKey = (item: Pick<InboxItem, "repo">): string =>
  `${item.repo.owner}/${item.repo.name}`;

export const matchesFilter = (
  item: Pick<InboxItem, "repo" | "risk" | "title" | "number">,
  filter: InboxFilter,
): boolean => {
  if (filter.repo !== null && repoKey(item).toLowerCase() !== filter.repo.toLowerCase())
    return false;
  if (filter.risk !== null && item.risk !== filter.risk) return false;
  const query = filter.query.trim().toLowerCase();
  if (query === "") return true;
  return (
    item.title.toLowerCase().includes(query) ||
    repoKey(item).toLowerCase().includes(query) ||
    `#${item.number}` === query ||
    String(item.number) === query
  );
};

/** The inbox as the page shows it: the offered batch, and everything else by risk. */
export const groupInbox = <T extends Sortable & Pick<InboxItem, "bulkApproval">>(
  items: readonly T[],
): { readonly safe: T[]; readonly review: T[] } => {
  const sorted = sortInbox(items);
  return {
    safe: sorted.filter((item) => item.bulkApproval.eligible),
    review: sorted.filter((item) => !item.bulkApproval.eligible),
  };
};
