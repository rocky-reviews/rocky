import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewContext } from "../drafts/ReviewProvider.js";
import { reviewWith } from "../drafts/testing.js";
import { RightPanelContent, type PanelTab } from "../shell/RightPanel.js";
import { createFixtureAskSource } from "./ask-fixture-source.js";
import type { AskSelection } from "./ask-data.js";

/**
 * P9-2: the right panel's tabs (POC "Review · n" and "✦ Ask") and the Ask tab's first render.
 * Its interactions (asking, citations, `/` with a selection, every state) are in
 * `e2e/ask.e2e.spec.ts`.
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
