/**
 * Posting the review as the user (P6-6 over P3-5, ADR 0026 and ADR 0031): the port the finish
 * modal reads the exact list to post through, and the checks on what the server answers.
 *
 * `GET /api/pull-requests/:id/review` is the only source of the list: the server builds it,
 * the modal shows every item's body exactly as it comes back (that is the markdown GitHub will
 * receive), and the click echoes the list's digest and head. Everything in an answer is
 * PR-shaped, untrusted text; components render it as text, never as HTML or markdown.
 */
import {
  isReviewVerdict,
  MAX_REVIEW_BODY_CHARS,
  MAX_REVIEW_COMMENTS,
  type ReviewVerdict,
} from "@rocky-reviews/core";
import { z } from "zod";

export type { ReviewVerdict };

/** One thing that will be posted, as the server will post it. */
export type PreviewItem = {
  readonly kind: "draft" | "comment";
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly startLine: number | null;
  /** The exact markdown GitHub will receive. */
  readonly body: string;
};

/** A review attempt as the server reports it: ids, status, counts and times; never content. */
export type SubmissionSummary = {
  readonly submissionId: string;
  readonly status: "posting" | "posted" | "failed";
  readonly verdict: ReviewVerdict;
  readonly draftCount: number;
  readonly commentCount: number;
  readonly reviewId: number | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
};

export type ReviewPreview = {
  readonly pullRequestId: string;
  readonly number: number;
  readonly headSha: string;
  /** False while the mirror holds no revision for the head: nothing can be posted yet. */
  readonly revisionKnown: boolean;
  /** Hex digest of the list; echoed back so the server refuses a list that changed. */
  readonly contentSha256: string;
  readonly items: readonly PreviewItem[];
  /** The member's attempt still being posted or reconciled, if any (its items are not listed). */
  readonly inFlight: SubmissionSummary | null;
  readonly latestSubmission: SubmissionSummary | null;
};

export type SubmitInput = {
  /** A fresh uuid per click: the same click again answers the same, never posts twice. */
  readonly idempotencyKey: string;
  readonly contentSha256: string;
  readonly headSha: string;
  readonly verdict: ReviewVerdict;
  readonly body: string;
};

/** An HTTP answer, unchecked: the parsers below turn it into an outcome. */
export type Answer = { readonly status: number; readonly body: unknown };

/** The port. Sources return unchecked answers; the page parses them with the functions below. */
export interface ReviewPostingSource {
  preview(pullRequestId: string, options?: { signal?: AbortSignal }): Promise<Answer>;
  submit(pullRequestId: string, input: SubmitInput): Promise<Answer>;
}

export type PreviewOutcome =
  | { readonly kind: "ok"; readonly preview: ReviewPreview }
  /** The pull request is unknown here, or GitHub no longer lets this person read it. */
  | { readonly kind: "not_found" }
  /** The server cannot post yet (no repository access check wired). */
  | { readonly kind: "unavailable" }
  | { readonly kind: "signed_out" }
  /** Any other status, or an answer that does not parse. */
  | { readonly kind: "error"; readonly status: number };

/** Why the server refused the click before posting anything (ADR 0026 §6). */
export const REFUSALS = [
  "stale",
  "head_moved",
  "in_progress",
  "key_reused",
  "no_revision",
  "token_unavailable",
] as const;
export type Refusal = (typeof REFUSALS)[number];

export type SubmitOutcome =
  | {
      readonly kind: "posted";
      readonly submissionId: string;
      readonly reviewId: number;
      /** The same click was answered before: nothing was posted this time. */
      readonly repeated: boolean;
    }
  | { readonly kind: "refused"; readonly reason: Refusal }
  /** The request was malformed or the review says nothing (`empty_review`); nothing posted. */
  | { readonly kind: "invalid"; readonly reason: string }
  /** GitHub refused the review; nothing posted, the items are offered again. */
  | { readonly kind: "post_failed"; readonly reason: string }
  /** No usable answer from GitHub: the review may exist; the attempt stays in flight. */
  | { readonly kind: "post_unknown" }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "signed_out" }
  | { readonly kind: "error"; readonly status: number };

