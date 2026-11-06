import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HiddenCard } from "./HiddenCard.js";
import { ReviewContext, type ReviewContextValue } from "./ReviewProvider.js";
import { reviewWith } from "./testing.js";

/** P8-2b: a finding project memory hid, as the expanded "hidden by memory" list shows it. */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const H1 = parsed.value.hidden?.find((h) => h.id === "H1");
if (H1 === undefined) throw new Error("the fixture carries H1");

const render = (options: { status?: ReviewContextValue["status"]; saving?: boolean } = {}) =>
  renderToStaticMarkup(
    <ReviewContext
      value={reviewWith(parsed.value.findings, {}, [], {
        hidden: [H1],
        status: options.status ?? "ready",
        saving: new Set(options.saving === true ? [H1.id] : []),
      })}
    >
      <HiddenCard hidden={H1} />
    </ReviewContext>,
  );

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("a finding hidden by memory", () => {
  const html = render();

  it("is an AI card that is not a draft: finding, severity, confidence, and that memory hid it", () => {
    expect(html).toContain('class="draft hidden-draft sev-medium"');
    expect(html).toContain('data-hidden="H1"');
    expect(html).not.toContain('data-finding="H1"');
    const head = text(html.split('class="draft-head">')[1]?.split("</div>")[0] ?? "");
    expect(head).toBe("AI finding Medium 74% confident Hidden by project memory");
    expect(text(html)).toContain(H1.title);
    expect(text(html)).toContain("A 5xx from the mail provider drops the invitation silently");
  });

  it("names the dismissal that hid it (where and why) without quoting the entry's text", () => {
    const line = text(html.split('class="evidence hidden-by">')[1]?.split("</p>")[0] ?? "");
    expect(line).toBe(
      `◆ Your team dismissed this as intentional on src/jobs/sendInviteEmail.ts · ${H1.hiddenBy.entry.source} , so Rocky did not draft it here.`,
    );
    expect(line).not.toContain(H1.hiddenBy.entry.text);
    // The path is stored data, rendered as text.
    expect(html).toContain("<code><bdi>src/jobs/sendInviteEmail.ts</bdi></code>");
    const scripted = renderToStaticMarkup(
      <ReviewContext value={reviewWith(parsed.value.findings, {}, [], { hidden: [H1] })}>
        <HiddenCard
          hidden={{ ...H1, hiddenBy: { ...H1.hiddenBy, path: "src/<script>x</script>.ts" } }}
        />
      </ReviewContext>,
    );
    expect(scripted).not.toContain("<script>");
  });

  it("offers Restore as a draft once the reviewer's decisions are loaded, and says what that means", () => {
    const actions = text(html.split('class="draft-actions">')[1] ?? "");
    expect(actions).toBe("Restore as a draft Restored, it is yours to accept, edit or dismiss.");
    expect(html).toContain('data-role="restore"');
    expect(html).not.toContain("Accept");
    expect(render({ saving: true })).toContain('data-role="restore" disabled=""');
    expect(text(render({ status: "loading" }))).toContain("Loading your decisions…");
    expect(text(render({ status: "failed" }))).toContain("cannot be restored");
    expect(render({ status: "loading" })).not.toContain('data-role="restore"');
  });
});
