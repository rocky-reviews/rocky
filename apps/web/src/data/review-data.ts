/**
 * The reviewer's drafts and own comments (P6-4, ADR 0027), and the port the page reads and writes
 * them through. The server keeps them (`/api/analyses/:id/review`), so a reload shows the same
 * review; `review-http-source.ts` implements the port.
 *
 * Answers are checked here, in one place, before the page uses them. Bodies are the reviewer's
 * own text and stay text: components render them as React text, never as HTML.
 */
import {
  DISMISS_REASONS,
  type DismissReason,
  type DraftAction,
  type DraftDecision,
  MAX_COMMENT_BODY,
} from "@rocky-reviews/core/drafts";
import { z } from "zod";
import type { OwnComment } from "../diff/diff-model.js";

/** What the server keeps about one draft for this reviewer. */
export type DraftRecord = {
  readonly findingId: string;
  readonly decision: DraftDecision;
  /** "Send to agent" was used; ISO time. */
  readonly agentPromptCopiedAt: string | null;
};

export type ReviewState = {
  /** Only drafts with a decision or a copied prompt; every other finding is an undecided draft. */
  readonly drafts: ReadonlyMap<string, DraftRecord>;
  readonly comments: readonly OwnComment[];
};

export const EMPTY_REVIEW: ReviewState = { drafts: new Map(), comments: [] };

/** The port. Sources return unchecked JSON; the page parses it with the functions below. */
export interface ReviewSource {
  load(analysisId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  /** `conflict`: another tab decided first; `draft` is the state the server has. */
  decide(
    analysisId: string,
    findingId: string,
    action: DraftAction,
  ): Promise<{ readonly kind: "ok" | "conflict"; readonly draft: unknown }>;
  addComment(
    analysisId: string,
    comment: { readonly path: string; readonly line: number; readonly body: string },
  ): Promise<unknown>;
  deleteComment(analysisId: string, commentId: string): Promise<void>;
}

export class ReviewDataError extends Error {
  override readonly name = "ReviewDataError";
}

const Body = z.string().min(1).max(MAX_COMMENT_BODY);
const FindingId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);

const RawDraft = z.object({
  findingId: FindingId,
  state: z.enum(["draft", "accepted", "dismissed"]),
  reason: z.enum(DISMISS_REASONS).nullable(),
  edited: z.boolean(),
  body: Body.nullable(),
  agentPromptCopiedAt: z.iso.datetime().nullable(),
});

const RawComment = z.object({
  id: z.uuid(),
  path: z.string().min(1).max(4096),
  line: z.number().int().min(1),
  body: Body,
});

const RawReview = z.object({
  drafts: z.array(RawDraft).max(1000),
  comments: z.array(RawComment).max(5000),
});

const decisionOf = (raw: z.infer<typeof RawDraft>): DraftDecision | null => {
  switch (raw.state) {
    case "draft":
      return { state: "draft" };
    case "accepted":
      return raw.body === null ? null : { state: "accepted", edited: raw.edited, body: raw.body };
    case "dismissed":
      return raw.reason === null
        ? null
        : { state: "dismissed", reason: raw.reason as DismissReason };
  }
};

/** Errors name a field, never a value (values are the reviewer's text). */
export const parseDraftRecord = (input: unknown): DraftRecord => {
  const raw = RawDraft.safeParse(input);
  if (!raw.success) throw new ReviewDataError("invalid draft");
  const decision = decisionOf(raw.data);
  if (decision === null) throw new ReviewDataError("invalid draft state");
  return {
    findingId: raw.data.findingId,
    decision,
    agentPromptCopiedAt: raw.data.agentPromptCopiedAt,
  };
};

export const parseOwnComment = (input: unknown): OwnComment => {
  const raw = RawComment.safeParse(input);
  if (!raw.success) throw new ReviewDataError("invalid comment");
  return raw.data;
};

export const parseReviewState = (input: unknown): ReviewState => {
  const raw = RawReview.safeParse(input);
  if (!raw.success) throw new ReviewDataError("invalid review state");
  return {
    drafts: new Map(raw.data.drafts.map((d) => [d.findingId, parseDraftRecord(d)])),
    comments: raw.data.comments.map(parseOwnComment),
  };
};
