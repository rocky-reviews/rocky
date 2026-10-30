import { describe, expect, it } from "vitest";
import {
  applyDraftAction,
  composePostedComment,
  DISMISS_REASONS,
  isDismissReason,
  MAX_COMMENT_BODY,
  normaliseCommentBody,
  parseDraftAction,
  postedCommentParts,
  type DraftAction,
  type DraftDecision,
} from "./drafts.js";

/**
 * P6-4 acceptance criterion "all transitions tested" (ADR 0027): every action from every state,
 * written out, so a change to the state machine shows here.
 */

const FINDING = { body: "`requestedRole` overrides the invited role." };
const DRAFT: DraftDecision = { state: "draft" };
const ACCEPTED: DraftDecision = { state: "accepted", edited: false, body: FINDING.body };
const EDITED: DraftDecision = { state: "accepted", edited: true, body: "My words." };
const DISMISSED: DraftDecision = { state: "dismissed", reason: "intentional" };

const ACTIONS: Record<string, DraftAction> = {
  accept: { kind: "accept" },
  edit: { kind: "edit", body: "  Use invite.role here.  " },
  dismiss: { kind: "dismiss", reason: "not_an_issue" },
  undo: { kind: "undo" },
  send_to_agent: { kind: "send_to_agent" },
};

type Expected = DraftDecision | "invalid_transition";

/** state × action → next state (or refused). */
const TABLE: Record<string, [DraftDecision, Record<keyof typeof ACTIONS, Expected>]> = {
  draft: [
    DRAFT,
    {
      accept: ACCEPTED,
      edit: { state: "accepted", edited: true, body: "Use invite.role here." },
      dismiss: { state: "dismissed", reason: "not_an_issue" },
      undo: "invalid_transition",
      send_to_agent: DRAFT,
    },
  ],
  accepted: [
    ACCEPTED,
    {
      accept: "invalid_transition",
      edit: "invalid_transition",
      dismiss: "invalid_transition",
      undo: DRAFT,
      send_to_agent: "invalid_transition",
    },
  ],
  "accepted (edited)": [
    EDITED,
    {
      accept: "invalid_transition",
      edit: "invalid_transition",
      dismiss: "invalid_transition",
      undo: DRAFT,
      send_to_agent: "invalid_transition",
    },
  ],
  dismissed: [
    DISMISSED,
    {
      accept: "invalid_transition",
      edit: "invalid_transition",
      dismiss: "invalid_transition",
      undo: DRAFT,
      send_to_agent: "invalid_transition",
    },
  ],
};

describe("applyDraftAction (every state × every action)", () => {
  for (const [name, [from, row]] of Object.entries(TABLE)) {
    for (const [action, expected] of Object.entries(row)) {
      it(`${name} --${action}--> ${typeof expected === "string" ? expected : expected.state}`, () => {
        const result = applyDraftAction(from, ACTIONS[action]!, FINDING);
        if (expected === "invalid_transition") {
          expect(result).toEqual({ ok: false, error: "invalid_transition" });
        } else {
          expect(result).toEqual({
            ok: true,
            next: expected,
            agentPromptCopied: action === "send_to_agent",
          });
        }
      });
    }
  }

  it("accept keeps the finding's own body; edit keeps the reviewer's (trimmed)", () => {
    const accepted = applyDraftAction(DRAFT, { kind: "accept" }, { body: "AI text" });
    expect(accepted.ok && accepted.next).toEqual({
      state: "accepted",
      edited: false,
      body: "AI text",
    });
  });

  it("refuses an edit whose body is empty, too long or holds a NUL (no transition)", () => {
    for (const body of ["", "   \n\t ", "a".repeat(MAX_COMMENT_BODY + 1), "a\u0000b"]) {
      expect(applyDraftAction(DRAFT, { kind: "edit", body }, FINDING)).toEqual({
        ok: false,
        error: "invalid_body",
      });
    }
  });

  it("an undo clears the reason and the edited body: a later accept starts from the AI text", () => {
    const undone = applyDraftAction(EDITED, { kind: "undo" }, FINDING);
    expect(undone).toEqual({ ok: true, next: DRAFT, agentPromptCopied: false });
    const again = applyDraftAction(DRAFT, { kind: "accept" }, FINDING);
    expect(again.ok && again.next).toEqual(ACCEPTED);
  });
});

