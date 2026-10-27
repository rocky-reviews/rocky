/**
 * The top bar's status pill: the viewer's own submitted review when there is one (POC: the
 * pill changes after submit), otherwise the PR's state on GitHub.
 */
import type { MyReview, PullSummary } from "../data/shell-data.js";

export type StatusTone = "ok" | "crit" | "low";

export type Status = { label: string; tone: StatusTone };

const REVIEW: Record<MyReview, Status> = {
  approved: { label: "Approved", tone: "ok" },
  changes_requested: { label: "Changes requested", tone: "crit" },
  commented: { label: "Commented", tone: "low" },
};

const STATE: Record<PullSummary["state"], Status> = {
  open: { label: "Open", tone: "ok" },
  merged: { label: "Merged", tone: "low" },
  closed: { label: "Closed", tone: "low" },
};

export const statusOf = (state: PullSummary["state"], myReview: MyReview | null): Status =>
  myReview === null ? STATE[state] : REVIEW[myReview];
