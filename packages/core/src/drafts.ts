/**
 * AI drafts and what the reviewer decides about each (P6-4, ADR 0027). A draft is one finding of
 * an analysis document, seen by one reviewer; only that reviewer's decision moves it:
 *
 *   draft ──accept──────────▶ accepted (the finding's body)       ──undo──▶ draft
 *   draft ──edit(body)──────▶ accepted (edited: the reviewer's body) ──undo──▶ draft
 *   draft ──dismiss(reason)─▶ dismissed (a fixed reason code)      ──undo──▶ draft
 *   draft ──send_to_agent───▶ draft (the fix prompt was copied; noted, nothing else changes)
 *
 * Anything else is `invalid_transition`: a stale tab acting on a draft another tab decided gets
 * a refusal and the current state, never a silent overwrite. Pure: the server applies it inside
 * the transaction that holds the row lock, and the web app applies it optimistically.
 *
 * Nothing here posts. An accepted draft becomes a pending comment that only Finish review
 * (P6-6, P3-5) submits, after the reviewer's explicit action.
 */

/** Why a draft was dismissed: fixed codes (no free text, so nothing personal is stored). */
export const DISMISS_REASONS = [
  "not_an_issue",
  "intentional",
  "not_worth_it",
  "handled_elsewhere",
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export const isDismissReason = (value: unknown): value is DismissReason =>
  typeof value === "string" && (DISMISS_REASONS as readonly string[]).includes(value);

/** GitHub's limit for a review comment body. */
export const MAX_COMMENT_BODY = 65_536;

export type DraftDecision =
  | { readonly state: "draft" }
  | { readonly state: "accepted"; readonly edited: boolean; readonly body: string }
  | { readonly state: "dismissed"; readonly reason: DismissReason };

export type DraftState = DraftDecision["state"];

export type DraftAction =
  | { readonly kind: "accept" }
  | { readonly kind: "edit"; readonly body: string }
  | { readonly kind: "dismiss"; readonly reason: DismissReason }
  | { readonly kind: "undo" }
  | { readonly kind: "send_to_agent" };

export type DraftActionKind = DraftAction["kind"];

export type DraftTransition =
  | {
      readonly ok: true;
      readonly next: DraftDecision;
      /** True for `send_to_agent`: the caller records when the fix prompt was copied. */
      readonly agentPromptCopied: boolean;
    }
  | { readonly ok: false; readonly error: "invalid_transition" | "invalid_body" };

/** Trimmed, 1..MAX_COMMENT_BODY characters, no NUL (Postgres text refuses it); else `null`. */
export const normaliseCommentBody = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > MAX_COMMENT_BODY || text.includes("\u0000")) return null;
  return text;
};

export const DRAFT: DraftDecision = Object.freeze({ state: "draft" });

export const applyDraftAction = (
  current: DraftDecision,
  action: DraftAction,
  finding: { readonly body: string },
): DraftTransition => {
  const refuse: DraftTransition = { ok: false, error: "invalid_transition" };
  const to = (next: DraftDecision, agentPromptCopied = false): DraftTransition => ({
    ok: true,
    next,
    agentPromptCopied,
  });
  if (action.kind === "undo") return current.state === "draft" ? refuse : to(DRAFT);
  if (current.state !== "draft") return refuse;
  switch (action.kind) {
    case "accept":
      return to({ state: "accepted", edited: false, body: finding.body });
    case "edit": {
      const body = normaliseCommentBody(action.body);
      if (body === null) return { ok: false, error: "invalid_body" };
      return to({ state: "accepted", edited: true, body });
    }
    case "dismiss":
      return to({ state: "dismissed", reason: action.reason });
    case "send_to_agent":
      return to(DRAFT, true);
  }
};

const field = (input: object, name: string): unknown =>
  Object.hasOwn(input, name) ? (input as Record<string, unknown>)[name] : undefined;

/**
 * Reads an action from an untrusted request body: `{ action, body?, reason? }`. Extra fields are
 * ignored (the location, author and state never come from the client). `null` when malformed.
 * An edit's body is checked by `applyDraftAction` (`invalid_body`), not here.
 */
export const parseDraftAction = (input: unknown): DraftAction | null => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const kind = field(input, "action");
  switch (kind) {
    case "accept":
    case "undo":
    case "send_to_agent":
      return { kind };
    case "edit": {
      const body = field(input, "body");
      return typeof body === "string" ? { kind, body } : null;
    }
    case "dismiss": {
      const reason = field(input, "reason");
      return isDismissReason(reason) ? { kind, reason } : null;
    }
    default:
      return null;
  }
};

/** What an accepted draft posts, in parts: the accepted card shows exactly these. */
export interface PostedCommentParts {
  readonly title: string;
  /** The pending comment's body: the finding's, or the reviewer's edit. */
  readonly body: string;
  /** The suggested lines (an empty list deletes the range), or `null` without a suggestion. */
  readonly suggestion: readonly string[] | null;
}

/**
 * An accepted draft as posted: the finding's title and suggestion with the pending comment's
 * body (`comments_pending.body`). An edit replaces the body only. Nothing the reviewer did not
 * see on the card: no severity, no confidence, no agent prompt.
 */
export const postedCommentParts = (
  finding: {
    readonly title: string;
    readonly suggestion?: { readonly lines: readonly string[] } | undefined;
  },
  pending: { readonly body: string },
): PostedCommentParts => ({
  title: finding.title,
  body: pending.body,
  suggestion: finding.suggestion === undefined ? null : [...finding.suggestion.lines],
});

const longestBacktickRun = (lines: readonly string[]): number =>
  Math.max(0, ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length))));

/**
 * The markdown Finish review (P6-6, P3-5) posts for an accepted draft: `**title**`, the body, and
 * the suggestion as a block the forge can apply. The fence is longer than any backtick run in
 * the suggestion, so its content cannot close the block early.
 */
export const composePostedComment = (
  finding: Parameters<typeof postedCommentParts>[0],
  pending: { readonly body: string },
): string => {
  const { title, body, suggestion } = postedCommentParts(finding, pending);
  const parts = [`**${title}**`, body];
  if (suggestion !== null) {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(suggestion) + 1));
    parts.push(`${fence}suggestion\n${suggestion.map((l) => `${l}\n`).join("")}${fence}`);
  }
  return parts.join("\n\n");
};
