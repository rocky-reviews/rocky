import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PR_847_PULL } from "../data/fixture-source.js";
import { parseShellData } from "../data/shell-data.js";
import { ReviewContext } from "../drafts/ReviewProvider.js";
import { reviewWith } from "../drafts/testing.js";
import { sidebarGroups } from "../shell/triage-model.js";
import { FinishReview } from "./FinishReview.js";
import { memoryPostingSource } from "./testing.js";

/**
 * P6-6: the modal's first render (before the list arrives; what it then shows, and the click,
 * are in `finish.e2e.spec.ts` against the mocked posting API). What is static must already be
 * right: the warnings, the count of undecided drafts, the list heading, the summary box, the
 * verdict options, and Submit inert until the list is loaded and a verdict picked.
 */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const doc = parsed.value;
const groups = sidebarGroups(doc);
const data = parseShellData({ pull: PR_847_PULL, myReview: null, analysis: null });

const render = (
  options: {
    viewed?: string[];
    decisions?: Parameters<typeof reviewWith>[1];
    login?: string | null;
    pullRequestId?: string | null;
  } = {},
) =>
  renderToStaticMarkup(
    <ReviewContext value={reviewWith(doc.findings, options.decisions ?? {})}>
      <FinishReview
        pullRequestId={
          options.pullRequestId === undefined
            ? "6f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c"
            : options.pullRequestId
        }
        pull={data.pull}
        login={options.login === undefined ? "dana-k" : options.login}
        posting={memoryPostingSource()}
        groups={groups}
        viewed={new Set(options.viewed ?? [])}
        now={Date.parse("2026-10-25T12:12:00.000Z")}
        onClose={() => {}}
        onPosted={() => {}}
      />
    </ReviewContext>,
  );

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("finish review modal", () => {
  it("is a labelled modal dialog with Close, Keep reviewing and an inert Submit", () => {
    const html = render();
    expect(html).toMatch(
      /<div id="finish-dialog" class="modal finish-modal" role="dialog" aria-modal="true" aria-labelledby="finish-title"/,
    );
    expect(text(html)).toContain("Finish your review");
    expect(html).toContain('aria-label="Close"');
    expect(text(html)).toContain("Keep reviewing");
    expect(html).toMatch(
      /<button[^>]*class="btn btn-primary"[^>]*disabled=""[^>]*aria-disabled="true"[^>]*>Submit review/,
    );
    expect(text(html)).toContain("Loading what will be posted…");
  });

  it("warns about high-risk files not marked viewed, by name, and about undecided drafts", () => {
    const html = render({ viewed: ["src/auth/invitations.ts"] });
    expect(text(html)).toContain(
      "3 high-risk files not marked viewed: src/api/routes/invitations.ts , db/migrations/20261020_add_invitations.sql , src/jobs/sendInviteEmail.ts",
    );
    expect(html).toContain("<code><bdi>src/api/routes/invitations.ts</bdi></code>");
    expect(text(html)).toContain(
      "10 AI drafts still undecided. They won't be posted. Only what you accepted goes out.",
    );
  });

  it("says when every critical and important file was viewed, and counts undecided drafts down", () => {
    const html = render({
      viewed: groups.flatMap((g) => g.files.map((f) => f.path)),
      decisions: {
        F1: { state: "accepted", edited: false, body: "x" },
        F2: { state: "dismissed", reason: "intentional" },
      },
    });
    expect(text(html)).toContain("✓ You reviewed every Critical and Important file.");
    expect(text(html)).toContain("8 AI drafts still undecided.");
    const [critical, important] = groups;
    const allButOne = [...(critical?.files.slice(1) ?? []), ...(important?.files ?? [])].map(
      (f) => f.path,
    );
    expect(text(render({ viewed: allButOne }))).toContain("1 high-risk file not marked viewed:");
  });

  it("names who the list is posted as, from the session, or 'you' before it is known", () => {
    expect(text(render())).toContain("Will be posted to GitHub as @dana-k");
    expect(text(render({ login: null }))).toContain("Will be posted to GitHub as you");
    expect(render({ login: "‮evil" })).toContain("<bdi>@‮evil</bdi>");
  });

  it("offers the overall comment, the draft button (inert without items) and the three verdicts", () => {
    const html = render();
    expect(html).toContain(
      '<label class="sr-only" for="finish-summary">Overall comment (optional)</label>',
    );
    expect(html).toMatch(
      /<textarea id="finish-summary" rows="3" placeholder="Overall comment \(optional\)" maxLength="65536"/,
    );
    // The dialog itself is focusable (while sending every control is disabled).
    expect(html).toMatch(/id="finish-dialog"[^>]*tabindex="-1"/);
    expect(html).toMatch(
      /<button type="button" class="btn btn-sm btn-ai" disabled=""[^>]*>.*Draft a summary from my comments/,
    );
    const options = [...html.matchAll(/<input type="radio" name="verdict" value="([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(options).toEqual(["comment", "approve", "request_changes"]);
    // Nothing is selected before the list is known: the suggestion comes with it.
    expect(html).not.toContain('checked=""');
  });

  it("says when the page has no pull request id to post through, in the list and the footer", () => {
    const html = render({ pullRequestId: null });
    expect(text(html)).toContain("Posting is not available for this pull request.");
    expect(text(html)).not.toContain("Loading what will be posted");
  });
});