describe("parseDraftAction (untrusted request bodies)", () => {
  it("reads every documented action", () => {
    expect(parseDraftAction({ action: "accept" })).toEqual({ kind: "accept" });
    expect(parseDraftAction({ action: "undo" })).toEqual({ kind: "undo" });
    expect(parseDraftAction({ action: "send_to_agent" })).toEqual({ kind: "send_to_agent" });
    expect(parseDraftAction({ action: "edit", body: "x" })).toEqual({ kind: "edit", body: "x" });
    for (const reason of DISMISS_REASONS) {
      expect(parseDraftAction({ action: "dismiss", reason })).toEqual({ kind: "dismiss", reason });
    }
  });

  it("refuses anything else: unknown actions, free-text reasons, missing or wrong-typed fields", () => {
    for (const input of [
      null,
      undefined,
      "accept",
      [],
      {},
      { action: "approve" },
      { action: "ACCEPT" },
      { action: "dismiss" },
      { action: "dismiss", reason: "I just don't like it" },
      { action: "dismiss", reason: "toString" },
      { action: "edit" },
      { action: "edit", body: 42 },
      { action: "__proto__" },
      Object.create({ action: "accept" }),
    ]) {
      expect(parseDraftAction(input), JSON.stringify(input) ?? String(input)).toBeNull();
    }
  });

  it("ignores extra fields (a client cannot smuggle a location, a state or an author)", () => {
    expect(
      parseDraftAction({
        action: "accept",
        path: "/etc/passwd",
        state: "dismissed",
        memberId: "x",
      }),
    ).toEqual({ kind: "accept" });
  });
});

describe("dismiss reasons and comment bodies", () => {
  it("has exactly the POC's four reasons, as fixed codes", () => {
    expect(DISMISS_REASONS).toEqual([
      "not_an_issue",
      "intentional",
      "not_worth_it",
      "handled_elsewhere",
    ]);
    expect(isDismissReason("intentional")).toBe(true);
    expect(isDismissReason("hasOwnProperty")).toBe(false);
    expect(isDismissReason(1)).toBe(false);
  });

  it("normalises a body: trimmed, not empty, at most GitHub's limit, no NUL", () => {
    expect(normaliseCommentBody("  ok \n")).toBe("ok");
    expect(normaliseCommentBody("a".repeat(MAX_COMMENT_BODY))).toHaveLength(MAX_COMMENT_BODY);
    expect(normaliseCommentBody(` ${"a".repeat(MAX_COMMENT_BODY)} `)).toHaveLength(
      MAX_COMMENT_BODY,
    );
    expect(normaliseCommentBody("a".repeat(MAX_COMMENT_BODY + 1))).toBeNull();
    expect(normaliseCommentBody("")).toBeNull();
    expect(normaliseCommentBody("x\u0000")).toBeNull();
    expect(normaliseCommentBody(7)).toBeNull();
  });
});

describe("what an accepted draft posts (one format for the card, P3-5 and P6-6)", () => {
  const finding = {
    title: "Email is not validated",
    body: "The address goes straight to the mailer.\n\nUse the shared validator.",
    suggestion: { lines: ["const email = validateEmail(input.email);", "send(email);"] },
  };

  it("is the title, the pending comment's body and the suggestion block", () => {
    expect(postedCommentParts(finding, { body: finding.body })).toEqual({
      title: "Email is not validated",
      body: finding.body,
      suggestion: ["const email = validateEmail(input.email);", "send(email);"],
    });
    expect(composePostedComment(finding, { body: finding.body })).toBe(
      "**Email is not validated**\n\nThe address goes straight to the mailer.\n\nUse the shared validator." +
        "\n\n```suggestion\nconst email = validateEmail(input.email);\nsend(email);\n```",
    );
  });

  it("an edit replaces the body only; the title and the suggestion stay", () => {
    const posted = composePostedComment(finding, { body: "Validate it first." });
    expect(posted).toBe(
      "**Email is not validated**\n\nValidate it first.\n\n```suggestion\nconst email = validateEmail(input.email);\nsend(email);\n```",
    );
  });

  it("never carries severity, confidence or the agent prompt, even when the finding has them", () => {
    const full = {
      ...finding,
      severity: "high",
      confidence: 91,
      agentPrompt: "Do the secret thing.",
    };
    const posted = composePostedComment(full, { body: full.body });
    expect(posted).not.toMatch(/high|91|secret thing/);
  });

  it("no suggestion: no block; an empty suggestion deletes the range", () => {
    const plain = { title: finding.title, body: finding.body };
    expect(postedCommentParts(plain, { body: "b" }).suggestion).toBeNull();
    expect(composePostedComment(plain, { body: "b" })).toBe("**Email is not validated**\n\nb");
    expect(composePostedComment({ ...finding, suggestion: { lines: [] } }, { body: "b" })).toBe(
      "**Email is not validated**\n\nb\n\n```suggestion\n```",
    );
  });

  it("a suggestion line with a fence cannot close the block early", () => {
    const posted = composePostedComment(
      { ...finding, suggestion: { lines: ["```", "x"] } },
      { body: "b" },
    );
    expect(posted).toMatch(/\n\n````suggestion\n```\nx\n````$/);
  });
});