/** A fixed server code (ADR 0026): never free text, so it can be shown and matched safely. */
const Code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Uuid = z.uuid();

const Summary = z.object({
  submissionId: Uuid,
  status: z.enum(["posting", "posted", "failed"]),
  verdict: z.string().refine(isReviewVerdict),
  draftCount: z.number().int().min(0),
  commentCount: z.number().int().min(0),
  reviewId: z.number().int().positive().nullable(),
  errorCode: Code.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

const Item = z.object({
  kind: z.enum(["draft", "comment"]),
  id: Uuid,
  path: z.string().min(1).max(1024),
  line: z.number().int().min(1),
  startLine: z.number().int().min(1).nullable(),
  body: z.string().min(1).max(MAX_REVIEW_BODY_CHARS),
});

const Preview = z.object({
  pullRequestId: Uuid,
  number: z.number().int().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  revisionKnown: z.boolean(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(Item).max(MAX_REVIEW_COMMENTS),
  inFlight: Summary.nullable(),
  latestSubmission: Summary.nullable(),
});

const Posted = z.object({
  status: z.literal("posted"),
  submissionId: Uuid,
  reviewId: z.number().int().positive(),
  repeated: z.boolean(),
});

const Error = z.object({ error: Code, reason: Code.optional() });

export class PostingDataError extends globalThis.Error {
  override readonly name = "PostingDataError";
}

/** The exact list, checked field by field; errors name a field, never a value. */
export const parseReviewPreview = (input: unknown): ReviewPreview => {
  const raw = Preview.safeParse(input);
  if (!raw.success) throw new PostingDataError("invalid review preview");
  const verdictOf = (s: z.infer<typeof Summary> | null): SubmissionSummary | null =>
    s === null ? null : { ...s, verdict: s.verdict as ReviewVerdict };
  return {
    ...raw.data,
    inFlight: verdictOf(raw.data.inFlight),
    latestSubmission: verdictOf(raw.data.latestSubmission),
  };
};

export const previewOutcome = (answer: Answer): PreviewOutcome => {
  switch (answer.status) {
    case 200:
      try {
        return { kind: "ok", preview: parseReviewPreview(answer.body) };
      } catch {
        return { kind: "error", status: 200 };
      }
    case 401:
      return { kind: "signed_out" };
    case 404:
      return { kind: "not_found" };
    case 503:
      return { kind: "unavailable" };
    default:
      return { kind: "error", status: answer.status };
  }
};

const isRefusal = (code: string): code is Refusal => (REFUSALS as readonly string[]).includes(code);

/** The click's answer as an outcome (ADR 0026 §6). Unknown codes are errors, never successes. */
export const submitOutcome = (answer: Answer): SubmitOutcome => {
  const { status } = answer;
  if (status === 200) {
    const posted = Posted.safeParse(answer.body);
    return posted.success
      ? {
          kind: "posted",
          submissionId: posted.data.submissionId,
          reviewId: posted.data.reviewId,
          repeated: posted.data.repeated,
        }
      : { kind: "error", status };
  }
  if (status === 401) return { kind: "signed_out" };
  if (status === 404) return { kind: "not_found" };
  if (status === 503) return { kind: "unavailable" };
  const error = Error.safeParse(answer.body);
  if (!error.success) return { kind: "error", status };
  const { error: code, reason } = error.data;
  if (status === 400 && code === "invalid_request")
    return { kind: "invalid", reason: reason ?? code };
  if (status === 409 && isRefusal(code)) return { kind: "refused", reason: code };
  if (status === 502 && code === "post_failed")
    return { kind: "post_failed", reason: reason ?? code };
  if (status === 502 && code === "post_unknown") return { kind: "post_unknown" };
  return { kind: "error", status };
};
