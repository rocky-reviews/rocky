import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewContext } from "../drafts/ReviewProvider.js";
import { reviewWith } from "../drafts/testing.js";
import { RightPanelContent, type PanelTab } from "../shell/RightPanel.js";
import { createFixtureAskSource } from "./ask-fixture-source.js";
import type { AskReply, AskSelection } from "./ask-data.js";
import { Reply } from "./AskPanel.js";

/**
 * P9-2: the right panel's tabs (POC "Review · n" and "✦ Ask") and the Ask tab's first render.
 * Its interactions (asking, citations, `/` with a selection, every state) are in
 * `e2e/ask.e2e.spec.ts`. P9-3: the two rate-limit messages, with the wait when known.
 */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const findings = parsed.value.findings;

const render = (tab: PanelTab, selection: AskSelection | null = null) =>
  renderToStaticMarkup(
    <ReviewContext value={reviewWith(findings)}>
      <RightPanelContent
        current={null}
        files={[]}
        tab={tab}
        onTab={() => undefined}
        ask={{
          source: createFixtureAskSource(),
          pull: { owner: "acme", repo: "rocky-app", number: 847 },
          selection,
          onClearSelection: () => undefined,
          focusRequest: 0,
        }}
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

describe("the right panel's tabs", () => {
  it("are an ARIA tablist: Review with its count, then Ask; one selected and focusable", () => {
    const html = render("review");
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(
      /<button type="button" role="tab" id="panel-tab-review" aria-selected="true" aria-controls="panel-pane-review" tabindex="0"/,
    );
    expect(html).toMatch(
      /<button type="button" role="tab" id="panel-tab-ask" aria-selected="false" aria-controls="panel-pane-ask" tabindex="-1"/,
    );
    expect(text(html)).toMatch(/^Review · 10 AI drafts to decide ✦ Ask/);
    // Both panes stay mounted; the hidden one is hidden.
    expect(html).toMatch(/id="panel-pane-review" aria-labelledby="panel-tab-review">/);
    expect(html).toMatch(/id="panel-pane-ask" aria-labelledby="panel-tab-ask" hidden="">/);
  });

  it("the Review pane keeps the shortcut strip, which now lists / ask", () => {
    expect(text(render("review"))).toContain("v viewed / ask ? all shortcuts");
  });

  it("the Ask pane says it is checking the index, with the box off until it is ready", () => {
    const html = render("ask");
    expect(html).toMatch(/id="panel-pane-review" aria-labelledby="panel-tab-review" hidden="">/);
    expect(text(html)).toContain("Checking the repository index…");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain('placeholder="Ask anything about this change…"');
    expect(text(html)).toContain("Enter to send · Shift+Enter for a new line");
    expect(html).toContain("Your question");
  });

  it("shows the code selected with / as a removable chip", () => {
    const html = render("ask", {
      path: "src/auth/invitations.ts",
      startLine: 28,
      endLine: 31,
      text: "x",
    });
    expect(text(html)).toContain("With the selected code from src/auth/invitations.ts:28–31");
    expect(html).toContain('aria-label="Remove the selected code"');
  });
});

describe("a rate limit's message (P9-3)", () => {
  const error = (reply: Extract<AskReply, { kind: "error" }>) =>
    renderToStaticMarkup(<Reply reply={reply} retryDisabled={false} onRetry={() => undefined} />);

  it("the member's own limit: an alert with the wait in seconds, and Try again", () => {
    const html = error({ kind: "error", problem: "rate_limited", retryAfterSeconds: 42 });
    expect(html).toContain('class="chat-a ask-error" role="alert"');
    expect(text(html)).toContain(
      "You’ve asked a lot in the last minute. Wait 42 seconds, then ask again.",
    );
    expect(text(html)).toContain("Try again");
    expect(text(error({ kind: "error", problem: "rate_limited", retryAfterSeconds: 1 }))).toContain(
      "Wait 1 second, then ask again.",
    );
    expect(text(error({ kind: "error", problem: "rate_limited" }))).toContain(
      "You’ve asked a lot in the last minute. Wait a moment, then ask again.",
    );
  });

  it("the organisation's budget: says so, with the wait in seconds, minutes or hours", () => {
    const org = (retryAfterSeconds?: number) =>
      text(
        error(
          retryAfterSeconds === undefined
            ? { kind: "error", problem: "org_rate_limited" }
            : { kind: "error", problem: "org_rate_limited", retryAfterSeconds },
        ),
      );
    const html = error({ kind: "error", problem: "org_rate_limited", retryAfterSeconds: 1800 });
    expect(html).toContain('class="chat-a ask-error" role="alert"');
    expect(text(html)).toContain(
      "Your organisation has reached its Ask limit for now. Try again in about 30 minutes.",
    );
    expect(text(html)).toContain("Try again");
    expect(org(45)).toContain("Try again in about 45 seconds.");
    expect(org(89)).toContain("Try again in about 89 seconds.");
    expect(org(90)).toContain("Try again in about 2 minutes.");
    expect(org(100)).toContain("Try again in about 2 minutes.");
    expect(org(60)).toContain("Try again in about 60 seconds.");
    expect(org(5400)).toContain("Try again in about 90 minutes.");
    expect(org(5401)).toContain("Try again in about 2 hours.");
    expect(org(3601)).toContain("Try again in about 60 minutes.");
    expect(org(9000)).toContain("Try again in about 3 hours.");
    expect(org(86_400)).toContain("Try again in about 24 hours.");
    expect(org()).toContain(
      "Your organisation has reached its Ask limit for now. Try again later.",
    );
  });
});
