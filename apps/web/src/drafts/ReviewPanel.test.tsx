import type { DraftDecision } from "@rocky-reviews/core/drafts";
import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OwnComment } from "../diff/diff-model.js";
import { bySeverity, ReviewPanelContent } from "./ReviewPanel.js";
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
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
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
      [{ id: "c1", path: "src/api/index.ts", line: 21, body: "Mount order matters." }],
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
