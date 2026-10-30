import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { type AnalysisDocument, parseAnalysisDocument } from "@rocky-reviews/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseDiffData } from "../data/diff-data.js";
import { createFixtureDiffSource } from "../data/diff-fixture-source.js";
import { DEFAULT_PULL } from "../data/fixture-source.js";
import type { OwnComment } from "./diff-model.js";
import { ReviewContext } from "../drafts/ReviewProvider.js";
import { reviewWith } from "../drafts/testing.js";
import type { DraftDecision } from "@rocky-reviews/core/drafts";
import { DiffContext, type DiffContextValue, type DiffLoad } from "./DiffProvider.js";
import { FileView } from "./FileView.js";

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const doc: AnalysisDocument = parsed.value;
const diff = parseDiffData(await createFixtureDiffSource().load(DEFAULT_PULL));

const context = (load: DiffLoad): DiffContextValue => ({ load, request: () => {} });

const render = (
  path: string,
  load: DiffLoad = { kind: "ready", data: diff },
  options: {
    analysis?: AnalysisDocument;
    comments?: readonly OwnComment[];
    decisions?: Record<string, DraftDecision>;
    line?: number;
  } = {},
) =>
  renderToStaticMarkup(
    <ReviewContext
      value={reviewWith(
        (options.analysis ?? doc).findings,
        options.decisions ?? {},
        options.comments ?? [],
      )}
    >
      <DiffContext value={context(load)}>
        <FileView
          path={path}
          line={options.line}
          analysis={options.analysis ?? doc}
          viewed={new Set()}
          onToggleViewed={() => {}}
          onSelect={() => {}}
        />
      </DiffContext>
    </ReviewContext>,
  );

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&") // last, so "&amp;lt;" stays "&lt;"
    .replace(/\s+/g, " ")
    .trim();

describe("file view", () => {
  const html = render("src/auth/invitations.ts");

  it("has the sticky header: risk label and score, path, size and Mark viewed", () => {
    expect(text(html)).toContain("Critical · 97 risk score src/auth/invitations.ts +33 −0");
    expect(html).toContain("<bdi>src/auth/invitations.ts</bdi>");
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Mark viewed<\/button>/);
  });

  it("has the AI strip: what changed, why this level, drafts", () => {
    const strip = text(html.split('<dl class="file-ai">')[1]?.split("</dl>")[0] ?? "");
    expect(strip).toBe(
      "What changed New createInvitation() and acceptInvitation(). Accepting one adds the user to an org. " +
        "Why critical New path that grants org membership and sets the member's role. " +
        "Drafts 3 findings on this file. Accept, edit or dismiss each one inline.",
    );
  });

  it("opened at a finding's line (P5-3), that line is the diff's tab stop", () => {
    const at = render("src/auth/invitations.ts", undefined, { line: 28 });
    expect(at).toMatch(/<button[^>]*data-line="28"[^>]*tabindex="0"/);
    expect(at).toMatch(/<button[^>]*data-line="1"[^>]*tabindex="-1"/);
  });

  it("opened at a line the diff does not show, the nearest shown line is the tab stop", () => {
    // The file's hunk is +1,33: line 90 is past its end.
    const past = render("src/auth/invitations.ts", undefined, { line: 90 });
    expect(past).toMatch(/<button[^>]*data-line="33"[^>]*tabindex="0"/);
  });

  it("renders the hunk header, numbered lines and highlighted code", () => {
    expect(html).toContain("@@ -0,0 +1,33 @@");
    expect(html).toMatch(/<button[^>]*data-line="1"[^>]*tabindex="0"[^>]*>1<\/button>/);
    expect(html).toMatch(/<button[^>]*data-line="2"[^>]*tabindex="-1"/);
    expect(html).toContain('<span class="tk-kw">import</span>');
    expect(html).toContain('<span class="tk-str">&quot;node:crypto&quot;</span>');
  });

  it("shows the AI flags under their lines and marks hot lines", () => {
    const t = text(html);
    expect(t).toContain(
      "✓ Checked (AI) Token uses 32 bytes from crypto.randomBytes . That's enough entropy.",
    );
    expect(t).toContain("✦ Look here (AI) Lookup by raw token.");
    expect(t).toContain("✦ Your call (AI) The invite's email is never compared");
    expect(html).toMatch(/class="ln add hot hot-ok"[^>]*>(?:(?!class="ln ).)*data-line="10"/);
    expect(html).toMatch(/class="ln add hot hot-critical"[^>]*>(?:(?!class="ln ).)*data-line="28"/);
  });

  it("shows the reviewer's own comments as pending, with Delete", () => {
    const withComment = render("src/auth/invitations.ts", undefined, {
      comments: [{ id: "c1", path: "src/auth/invitations.ts", line: 3, body: "Why <b>this</b>?" }],
    });
    expect(text(withComment)).toContain("Y You Pending Delete Why <b>this</b>?");
    expect(withComment).toContain("Why &lt;b&gt;this&lt;/b&gt;?");
    expect(withComment).toContain('aria-label="Delete your comment on line 3"');
  });

  it("offers the next file in review order", () => {
    expect(text(html)).toContain("Mark viewed & next →");
  });

  it("ignores a finding's line on a diff of another head commit (it may have moved)", () => {
    const stale = render(
      "src/auth/invitations.ts",
      { kind: "ready", data: { ...diff, headSha: "0".repeat(40) } },
      { line: 28 },
    );
    expect(stale).toMatch(/<button[^>]*data-line="1"[^>]*tabindex="0"/);
    expect(stale).toMatch(/<button[^>]*data-line="28"[^>]*tabindex="-1"/);
  });

  it("hides AI notes when the analysis is for another head commit", () => {
    const stale = render("src/auth/invitations.ts", {
      kind: "ready",
      data: { ...diff, headSha: "0".repeat(40) },
    });
    expect(text(stale)).toContain("The AI notes and drafts are for an earlier push");
    expect(stale).not.toContain("hot-");
    expect(stale).not.toContain('class="flag');
    expect(stale).not.toContain("data-finding=");
  });

  it("says when the diff is loading or failed", () => {
    expect(text(render("src/auth/invitations.ts", { kind: "loading" }))).toContain(
      "Loading the diff…",
    );
    const failed = render("src/auth/invitations.ts", { kind: "failed" });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain("The diff could not be loaded.");
  });
});

describe("noise file view", () => {
  it("shows the AI summary and keeps the raw diff behind a button", () => {
    const html = render("pnpm-lock.yaml");
    expect(text(html)).toContain("Noise pnpm-lock.yaml");
    expect(text(html)).toContain("AI summary");
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show raw diff \(\+34 −3\)/);
    expect(html).not.toContain('class="diff"');
  });
});

describe("untrusted content", () => {
  const hostile = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1 +1 @@ <script>alert(1)</script>",
    '-const a = "<img src=x onerror=alert(1)>";',
    '+const a = "safe"; // ‮} if (admin) {⁦',
    "",
  ].join("\n");
  const data = parseDiffData({ headSha: doc.provenance.head.sha, diff: hostile });

  it("renders markup in code and hunk headers as text", () => {
    const html = render("x.ts", { kind: "ready", data });
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("shows invisible bidi controls as visible markers instead of applying them", () => {
    const html = render("x.ts", { kind: "ready", data });
    expect(html).not.toMatch(/[‮⁦]/);
    expect(html).toContain(
      '<span class="bidi-ctl" title="Invisible character U+202E">U+202E</span>',
    );
    expect(html).toContain(">U+2066</span>");
  });
});
