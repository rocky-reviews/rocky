/**
 * Test helpers for the drafts (P6-4): a review context with a given state, for static renders,
 * and an in-memory `ReviewSource` that answers like the server (same transitions, from core).
 * Not imported by the app.
 */
import {
  applyDraftAction,
  DRAFT,
  type DraftAction,
  type DraftDecision,
} from "@rocky-reviews/core/drafts";
import type { Finding } from "@rocky-reviews/schema";
import type { DraftRecord, ReviewSource, ReviewState } from "../data/review-data.js";
import type { OwnComment, PostedState } from "../diff/diff-model.js";
import { NO_REVIEW, type ReviewContextValue } from "./ReviewProvider.js";

export const reviewWith = (
  findings: readonly Finding[],
  decisions: Readonly<Record<string, DraftDecision>> = {},
  comments: readonly OwnComment[] = [],
  extra: Partial<ReviewContextValue> = {},
  /** Drafts carried by a review attempt (P6-6). */
  posted: Readonly<Record<string, PostedState>> = {},
): ReviewContextValue => {
  const drafts = new Map<string, DraftRecord>(
    Object.entries(decisions).map(([findingId, decision]) => [
      findingId,
      { findingId, decision, agentPromptCopiedAt: null, posted: posted[findingId] ?? null },
    ]),
  );
  const state: ReviewState = { drafts, comments };
  return {
    ...NO_REVIEW,
    status: "ready",
    findings,
    state,
    decisionOf: (id) => drafts.get(id)?.decision ?? DRAFT,
    ...extra,
  };
};

type Wire = {
  findingId: string;
  state: DraftDecision["state"];
  reason: string | null;
  edited: boolean;
  body: string | null;
  agentPromptCopiedAt: string | null;
  posted: PostedState;
};

const wire = (findingId: string, decision: DraftDecision, copiedAt: string | null): Wire => ({
  findingId,
  state: decision.state,
  reason: decision.state === "dismissed" ? decision.reason : null,
  edited: decision.state === "accepted" && decision.edited,
  body: decision.state === "accepted" ? decision.body : null,
  agentPromptCopiedAt: copiedAt,
  posted: null,
});

/** The server's behaviour in memory: what the e2e mock and the provider tests rely on. */
export const memoryReviewSource = (
  findings: readonly Finding[],
  options: { fail?: () => boolean } = {},
): ReviewSource & { readonly calls: string[] } => {
  const decisions = new Map<string, { decision: DraftDecision; copiedAt: string | null }>();
  const comments: OwnComment[] = [];
  const calls: string[] = [];
  let next = 1;
  const check = () => {
    if (options.fail?.() === true) throw new Error("offline");
  };
  return {
    calls,
    load: async () => {
      calls.push("load");
      check();
      return {
        drafts: [...decisions]
          .filter(([, d]) => d.decision.state !== "draft" || d.copiedAt !== null)
          .map(([id, d]) => wire(id, d.decision, d.copiedAt)),
        comments: [...comments],
      };
    },
    decide: async (_analysisId: string, findingId: string, action: DraftAction) => {
      calls.push(`decide ${findingId} ${action.kind}`);
      check();
      const finding = findings.find((f) => f.id === findingId);
      if (finding === undefined) throw new Error("404");
      const current = decisions.get(findingId) ?? { decision: DRAFT, copiedAt: null };
      const t = applyDraftAction(current.decision, action, finding);
      if (!t.ok)
        return { kind: "conflict", draft: wire(findingId, current.decision, current.copiedAt) };
      const copiedAt = t.agentPromptCopied ? new Date(0).toISOString() : current.copiedAt;
      decisions.set(findingId, { decision: t.next, copiedAt });
      return { kind: "ok", draft: wire(findingId, t.next, copiedAt) };
    },
    addComment: async (_analysisId, comment) => {
      calls.push(`add ${comment.path}:${comment.line}`);
      check();
      const saved: OwnComment = {
        id: `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
        ...comment,
        body: comment.body.trim(),
        posted: null,
      };
      comments.push(saved);
      return saved;
    },
    deleteComment: async (_analysisId, id) => {
      calls.push(`delete ${id}`);
      check();
      const at = comments.findIndex((c) => c.id === id);
      if (at !== -1) comments.splice(at, 1);
      return "deleted";
    },
  };
};
