import type { DraftDecision } from "@rocky-reviews/core/drafts";
import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OwnComment } from "../diff/diff-model.js";
import { bySeverity, ReviewPanelContent, shorten } from "./ReviewPanel.js";
import { NO_REVIEW, ReviewContext, type ReviewContextValue } from "./ReviewProvider.js";
import { reviewWith } from "./testing.js";

/** P6-4: the right panel's Review tab (POC `renderPanel`). */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const findings = parsed.value.findings;

const render = (value: ReviewContextValue) =>
  renderToStaticMarkup(
    <ReviewContext value={value}>
      <ReviewPanelContent />
    </ReviewContext>,
  );
const panel = (decisions: Record<string, DraftDecision> = {}, comments: OwnComment[] = []) =>
  render(reviewWith(findings, decisions, comments));

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&") // last, so "&amp;#x27;" stays "&#x27;"
    .replace(/\s+/g, " ")
    .trim();

describe("review panel", () => {
  it("counts the drafts to decide in its heading and tally", () => {
    const html = panel();
    expect(text(html)).toMatch(/^Review · 10 AI drafts to decide/);
    expect(text((html.split('<dl class="tally">')[1] ?? "").split("</dl>")[0] ?? "")).toBe(
      "AI drafts to decide 10 Your comments 0 Dismissed 0",
    );
  });

  it("lists the drafts to decide by severity, each with its file and line", () => {
    const html = panel();
    const list = (html.split('id="to-decide"')[1] ?? "").split("</ul>")[0] ?? "";
    const titles = [...list.matchAll(/<span class="t"><bdi>([^<]+)<\/bdi>/g)].map((m) => m[1]);
    expect(titles[0]).toBe("Invitee can choose their own role, e.g. admin");
    expect(titles).toHaveLength(10);
    expect(text(list)).toContain("invitations.ts :28 ✦ draft , Critical severity");
    expect(bySeverity(findings).map((f) => f.severity)).toEqual([
      "critical",
      "high",
      "high",
      "high",
      "medium",
      "medium",
      "medium",
      "low",
      "low",
      "low",
    ]);
  });

  it("moves decided drafts to Decided, counts them, and notes kept dismissal reasons", () => {
    const html = panel(
      {
        F1: { state: "accepted", edited: false, body: "x" },
        F2: { state: "dismissed", reason: "intentional" },
        F3: { state: "dismissed", reason: "not_worth_it" },
      },
      [
        {
          id: "c1",
          path: "src/api/index.ts",
          line: 21,
          body: "Mount order matters.",
          posted: null,
        },
      ],
    );
    expect(text(html)).toMatch(/^Review · 7 AI drafts to decide/);
    expect(text((html.split('<dl class="tally">')[1] ?? "").split("</dl>")[0] ?? "")).toBe(
      "AI drafts to decide 7 Your comments 2 Dismissed 2",
    );
    const decided = (html.split('id="decided"')[1] ?? "").split("</ul>")[0] ?? "";
    expect(decided).toContain('class="f-item st-accepted"');
    expect(decided.match(/class="f-item st-dismissed"/g)).toHaveLength(2);
    expect(text(decided)).toContain("yours");
    expect(text(html)).toContain(
      "◆ Rocky keeps the reason for 2 dismissals so future reviews of this repository can learn from them.",
    );
    const own = html.split('id="own-comments"')[1] ?? "";
    expect(text(own)).toContain("Mount order matters. index.ts :21");
  });

  it("marks drafts and comments already posted to GitHub (P6-6)", () => {
    const html = render(
      reviewWith(
        findings,
        { F1: { state: "accepted", edited: false, body: "x" } },
        [{ id: "c1", path: "src/api/index.ts", line: 21, body: "Mount order.", posted: "posted" }],
        {},
        { F1: "posted" },
      ),
    );
    const decided = (html.split('id="decided"')[1] ?? "").split("</ul>")[0] ?? "";
    expect(text(decided)).toContain("posted");
    expect(text(decided)).not.toContain("yours");
    expect(text(html.split('id="own-comments"')[1] ?? "")).toContain(
      "Mount order. index.ts :21 posted",
    );
  });

  it("says when every draft has a decision", () => {
    const all = Object.fromEntries(
      findings.map((f) => [f.id, { state: "dismissed", reason: "not_an_issue" } as const]),
    );
    const html = panel(all);
    expect(text(html)).toContain("✓ Every AI draft has a decision.");
    expect(html).not.toContain("panel-count");
  });

  it("has loading, failed and no-analysis states", () => {
    expect(text(render({ ...NO_REVIEW, status: "loading" }))).toContain("Loading your drafts…");
    const failed = render({ ...NO_REVIEW, status: "failed" });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain("could not be loaded");
    expect(text(render(NO_REVIEW))).toContain("AI drafts and your own comments");
  });

  it("marks the focused draft", () => {
    const html = render(reviewWith(findings, {}, [], { focused: "F2" }));
    expect(html).toMatch(/class="f-item st-draft focus"/);
  });
});

describe("when the diff is from a newer push than the analysis", () => {
  it("says so, and its items do not jump (the drafts and comments are hidden there)", () => {
    const html = render(
      reviewWith(
        findings,
        { F2: { state: "dismissed", reason: "intentional" } },
        [{ id: "c1", path: "src/auth/invitations.ts", line: 3, body: "Why?", posted: null }],
        { stale: true },
      ),
    );
    expect(text(html)).toContain(
      "These drafts and your comments are for an earlier push, so they are hidden on the new diff.",
    );
    const items = [...html.matchAll(/<button[^>]*class="f-item[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(items.length).toBe(11);
    for (const item of items) expect(item).toContain("disabled");
  });
});

describe("shorten", () => {
  it("keeps short text, and cuts long text by characters a person sees, never inside one", () => {
    expect(shorten("short", 70)).toBe("short");
    expect(shorten("a".repeat(71), 70)).toBe(`${"a".repeat(70)}…`);
    // 70 family emoji (each several code units): cut after whole ones, never a lone surrogate.
    const family = "👨‍👩‍👧";
    const cut = shorten(family.repeat(71), 70);
    expect(cut).toBe(`${family.repeat(70)}…`);
    expect(shorten(`${"a".repeat(69)}😀😀`, 70)).toBe(`${"a".repeat(69)}😀…`);
  });
});
