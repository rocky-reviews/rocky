/**
 * The finish modal's decisions (P6-6, ADR 0031), pure so they are tested without a DOM:
 * which high-risk files were not viewed, how many AI drafts are undecided, which verdict to
 * suggest and why, the summary drafted from the comments, the invisible characters a comment
 * carries, and the words for every answer the server can give. Nothing here posts: the
 * component does, on the person's click only.
 */
import { MAX_REVIEW_BODY_CHARS, MAX_REVIEW_COMMENTS } from "@rocky-reviews/core";
import type { Finding, Severity } from "@rocky-reviews/schema";
import type {
  ListProblem,
  PreviewItem,
  Refusal,
  ReviewVerdict,
  SubmitOutcome,
} from "../data/posting-data.js";
import type { ReviewState } from "../data/review-data.js";
import type { MyReview } from "../data/shell-data.js";
import type { SidebarGroup } from "../shell/triage-model.js";

/** Critical and important files the reviewer has not marked viewed (POC `mustReview`). */
export const unviewedHighRisk = (
  groups: readonly SidebarGroup[],
  viewed: ReadonlySet<string>,
): string[] =>
  groups
    .filter((g) => g.level === "critical" || g.level === "important")
    .flatMap((g) => g.files)
    .map((f) => f.path)
    .filter((path) => !viewed.has(path));

/** Accepted drafts and own comments not yet carried by a review attempt: the Finish count. */
export const pendingCount = (state: ReviewState): number =>
  [...state.drafts.values()].filter((d) => d.decision.state === "accepted" && d.posted === null)
    .length + state.comments.filter((c) => c.posted === null).length;

/** A draft still to decide: no decision, and not already posted (a re-run of posted content). */
export const isUndecided = (state: ReviewState, findingId: string): boolean => {
  const draft = state.drafts.get(findingId);
  return draft === undefined || (draft.decision.state === "draft" && draft.posted === null);
};

export const undecidedCount = (findings: readonly Finding[], state: ReviewState): number =>
  findings.filter((f) => isUndecided(state, f.id)).length;

const SERIOUS: ReadonlySet<Severity> = new Set(["critical", "high"]);

/** A critical or high finding was accepted and is still to be posted (POC `serious`). */
export const seriousAccepted = (findings: readonly Finding[], state: ReviewState): boolean =>
  findings.some((f) => {
    const draft = state.drafts.get(f.id);
    return (
      draft !== undefined &&
      draft.decision.state === "accepted" &&
      draft.posted === null &&
      SERIOUS.has(f.severity)
    );
  });

export type VerdictSuggestion = {
  readonly verdict: ReviewVerdict;
  /** Why, shown next to the option. */
  readonly reason: string;
  /** Whether the option starts selected. An approval never does: the person picks it. */
  readonly preselect: boolean;
};

/**
 * A suggestion only; the person picks or confirms (ADR 0031 §3). Request changes when a
 * critical or high finding was accepted (the POC's rule); Comment when there is something to
 * post; Approve, never pre-selected, when every high-risk file was viewed, every draft decided
 * and nothing is left to post; otherwise none.
 */
export const suggestVerdict = (input: {
  readonly serious: boolean;
  readonly items: number;
  readonly unviewed: number;
  readonly undecided: number;
}): VerdictSuggestion | null => {
  if (input.serious) {
    return {
      verdict: "request_changes",
      reason: "Suggested because you accepted a critical or high finding.",
      preselect: true,
    };
  }
  if (input.items > 0) {
    return {
      verdict: "comment",
      reason: "Suggested: you have comments to post and accepted no critical or high finding.",
      preselect: true,
    };
  }
  if (input.unviewed === 0 && input.undecided === 0) {
    return {
      verdict: "approve",
      reason:
        "Suggested: you viewed every high-risk file, decided every draft and accepted nothing. Pick it to confirm.",
      preselect: false,
    };
  }
  return null;
};

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  comment: "Comment",
  approve: "Approve",
  request_changes: "Request changes",
};

export const VERDICT_HINT: Record<ReviewVerdict, string> = {
  comment: "General feedback, no explicit approval.",
  approve: "Ready to merge.",
  request_changes: "Must be addressed before merging.",
};

