import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { describe, expect, it } from "vitest";
import type { PreviewItem } from "../data/posting-data.js";
import type { DraftRecord, ReviewState } from "../data/review-data.js";
import { sidebarGroups } from "../shell/triage-model.js";
import {
  attemptText,
  draftSummary,
  invisibleCodes,
  isUndecided,
  itemLead,
  itemLocation,
  myReviewOf,
  revealInvisible,
  noticeFor,
  pendingCount,
  seriousAccepted,
  suggestVerdict,
  undecidedCount,
  unviewedHighRisk,
} from "./finish-model.js";

/** P6-6 (ADR 0031): the modal's warnings, suggestions and words, without a DOM. */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const doc = parsed.value;
const groups = sidebarGroups(doc);

const record = (
  findingId: string,
  state: "accepted" | "dismissed" | "draft",
  posted: DraftRecord["posted"] = null,
): DraftRecord => ({
  findingId,
  decision:
    state === "accepted"
      ? { state, edited: false, body: "x" }
      : state === "dismissed"
        ? { state, reason: "intentional" }
        : { state },
  agentPromptCopiedAt: null,
  posted,
});

const stateOf = (drafts: DraftRecord[], comments: ReviewState["comments"] = []): ReviewState => ({
  drafts: new Map(drafts.map((d) => [d.findingId, d])),
  comments,
});

const item = (over: Partial<PreviewItem> = {}): PreviewItem => ({
  kind: "draft",
  id: "6f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c",
  path: "src/auth/invitations.ts",
  line: 28,
  startLine: null,
  body: "**Invitee can choose their own role**\n\nThe body.",
  ...over,
});

describe("coverage warning", () => {
  it("names the critical and important files not marked viewed, in sidebar order", () => {
    expect(unviewedHighRisk(groups, new Set())).toEqual([
      "src/auth/invitations.ts",
      "src/api/routes/invitations.ts",
      "db/migrations/20261020_add_invitations.sql",
      "src/jobs/sendInviteEmail.ts",
    ]);
    expect(
      unviewedHighRisk(groups, new Set(["src/auth/invitations.ts", "src/jobs/sendInviteEmail.ts"])),
    ).toEqual(["src/api/routes/invitations.ts", "db/migrations/20261020_add_invitations.sql"]);
    // Normal and low files never count.
    expect(unviewedHighRisk(groups, new Set(unviewedHighRisk(groups, new Set())))).toEqual([]);
  });
});

describe("counts", () => {
  it("pending: accepted drafts and own comments not yet carried by an attempt", () => {
    const comment = { id: "c", path: "a.ts", line: 1, body: "x", posted: null };
    expect(
      pendingCount(
        stateOf(
          [record("F1", "accepted"), record("F2", "accepted", "posted"), record("F3", "dismissed")],
          [comment, { ...comment, id: "d", posted: "posting" }],
        ),
      ),
    ).toBe(2);
  });

  it("undecided: every finding without a decision, except one already posted from a re-run", () => {
    expect(undecidedCount(doc.findings, stateOf([]))).toBe(doc.findings.length);
    expect(
      undecidedCount(doc.findings, stateOf([record("F1", "accepted"), record("F2", "dismissed")])),
    ).toBe(doc.findings.length - 2);
    const posted = stateOf([record("F3", "draft", "posted")]);
    expect(undecidedCount(doc.findings, posted)).toBe(doc.findings.length - 1);
    expect(isUndecided(posted, "F3")).toBe(false);
    expect(isUndecided(posted, "F4")).toBe(true);
  });

  it("serious: a critical or high finding accepted and still to post", () => {
    expect(seriousAccepted(doc.findings, stateOf([record("F1", "accepted")]))).toBe(true);
    expect(seriousAccepted(doc.findings, stateOf([record("F1", "accepted", "posted")]))).toBe(
      false,
    );
    expect(seriousAccepted(doc.findings, stateOf([record("F1", "dismissed")]))).toBe(false);
    // F5 is medium.
    expect(seriousAccepted(doc.findings, stateOf([record("F5", "accepted")]))).toBe(false);
  });
});

describe("verdict suggestion (a suggestion only)", () => {
  it("request changes, pre-selected, when a critical or high finding was accepted", () => {
    expect(suggestVerdict({ serious: true, items: 3, unviewed: 0, undecided: 0 })).toMatchObject({
      verdict: "request_changes",
      preselect: true,
    });
  });

  it("comment, pre-selected, when there is something to post and nothing serious", () => {
    expect(suggestVerdict({ serious: false, items: 1, unviewed: 2, undecided: 3 })).toMatchObject({
      verdict: "comment",
      preselect: true,
    });
  });

  it("approve, never pre-selected, only when everything was viewed and decided and nothing is to post", () => {
    expect(suggestVerdict({ serious: false, items: 0, unviewed: 0, undecided: 0 })).toMatchObject({
      verdict: "approve",
      preselect: false,
    });
    expect(suggestVerdict({ serious: false, items: 0, unviewed: 1, undecided: 0 })).toBeNull();
    expect(suggestVerdict({ serious: false, items: 0, unviewed: 0, undecided: 1 })).toBeNull();
  });

  it("maps the verdict to the status pill", () => {
    expect(myReviewOf("approve")).toBe("approved");
    expect(myReviewOf("request_changes")).toBe("changes_requested");
    expect(myReviewOf("comment")).toBe("commented");
  });
});

