/**
 * What the inbox page (P6-7) says about a pull request: fixed labels for risks, analysis states
 * and the reasons a PR is not offered for bulk approval, and the link to its review page. Never
 * PR content: titles and logins are rendered by the components, as text.
 */
import {
  type BulkApproveBlocker,
  type InboxAnalysisState,
  type InboxItem,
  type InboxRisk,
  type BulkApproveRefusal,
} from "@rocky-reviews/core";

export const RISK_LABEL: Readonly<Record<InboxRisk, string>> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  unknown: "Not analysed",
  low: "Low",
};

/** Risk filter options, in the inbox's order. */
export const RISK_OPTIONS: readonly InboxRisk[] = ["critical", "high", "medium", "unknown", "low"];

/** Where the analysis stands, when it is not simply done. */
export const ANALYSIS_LABEL: Readonly<Record<Exclude<InboxAnalysisState, "done">, string>> = {
  none: "Not analysed yet",
  queued: "Queued for analysis",
  running: "Analysing…",
  awaiting_approval: "Waiting for Analyze anyway",
  failed: "Analysis failed",
  out_of_date: "Analysis out of date",
};

const BLOCKER_LABEL: Readonly<Record<Exclude<BulkApproveBlocker, "findings">, string>> = {
  not_open: "Not open",
  own_pull_request: "Your pull request",
  no_current_analysis: "No current analysis",
  risk_not_low: "Not low risk",
  verdict_below_floor: "Verdict below Rocky's floor",
  risky_files: "Has important files",
  sensitive_paths: "Touches auth or migrations",
  unanalysed_files: "Has files the AI could not read",
  read_by_hand: "Has files to read by hand",
  briefing_by_rocky: "Briefing written by Rocky",
  noise_files: "Has files the AI did not read",
  diff_incomplete: "Diff not read in full",
  diff_not_read: "Diff not read yet",
  too_large: "Too large to bulk-approve",
};

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

export const findingTotal = (item: Pick<InboxItem, "findings">): number =>
  item.findings.critical + item.findings.high + item.findings.medium + item.findings.low;

/** Why a low-risk PR is not in the offered batch (the first reason), or `null`. */
export const notOfferedBecause = (
  item: Pick<InboxItem, "risk" | "analysis" | "bulkApproval" | "findings">,
): string | null => {
  if (item.risk !== "low" || item.bulkApproval.eligible) return null;
  const [first] = item.bulkApproval.blockers;
  if (first === undefined) return null;
  // The analysis note already says why (out of date, failed…).
  if (first === "no_current_analysis") return null;
  if (first === "findings") return plural(findingTotal(item), "AI finding", "AI findings");
  return BLOCKER_LABEL[first];
};

export const REFUSAL_LABEL: Readonly<Record<BulkApproveRefusal, string>> = {
  head_moved: "New commits since you looked",
  not_eligible: "No longer qualifies for bulk approval",
};

/** The PR's review page in this app (the PR page reads `repo` and `pr`). */
export const reviewHref = (item: Pick<InboxItem, "repo" | "number">): string =>
  `/?${new URLSearchParams({ repo: `${item.repo.owner}/${item.repo.name}`, pr: String(item.number) })}`;

export const shortSha = (sha: string): string => sha.slice(0, 7);