/** The status pill after a review was posted (POC: it changes after submit). */
export const myReviewOf = (verdict: ReviewVerdict): MyReview =>
  verdict === "approve"
    ? "approved"
    : verdict === "request_changes"
      ? "changes_requested"
      : "commented";

/** `path:line` or `path:start–line`, the full path GitHub will receive (review round 1, S1). */
export const itemLocation = (item: Pick<PreviewItem, "path" | "line" | "startLine">): string =>
  `${item.path}:${item.startLine === null ? item.line : `${item.startLine}–${item.line}`}`;

const MAX_LEAD = 80;

/** The first line of a comment, without a draft's `**title**` marks, cut for a list. */
export const itemLead = (item: Pick<PreviewItem, "kind" | "body">): string => {
  const first = item.body.split("\n").find((l) => l.trim() !== "") ?? "";
  const lead = item.kind === "draft" ? first.replace(/^\*\*(.*)\*\*$/, "$1") : first;
  return lead.length > MAX_LEAD ? `${lead.slice(0, MAX_LEAD)}…` : lead;
};

/**
 * "Draft a summary from my comments": one numbered line per item to post, from the comments
 * themselves (a draft's title is model text, an own comment is the person's). No model is
 * called. `null` when there is nothing to draft from: the person writes the summary, or leaves
 * it empty. A suggestion: the person edits or clears it, and nothing posts without the click.
 */
export const draftSummary = (items: readonly PreviewItem[]): string | null => {
  if (items.length === 0) return null;
  const lines = items.map((item, i) => `${i + 1}. ${itemLead(item)} (\`${itemLocation(item)}\`)`);
  return `Before merge, please look at:\n\n${lines.join("\n")}\n\nDetails are in the inline comments.`;
};

/**
 * Characters a reader cannot see but GitHub will receive: bidi controls (U+202A–U+202E,
 * U+2066–U+2069, U+200E/U+200F, U+061C), zero-width and joiner characters (U+200B–U+200D,
 * U+2060, U+FEFF), soft hyphen, the tag characters, and C0/C1 controls other than tab and
 * newline. The modal shows each as a visible marker (review round 1, UI-verifier), so a body
 * cannot read one way and post another (ADR 0022's concern, in text).
 */
const isInvisible = (cp: number): boolean =>
  cp <= 0x08 ||
  cp === 0x0b ||
  cp === 0x0c ||
  (cp >= 0x0e && cp <= 0x1f) ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0xad ||
  cp === 0x61c ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2064) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0xfeff ||
  (cp >= 0xe0000 && cp <= 0xe007f);

export type BodySegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "invisible";
      /** `U+202E` form. */
      readonly code: string;
    };

/** The body split into visible text and the invisible characters it carries, in order. */
export const revealInvisible = (body: string): BodySegment[] => {
  const segments: BodySegment[] = [];
  let text = "";
  for (const char of body) {
    const point = char.codePointAt(0) ?? 0;
    if (!isInvisible(point)) {
      text += char;
      continue;
    }
    if (text !== "") segments.push({ kind: "text", text });
    text = "";
    segments.push({
      kind: "invisible",
      code: `U+${point.toString(16).toUpperCase().padStart(4, "0")}`,
    });
  }
  if (text !== "") segments.push({ kind: "text", text });
  return segments;
};

/** The distinct invisible characters in a body (`U+…`), for a warning line. */
export const invisibleCodes = (body: string): string[] => [
  ...new Set(revealInvisible(body).flatMap((s) => (s.kind === "invisible" ? [s.code] : []))),
];

export const LIST_PROBLEM_TEXT: Record<ListProblem, string> = {
  too_many_comments: `GitHub takes at most ${MAX_REVIEW_COMMENTS} comments in one review; this list has more. Undo or dismiss some drafts, or delete some comments, to post.`,
  comment_too_long: `One of these comments is longer than GitHub allows (${MAX_REVIEW_BODY_CHARS.toLocaleString("en-US")} characters). Shorten it to post.`,
};