describe("the summary draft", () => {
  it("is one numbered line per item, from the comments themselves, with its location", () => {
    const items = [
      item(),
      item({
        kind: "comment",
        id: "0b2d4e6f-8a1c-4c3e-9a7f-6f1c2a9e1d4b",
        path: "src/api/index.ts",
        line: 23,
        startLine: 21,
        body: "Mount order matters here.\nSecond line.",
      }),
    ];
    expect(draftSummary(items)).toBe(
      [
        "Before merge, please look at:",
        "",
        "1. Invitee can choose their own role (`src/auth/invitations.ts:28`)",
        "2. Mount order matters here. (`src/api/index.ts:21–23`)",
        "",
        "Details are in the inline comments.",
      ].join("\n"),
    );
  });

  it("has nothing to draft from without items", () => {
    expect(draftSummary([])).toBeNull();
  });

  it("cuts a long lead, keeps model text as text, and labels a range", () => {
    expect(itemLead(item({ body: `**${"a".repeat(100)}**` }))).toBe(`${"a".repeat(80)}…`);
    expect(itemLead(item({ kind: "comment", body: "\n\n<img src=x> @admin\n" }))).toBe(
      "<img src=x> @admin",
    );
    expect(itemLocation({ path: "a/b.ts", line: 5, startLine: 2 })).toBe("a/b.ts:2–5");
  });

  it("reveals the invisible characters a body carries (bidi, zero-width, controls), in order", () => {
    expect(revealInvisible("plain text")).toEqual([{ kind: "text", text: "plain text" }]);
    expect(revealInvisible("a\u202Eevil\u202Cb\u200B\u0007")).toEqual([
      { kind: "text", text: "a" },
      { kind: "invisible", code: "U+202E" },
      { kind: "text", text: "evil" },
      { kind: "invisible", code: "U+202C" },
      { kind: "text", text: "b" },
      { kind: "invisible", code: "U+200B" },
      { kind: "invisible", code: "U+0007" },
    ]);
    // Tabs and newlines are visible structure, not hidden characters; tag characters are.
    expect(revealInvisible("x\ty\n")).toEqual([{ kind: "text", text: "x\ty\n" }]);
    expect(invisibleCodes("\u{E0041}\u202E\u202E")).toEqual(["U+E0041", "U+202E"]);
  });
});

describe("the words for an answer", () => {
  it("a success has no notice; every other outcome says nothing or maybe was posted", () => {
    expect(
      noticeFor({ kind: "posted", submissionId: "s", reviewId: 1, repeated: false }),
    ).toBeNull();
    for (const reason of [
      "stale",
      "head_moved",
      "in_progress",
      "key_reused",
      "no_revision",
      "token_unavailable",
    ] as const) {
      expect(noticeFor({ kind: "refused", reason })).toMatch(
        /Nothing was posted|nothing was posted|nothing can be posted/,
      );
    }
    expect(noticeFor({ kind: "invalid", reason: "empty_review" })).toContain("pick Approve");
    expect(noticeFor({ kind: "post_failed", reason: "rejected" })).toContain("GitHub rejected");
    expect(noticeFor({ kind: "post_failed", reason: "weird_code" })).toContain("weird_code");
    expect(noticeFor({ kind: "post_unknown" })).toContain("may or may not have been posted");
    expect(noticeFor({ kind: "error", status: 403 })).toContain("403");
    // No usable answer: never "not posted"; a retry is safe (same key).
    for (const status of [0, 200, 500, 502]) {
      const text = noticeFor({ kind: "unknown", status }) ?? "";
      expect(text).toContain("may or may not have been posted");
      expect(text).not.toMatch(/Nothing was posted/);
    }
    expect(noticeFor({ kind: "not_sent" })).toContain("nothing was sent");
    expect(noticeFor({ kind: "unavailable" })).toContain("not available");
    expect(noticeFor({ kind: "signed_out" })).toContain("Sign in");
    expect(noticeFor({ kind: "not_found" })).toContain("no longer available");
  });

  it("describes an attempt by verdict and count", () => {
    expect(attemptText({ verdict: "approve", draftCount: 0, commentCount: 1 })).toBe(
      "Approve with 1 inline comment",
    );
    expect(attemptText({ verdict: "request_changes", draftCount: 2, commentCount: 1 })).toBe(
      "Request changes with 3 inline comments",
    );
    expect(attemptText({ verdict: "comment", draftCount: 0, commentCount: 0 })).toBe(
      "Comment, no inline comments",
    );
  });
});
