import type { Finding } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import {
  canonicalReviewPlan,
  findingCommentBody,
  isReviewVerdict,
  MAX_REVIEW_BODY_CHARS,
  MAX_REVIEW_COMMENTS,
  REVIEW_VERDICTS,
  validateReviewSubmission,
  type ReviewPlanItem,
  type ReviewSubmission,
} from "./review-posting.js";

/** P3-5 (ADR 0026): the pure part of posting: canonical plan, validation, draft rendering. */

const HEAD = "a".repeat(40);

const item = (over: Partial<ReviewPlanItem> = {}): ReviewPlanItem => ({
  kind: "draft",
  id: "5d1e9f00-aaaa-4bcd-9e00-000000000001",
  path: "src/invite.ts",
  line: 12,
  startLine: null,
  body: "Validate the email first.",
  ...over,
});

const submission = (over: Partial<ReviewSubmission> = {}): ReviewSubmission => ({
  headSha: HEAD,
  verdict: "comment",
  body: "Looks fine overall.",
  comments: [{ path: "src/invite.ts", line: 12, startLine: null, body: "Check this." }],
  ...over,
});

describe("canonicalReviewPlan", () => {
  it("is deterministic and covers every field of every item, in order", () => {
    const a = canonicalReviewPlan(HEAD, [item(), item({ kind: "comment", id: "x", line: 13 })]);
    const b = canonicalReviewPlan(HEAD, [item(), item({ kind: "comment", id: "x", line: 13 })]);
    expect(a).toBe(b);
    expect(a).toContain(HEAD);
    for (const field of ["draft", "src/invite.ts", "12", "Validate the email first."]) {
      expect(a).toContain(field);
    }
    // Order matters (the user saw a list): a swap is a different plan.
    const swapped = canonicalReviewPlan(HEAD, [
      item({ kind: "comment", id: "x", line: 13 }),
      item(),
    ]);
    expect(swapped).not.toBe(a);
  });

  it("changes when any field changes (body, line, path, kind, id, head)", () => {
    const base = canonicalReviewPlan(HEAD, [item()]);
    const variants = [
      canonicalReviewPlan(HEAD, [item({ body: "Validate the email first" })]),
      canonicalReviewPlan(HEAD, [item({ line: 13 })]),
      canonicalReviewPlan(HEAD, [item({ startLine: 10 })]),
      canonicalReviewPlan(HEAD, [item({ path: "src/invite.tsx" })]),
      canonicalReviewPlan(HEAD, [item({ kind: "comment" })]),
      canonicalReviewPlan(HEAD, [item({ id: "5d1e9f00-aaaa-4bcd-9e00-000000000002" })]),
      canonicalReviewPlan("b".repeat(40), [item()]),
      canonicalReviewPlan(HEAD, []),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("cannot be confused by separators inside a body (JSON encoding, not string joining)", () => {
    const tricky = canonicalReviewPlan(HEAD, [item({ body: '"],["comment","x","p",1,null,"' })]);
    expect(() => JSON.parse(tricky)).not.toThrow();
    const parsed = JSON.parse(tricky) as { items: unknown[] };
    expect(parsed.items).toHaveLength(1);
  });
});

describe("findingCommentBody", () => {
  const finding: Finding = {
    id: "f-1",
    severity: "high",
    confidence: 0.9,
    path: "src/invite.ts",
    range: { start: 12, end: 14 },
    title: "Email is not validated",
    body: "The address goes straight to the mailer.\n\nUse the shared validator.",
    suggestion: { lines: ["const email = validateEmail(input.email);", "send(email);"] },
    memory: [],
    agentPrompt: "Validate the email with the shared validator before sending.",
  };

  it("renders title, body and a suggestion block the reviewer can see in full", () => {
    const body = findingCommentBody(finding);
    expect(body.startsWith("**Email is not validated**\n\n")).toBe(true);
    expect(body).toContain("The address goes straight to the mailer.");
    expect(body).toContain(
      "```suggestion\nconst email = validateEmail(input.email);\nsend(email);\n```",
    );
    // Nothing the person did not accept: no agent prompt, no severity, no confidence.
    expect(body).not.toContain("agentPrompt");
    expect(body).not.toContain("Validate the email with the shared validator before sending.");
    expect(body).not.toMatch(/high|0\.9/);
  });

  it("omits the suggestion block when there is none, and an empty suggestion deletes the range", () => {
    const plain = { ...finding };
    delete plain.suggestion;
    expect(findingCommentBody(plain)).toBe(
      "**Email is not validated**\n\nThe address goes straight to the mailer.\n\nUse the shared validator.",
    );
    expect(findingCommentBody({ ...finding, suggestion: { lines: [] } })).toContain(
      "```suggestion\n```",
    );
  });

  it("keeps a suggestion line that contains a fence from closing the block early", () => {
    const body = findingCommentBody({
      ...finding,
      suggestion: { lines: ["```", "x"] },
    });
    // A longer fence than any run of backticks inside: the block still contains both lines.
    expect(body).toMatch(/````suggestion\n```\nx\n````$/);
  });
});

describe("validateReviewSubmission", () => {
  it("accepts a well-formed submission", () => {
    expect(validateReviewSubmission(submission())).toEqual({ ok: true });
    expect(
      validateReviewSubmission(submission({ verdict: "approve", body: "", comments: [] })),
    ).toEqual({ ok: true });
    expect(
      validateReviewSubmission(
        submission({
          verdict: "request_changes",
          body: "",
          comments: [{ path: "a.ts", line: 3, startLine: 1, body: "x" }],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("refuses an unknown verdict", () => {
    expect(validateReviewSubmission(submission({ verdict: "APPROVE" as never }))).toEqual({
      ok: false,
      reason: "invalid_verdict",
    });
    expect(isReviewVerdict("approve")).toBe(true);
    expect(isReviewVerdict("APPROVE")).toBe(false);
    expect(REVIEW_VERDICTS).toEqual(["approve", "request_changes", "comment"]);
  });

  it("refuses a comment or request-changes review that says nothing", () => {
    for (const verdict of ["comment", "request_changes"] as const) {
      expect(validateReviewSubmission(submission({ verdict, body: "", comments: [] }))).toEqual({
        ok: false,
        reason: "empty_review",
      });
      expect(
        validateReviewSubmission(submission({ verdict, body: "  \n\t ", comments: [] })),
      ).toEqual({ ok: false, reason: "empty_review" });
    }
  });

  it("refuses a malformed head sha", () => {
    for (const headSha of ["", "A".repeat(40), "a".repeat(39), "a".repeat(41), "g".repeat(40)]) {
      expect(validateReviewSubmission(submission({ headSha }))).toEqual({
        ok: false,
        reason: "invalid_head",
      });
    }
  });

  it("bounds the body and the number of comments", () => {
    expect(
      validateReviewSubmission(submission({ body: "x".repeat(MAX_REVIEW_BODY_CHARS) })),
    ).toEqual({ ok: true });
    expect(
      validateReviewSubmission(submission({ body: "x".repeat(MAX_REVIEW_BODY_CHARS + 1) })),
    ).toEqual({ ok: false, reason: "body_too_long" });
    const many = Array.from({ length: MAX_REVIEW_COMMENTS + 1 }, (_, i) => ({
      path: "a.ts",
      line: i + 1,
      startLine: null,
      body: "x",
    }));
    expect(validateReviewSubmission(submission({ comments: many }))).toEqual({
      ok: false,
      reason: "too_many_comments",
    });
    expect(validateReviewSubmission(submission({ comments: many.slice(1) }))).toEqual({
      ok: true,
    });
  });

  it("refuses a comment with an empty or oversized body, a bad path, or a bad line", () => {
    const bad = (comment: Partial<ReviewSubmission["comments"][number]>) =>
      validateReviewSubmission(
        submission({
          comments: [{ path: "a.ts", line: 3, startLine: null, body: "x", ...comment }],
        }),
      );
    expect(bad({ body: "" })).toEqual({ ok: false, reason: "empty_comment" });
    expect(bad({ body: " \n" })).toEqual({ ok: false, reason: "empty_comment" });
    expect(bad({ body: "x".repeat(MAX_REVIEW_BODY_CHARS + 1) })).toEqual({
      ok: false,
      reason: "comment_too_long",
    });
    for (const path of ["", "/abs.ts", "../x.ts", "a/../b.ts", "a//b.ts", "a\\b.ts", "a\0.ts"]) {
      expect(bad({ path }), path).toEqual({ ok: false, reason: "invalid_path" });
    }
    for (const line of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001]) {
      expect(bad({ line }), String(line)).toEqual({ ok: false, reason: "invalid_line" });
    }
    expect(bad({ startLine: 4 })).toEqual({ ok: false, reason: "invalid_line" });
    expect(bad({ startLine: 3 })).toEqual({ ok: false, reason: "invalid_line" });
    expect(bad({ startLine: 0 })).toEqual({ ok: false, reason: "invalid_line" });
    expect(bad({ startLine: 2 })).toEqual({ ok: true });
  });

  it("refuses non-object input and wrong field types without throwing", () => {
    for (const value of [null, undefined, "x", 1, [], { headSha: HEAD }]) {
      expect(validateReviewSubmission(value as never).ok).toBe(false);
    }
    expect(validateReviewSubmission(submission({ comments: "x" as never }))).toEqual({
      ok: false,
      reason: "invalid_comments",
    });
    expect(validateReviewSubmission(submission({ body: 1 as never }))).toEqual({
      ok: false,
      reason: "invalid_body",
    });
  });
});