export const REFUSAL_TEXT: Record<Refusal, string> = {
  stale:
    "What you were about to post changed (a draft or comment was changed in another tab, or an earlier attempt settled). Nothing was posted. The list was loaded again: check it and submit once more.",
  head_moved:
    "New commits were pushed since you opened this. Nothing was posted. The list was loaded again for the new head: check it and submit once more.",
  in_progress:
    "An earlier attempt is still being confirmed with GitHub. Nothing was posted now. Check the pull request on GitHub, and try again in a minute.",
  key_reused:
    "This attempt could not be told apart from an earlier one. Nothing was posted. Try again.",
  no_revision:
    "Rocky has not mirrored this commit yet, so nothing can be posted. Try again in a moment.",
  token_unavailable:
    "Your GitHub sign-in is no longer valid, so nothing was posted. Sign in again to post.",
};

/** Why GitHub refused (ADR 0026 `ReviewPostDenial`); other codes show as themselves. */
const DENIAL_TEXT: Readonly<Record<string, string>> = {
  rejected:
    "GitHub rejected the review (for example a comment on a line that is not in the diff, or approving your own pull request).",
  forbidden:
    "GitHub refused the request (no write access to this repository, or a policy on the organisation).",
  token_rejected: "GitHub no longer accepts your sign-in. Sign in again to post.",
  not_found: "GitHub says there is no such pull request for you.",
};

/** Why the request was refused as invalid; other codes show as themselves. */
const INVALID_TEXT: Readonly<Record<string, string>> = {
  empty_review:
    "A Comment or Request changes review needs a summary or at least one comment. Write a summary, or pick Approve.",
  body_too_long: `The summary is too long for GitHub (${MAX_REVIEW_BODY_CHARS.toLocaleString("en-US")} characters at most).`,
  too_many_comments: `GitHub takes at most ${MAX_REVIEW_COMMENTS} comments in one review.`,
  comment_too_long: "One of the comments is longer than GitHub allows.",
};

/** When the page cannot tell whether the review was posted (review round 1, B1). */
export const UNKNOWN_TEXT =
  "Rocky got no usable answer, so the review may or may not have been posted. Check the pull request on GitHub. Submitting again is safe: it asks about the same attempt and never posts twice.";

/** What the modal says for an answer that did not post. `null` for a success. */
export const noticeFor = (outcome: SubmitOutcome): string | null => {
  switch (outcome.kind) {
    case "posted":
      return null;
    case "refused":
      return REFUSAL_TEXT[outcome.reason];
    case "invalid":
      return `Nothing was posted: ${INVALID_TEXT[outcome.reason] ?? `the request was refused (${outcome.reason}).`}`;
    case "post_failed":
      return `Nothing was posted. ${DENIAL_TEXT[outcome.reason] ?? `GitHub refused it (${outcome.reason}).`} Fix the cause and submit again.`;
    case "post_unknown":
      return "Rocky got no answer from GitHub, so the review may or may not have been posted. Check the pull request on GitHub. Rocky will reconcile this attempt in about a minute; until then it counts as in flight.";
    case "unknown":
      return outcome.status === 0
        ? `${UNKNOWN_TEXT} (The request did not complete.)`
        : `${UNKNOWN_TEXT} (Status ${outcome.status}.)`;
    case "not_sent":
      return "Rocky could not confirm your sign-in, so nothing was sent and nothing was posted. Check that you are signed in and try again.";
    case "not_found":
      return "This pull request is no longer available to you. Nothing was posted.";
    case "unavailable":
      return "Posting is not available on this server yet. Nothing was posted.";
    case "signed_out":
      return "You are signed out. Sign in again to post; nothing was posted.";
    case "error":
      return `Rocky refused the request (${outcome.status}). Nothing was posted. Reload the page and try again.`;
  }
};

/** A word for an attempt the server reports (the latest, or the one in flight). */
export const attemptText = (s: {
  readonly verdict: ReviewVerdict;
  readonly draftCount: number;
  readonly commentCount: number;
}): string => {
  const n = s.draftCount + s.commentCount;
  return n === 0
    ? `${VERDICT_LABEL[s.verdict]}, no inline comments`
    : `${VERDICT_LABEL[s.verdict]} with ${n} inline ${n === 1 ? "comment" : "comments"}`;
};
