import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { type AnalysisDocument, parseAnalysisDocument } from "@rocky-reviews/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseDiffData } from "../data/diff-data.js";
import { createFixtureDiffSource } from "../data/diff-fixture-source.js";
import { DEFAULT_PULL } from "../data/fixture-source.js";
import type { OwnComment } from "./diff-model.js";
import { ReviewContext, type ReviewContextValue } from "../drafts/ReviewProvider.js";
import { reviewWith } from "../drafts/testing.js";
import type { DraftDecision } from "@rocky-reviews/core/drafts";
import type { PullRef } from "../data/shell-data.js";
import {
  DiffContext,
  type DiffContextValue,
  type DiffLoad,
  type DiffLoadReason,
} from "./DiffProvider.js";
import { FileView } from "./FileView.js";

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const doc: AnalysisDocument = parsed.value;
const diff = parseDiffData(await createFixtureDiffSource().load(DEFAULT_PULL));

const context = (
  load: DiffLoad,
  pull: PullRef | null = DEFAULT_PULL,
  returnTo?: string,
): DiffContextValue => ({
  load,
  request: () => {},
  pull,
  ...(returnTo === undefined ? {} : { returnTo }),
});

const render = (
  path: string,
  load: DiffLoad = { kind: "ready", data: diff },
  options: {
    analysis?: AnalysisDocument;
    comments?: readonly OwnComment[];
    decisions?: Record<string, DraftDecision>;
    line?: number;
    status?: ReviewContextValue["status"];
    /** The PR the diff belongs to (`null`: none known, so no GitHub link can be built). */
    pull?: PullRef | null;
    returnTo?: string;
  } = {},
) =>
  renderToStaticMarkup(
    <ReviewContext
      value={reviewWith(
        (options.analysis ?? doc).findings,
        options.decisions ?? {},
        options.comments ?? [],
        { status: options.status ?? "ready" },
      )}
    >
      <DiffContext value={context(load, options.pull, options.returnTo)}>
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
    expect(html).toMatch(
      /<button[^>]*aria-pressed="false" aria-keyshortcuts="v">Mark viewed <kbd class="kbd-on" aria-hidden="true">v<\/kbd><\/button>/,
    );
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
      comments: [
        {
          id: "c1",
          path: "src/auth/invitations.ts",
          line: 3,
          body: "Why <b>this</b>?",
          posted: null,
        },
      ],
    });
    expect(text(withComment)).toContain("Y you Pending Delete Why <b>this</b>?");
    expect(withComment).toContain("Why &lt;b&gt;this&lt;/b&gt;?");
    expect(withComment).toContain('aria-label="Delete your comment on line 3"');
  });

  it("an own comment posted to GitHub (P6-6) says Posted and has no Delete", () => {
    const html = render("src/auth/invitations.ts", undefined, {
      comments: [
        { id: "c1", path: "src/auth/invitations.ts", line: 3, body: "Why?", posted: "posted" },
      ],
    });
    expect(text(html)).toContain("Y you Posted to GitHub, read-only Why?");
    expect(html).not.toContain("Delete your comment");
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
    expect(text(stale)).toContain("The AI notes, drafts and your comments are for an earlier push");
    expect(stale).not.toContain("hot-");
    expect(stale).not.toContain('class="flag');
    expect(stale).not.toContain("data-finding=");
  });

  it("on a newer push, hides your comments and takes no new ones (they would land on the old diff)", () => {
    const stale = render(
      "src/auth/invitations.ts",
      { kind: "ready", data: { ...diff, headSha: "0".repeat(40) } },
      {
        comments: [
          { id: "c1", path: "src/auth/invitations.ts", line: 3, body: "Mine", posted: null },
        ],
      },
    );
    expect(text(stale)).toContain(
      "The AI notes, drafts and your comments are for an earlier push, so they are hidden on this diff. New comments open once this push is analysed.",
    );
    expect(text(stale)).not.toContain("Mine");
    expect(stale).toMatch(/<button[^>]*data-line="3"[^>]*aria-disabled="true"/);
    expect(stale).not.toContain('aria-label="Comment on line 3"');
    expect(text(stale)).not.toContain("Click a line number to add your own comment");
  });

  it("takes no comments until the reviewer's review has loaded", () => {
    for (const status of ["loading", "failed"] as const) {
      const html = render("src/auth/invitations.ts", undefined, { status });
      expect(html).toMatch(/<button[^>]*data-line="3"[^>]*aria-disabled="true"/);
      expect(html).not.toContain('aria-label="Comment on line 3"');
    }
    expect(render("src/auth/invitations.ts")).toContain('aria-label="Comment on line 3"');
  });

  it("says when the diff is loading or failed", () => {
    expect(text(render("src/auth/invitations.ts", { kind: "loading" }))).toContain(
      "Loading the diff…",
    );
    const failed = render("src/auth/invitations.ts", { kind: "failed", reason: "failed" });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain("The diff could not be loaded.");
  });

  it("H4-3: says why the server's diff could not be loaded, as fixed text per reason", () => {
    const cases: [DiffLoadReason, string][] = [
      [
        "not_found",
        "This diff isn’t available: the pull request isn’t in Rocky, or you can’t read",
      ],
      ["head_moved", "This pull request changed on GitHub since Rocky last saw it."],
      ["too_large", "GitHub won’t render a diff this large, so Rocky can’t show it."],
      ["unavailable", "Repository access isn’t available yet, so Rocky can’t load the diff."],
      ["forge_failed", "GitHub didn’t answer when Rocky asked for the diff."],
      ["rate_limited", "Too many diff requests in a row."],
      ["signed_out", "Your session ended."],
      ["failed", "The diff could not be loaded."],
    ];
    for (const [reason, expected] of cases) {
      const html = render("src/auth/invitations.ts", { kind: "failed", reason });
      expect(html, reason).toContain('class="diff-status" role="alert"');
      expect(text(html), reason).toContain(expected);
      // Nothing from the answer is on the page, only the fixed text and the file's own header.
      expect(html, reason).not.toContain("Zebra");
    }
  });

  it("H4-3: the too-large and signed-out states offer a way out, built from validated names", () => {
    const large = render("src/auth/invitations.ts", { kind: "failed", reason: "too_large" });
    expect(large).toContain(
      '<a href="https://github.com/acme/rocky-app/pull/847/files" target="_blank" rel="noopener noreferrer">Read it on GitHub</a>',
    );
    // Without a validated PR there is no link, only the text.
    const noPull = render(
      "src/auth/invitations.ts",
      { kind: "failed", reason: "too_large" },
      { pull: null },
    );
    expect(noPull).not.toContain("github.com");
    expect(text(noPull)).toContain("GitHub won’t render a diff this large");
    const signedOut = render("src/auth/invitations.ts", { kind: "failed", reason: "signed_out" });
    expect(signedOut).toContain('<a href="/auth/github/login">Sign in with GitHub</a>');
    // With the page's path, sign-in comes back here (the same rule as the page's own state).
    const back = render(
      "src/auth/invitations.ts",
      { kind: "failed", reason: "signed_out" },
      { returnTo: "/acme/rocky-app/pull/847" },
    );
    expect(back).toContain(
      '<a href="/auth/github/login?returnTo=%2Facme%2Frocky-app%2Fpull%2F847">Sign in with GitHub</a>',
    );
  });

  it("H4-3: a truncated diff says so on every file, and a file past the cut says where it is", () => {
    const truncated = { ...diff, truncated: true };
    const html = render("src/auth/invitations.ts", { kind: "ready", data: truncated });
    expect(html).toContain('class="diff-status" role="note"');
    expect(text(html)).toContain(
      "This diff is longer than Rocky reads (1 MiB), so only its first part is shown",
    );
    expect(html).toContain('class="diff"');
    const beyond = render("src/missing-past-the-cut.ts", { kind: "ready", data: truncated });
    expect(text(beyond)).toContain("This file is past the part of the diff Rocky read.");
    expect(beyond).not.toContain('class="diff"');
    // A whole diff says nothing of the kind.
    expect(text(render("src/auth/invitations.ts"))).not.toContain("only its first part");
    expect(text(render("src/missing-past-the-cut.ts"))).toContain("This file is not in the diff.");
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
