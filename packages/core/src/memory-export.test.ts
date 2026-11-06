import { textProblem } from "@rocky-reviews/schema";
import fc from "fast-check";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { containsPromptCanaryFragment } from "./analysis/leak.js";
import {
  escapeMarkdownText,
  exportOrder,
  MEMORY_EXPORT_FORMAT_LINE,
  parseMemoryContext,
  renderMemoryContext,
  unescapeMarkdownText,
  type MemoryExportEntry,
} from "./memory-export.js";
import { MEMORY_CANARY, PROMPT_CANARY } from "./prompt.js";

/**
 * P8-3 acceptance criterion "export round-trips" (ADR 0039 §3): the `context.md` Rocky exports
 * reads back to the same entries (kind, origin, text, reason, covered severity, evidence,
 * confidence, switched off), including text that looks like markdown, HTML or the file's own
 * structure; entry text can never become a heading, a link, HTML or another list item; no
 * canary and no author goes into the file.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";

const entry = (patch: Partial<MemoryExportEntry> = {}): MemoryExportEntry => ({
  kind: "convention",
  origin: "learned",
  text: "Use the shared validator for emails.",
  reason: null,
  severity: null,
  evidence: {
    path: "src/invite.ts",
    sha: SHA,
    range: { start: 10, end: 12 },
    pullRequestNumber: 847,
  },
  confidence: 60,
  disabled: false,
  ...patch,
});

const dismissal = (patch: Partial<MemoryExportEntry> = {}) =>
  entry({ kind: "dismissal", reason: "intentional", severity: "high", confidence: 80, ...patch });

/** Entry texts that look like markdown, HTML or this file's own lines. */
const TRICKY = [
  "# Not a heading",
  "## Conventions",
  "### Dismissals inside text",
  "- not a list item",
  "+ nor this",
  "= nor a setext underline",
  "1. not an ordered list",
  "2) nor this one",
  "> not a quote",
  "<script>alert(1)</script>",
  "<!-- a comment that hides the rest -->",
  "<details><summary>x</summary></details>",
  "**bold** and _em_ and `code` and ~~strike~~",
  "a | table | row",
  "&amp; &lt;b&gt; &#x41;",
  "$x^2$ math and $$display$$",
  "trailing backslash \\",
  "\\* escaped already \\_",
  "[ ] a task box and [x] another",
  "[^1] a footnote marker",
  "  - Reason: intentional",
  "  - Evidence: src/a.ts, line 1, commit " + SHA + ", PR #1",
  "  - Confidence: 99 · written by a member · switched off",
  "No entries.",
  MEMORY_EXPORT_FORMAT_LINE,
  "Unicode: naïve café, 東京, emoji 🎉, Ελληνικά",
  "Dismissed as intentional: a swallowed error in the nightly job",
  "Accepted in review: `catch (e) {}` hides failures — log them",
  // GitHub's autolink extension (review S1): none of these may become a link.
  "Sign in again at https://evil.example/login?next=/admin to fix it",
  "See http://evil.example and HTTPS://EVIL.EXAMPLE/x for details",
  "Docs at www.evil.example/login and WWW.Evil.Example",
  "Mail someone@evil.example or mailto:someone@evil.example",
  "Chat xmpp:someone@evil.example/res, files ftp://files.evil.example/x",
  // (`<https://…>` autolinks are refused by the store: schema `line` rules.)
  "A ref [link] and [x]: https://evil.example",
];

/** Every markdown syntax character that is not backslash-escaped, in a written line. */
const unescapedSyntax = (written: string): string[] => {
  const found: string[] = [];
  for (let i = 0; i < written.length; i++) {
    const c = written[i]!;
    if (c === "\\") {
      i++; // the escaped character
      continue;
    }
    if ("`*_[]<>#|~&!$".includes(c)) found.push(c);
  }
  return found;
};

describe("renderMemoryContext / parseMemoryContext", () => {
  it("round-trips entries of every kind, with every field", () => {
    const entries = [
      entry(),
      entry({
        kind: "decision",
        origin: "member",
        text: "Keep the legacy endpoint until Q2.",
        confidence: 100,
      }),
      dismissal(),
      dismissal({ reason: "not_an_issue", severity: null, disabled: true }),
      dismissal({ reason: "handled_elsewhere", severity: "low" }),
      dismissal({ reason: "not_worth_it", severity: "medium", origin: "member" }),
      entry({
        evidence: {
          path: "README.md",
          sha: SHA,
          range: { start: 3, end: 3 },
          pullRequestNumber: 1,
        },
      }),
      entry({ confidence: 0, disabled: true }),
    ];
    const rendered = renderMemoryContext({ repository: "acme/api", entries });
    expect(rendered.exported).toBe(entries.length);
    expect(rendered.dropped).toBe(0);
    const parsed = parseMemoryContext(rendered.markdown);
    expect(parsed).toEqual({ ok: true, repository: "acme/api", entries: exportOrder(entries) });
  });

  it("round-trips tricky text and paths, and never lets them become markdown", () => {
    const entries = TRICKY.map((text, i) => {
      expect(textProblem(text.trim(), "line"), text).toBeUndefined();
      return entry({
        kind: (["convention", "decision", "dismissal"] as const)[i % 3]!,
        reason: i % 3 === 2 ? "intentional" : null,
        text: text.trim(),
        evidence: {
          path: [
            "docs/# notes.md",
            "src/a_b/*.ts",
            "src/<x>/[id].tsx",
            "a, lines 1-2, commit x.ts",
          ][i % 4]!,
          sha: SHA,
          range: { start: i + 1, end: i + 2 },
          pullRequestNumber: 100 + i,
        },
      });
    });
    const { markdown, exported } = renderMemoryContext({ repository: "acme/my_repo", entries });
    expect(exported).toBe(entries.length);
    expect(parseMemoryContext(markdown)).toEqual({
      ok: true,
      repository: "acme/my_repo",
      entries: exportOrder(entries),
    });

    const lines = markdown.split("\n");
    // The only headings are the file's own; every entry is exactly one top-level list item.
    expect(lines.filter((l) => l.startsWith("#"))).toEqual([
      "# Project memory: acme/my\\_repo",
      "## Conventions",
      "## Decisions",
      "## Dismissals",
    ]);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(entries.length);
    for (const line of lines.filter((l) => l.startsWith("- "))) {
      const content = line.slice(2);
      expect(unescapedSyntax(content), line).toEqual([]);
      // A list, quote or heading marker at the start is escaped too.
      expect(content, line).not.toMatch(/^(?:[-+=>#]|\d{1,9}[.)])/u);
    }
    for (const line of lines.filter((l) => l.startsWith("  - Evidence: "))) {
      expect(unescapedSyntax(line.replace(/, PR #\d+$/u, "")), line).toEqual([]);
    }
  });

  it("round-trips any valid one-line text and never renders a link (property)", () => {
    // `h`, `t`, `p`, `w`, `.`, `:`, `/` and `@`, so GFM autolink shapes (www., http://, a@b.c)
    // can come up; the tricky cases above hold them verbatim.
    const alphabet = fc.constantFrom(
      ..."abchptwWXYZ019 .,;:'\"()-+=/\\`*_[]<>#|~&!$%^{}@?éß東🎉".split(/(?:)/u),
    );
    fc.assert(
      fc.property(fc.array(alphabet, { minLength: 1, maxLength: 120 }), (chars) => {
        const text = chars.join("").replace(/\s+/gu, " ").trim();
        fc.pre(text.length > 0 && textProblem(text, "line") === undefined);
        fc.pre(!containsPromptCanaryFragment(text));
        const e = entry({ text });
        const { markdown } = renderMemoryContext({ repository: "acme/api", entries: [e] });
        expect(parseMemoryContext(markdown)).toEqual({
          ok: true,
          repository: "acme/api",
          entries: [e],
        });
        const html = micromark(markdown, {
          allowDangerousHtml: true,
          extensions: [gfm()],
          htmlExtensions: [gfmHtml()],
        });
        expect(html).not.toContain("<a ");
      }),
      { numRuns: 400, seed: 3803 },
    );
  });

  it("escapes and unescapes as inverses", () => {
    for (const text of TRICKY) expect(unescapeMarkdownText(escapeMarkdownText(text))).toBe(text);
    expect(escapeMarkdownText("1. a")).toBe("1\\. a");
    expect(escapeMarkdownText("<b>")).toBe("\\<b\\>");
  });

  it("reads a file whose line ends a checkout turned into CRLF", () => {
    const entries = [entry(), dismissal()];
    const { markdown } = renderMemoryContext({ repository: "acme/api", entries });
    expect(parseMemoryContext(markdown.replaceAll("\n", "\r\n"))).toEqual({
      ok: true,
      repository: "acme/api",
      entries: exportOrder(entries),
    });
  });

  it("writes an empty memory as such, and reads it back", () => {
    const { markdown, exported } = renderMemoryContext({ repository: "acme/api", entries: [] });
    expect(exported).toBe(0);
    expect(markdown).toContain("No entries.");
    expect(parseMemoryContext(markdown)).toEqual({ ok: true, repository: "acme/api", entries: [] });
  });

  it("leaves out an entry that holds a canary fragment or breaks the text rules, and says how many", () => {
    const entries = [
      entry(),
      entry({ text: `see ${PROMPT_CANARY}` }),
      entry({ text: `half ${MEMORY_CANARY.slice(3, 14)}` }),
      entry({ evidence: { ...entry().evidence, path: `src/${PROMPT_CANARY}.ts` } }),
      entry({ text: "two\nlines" }),
      entry({ text: "" }),
      entry({ text: " padded " }),
      entry({ kind: "convention", reason: "intentional" }),
      entry({ kind: "decision", severity: "high" }),
    ];
    const { markdown, exported, dropped } = renderMemoryContext({
      repository: "acme/api",
      entries,
    });
    expect(exported).toBe(1);
    expect(dropped).toBe(entries.length - 1);
    expect(containsPromptCanaryFragment(markdown)).toBe(false);
    expect(markdown).not.toContain("rk-canary");
  });

  it("carries no author, id or timestamp (nothing a person could be found by)", () => {
    const withExtras = {
      ...entry(),
      id: "6f1c2b9e-3a4d-4c5e-8f70-1a2b3c4d5e6f",
      author: { kind: "member", memberId: "m-1", login: "alice-reviewer" },
      createdAt: new Date("2026-11-01T10:00:00Z"),
      lastUsedAt: new Date("2026-11-05T10:00:00Z"),
    } as MemoryExportEntry;
    const { markdown } = renderMemoryContext({ repository: "acme/api", entries: [withExtras] });
    expect(markdown).not.toContain("alice-reviewer");
    expect(markdown).not.toContain("6f1c2b9e");
    expect(markdown).not.toContain("2026");
    expect(markdown).not.toContain("m-1");
  });

  it("is the same file for the same entries (no dates: a commit changes only with the memory)", () => {
    const entries = [entry(), dismissal()];
    expect(renderMemoryContext({ repository: "acme/api", entries }).markdown).toBe(
      renderMemoryContext({ repository: "acme/api", entries }).markdown,
    );
  });

  it("refuses what the renderer would not write, with the line", () => {
    const { markdown } = renderMemoryContext({ repository: "acme/api", entries: [dismissal()] });
    const broken = (from: string, to: string) => parseMemoryContext(markdown.replace(from, to));
    expect(parseMemoryContext("hello")).toMatchObject({
      ok: false,
      line: 1,
      problem: "missing_heading",
    });
    expect(broken(MEMORY_EXPORT_FORMAT_LINE, "Format: 2")).toMatchObject({
      ok: false,
      problem: "missing_format_line",
    });
    expect(broken("  - Reason: intentional, covers findings up to high\n", "")).toMatchObject({
      ok: false,
      problem: "invalid_reason",
    });
    expect(broken("  - Reason: intentional", "  - Reason: because")).toMatchObject({
      ok: false,
      problem: "invalid_reason",
    });
    expect(broken("Confidence: 80", "Confidence: 101")).toMatchObject({
      ok: false,
      problem: "invalid_confidence",
    });
    expect(broken("lines 10-12", "lines 12-10")).toMatchObject({
      ok: false,
      problem: "invalid_evidence",
    });
    expect(broken("## Dismissals", "## Notes")).toMatchObject({
      ok: false,
      problem: "unexpected_line",
    });
    expect(broken(`commit ${SHA}`, "commit abc")).toMatchObject({
      ok: false,
      problem: "unexpected_line",
    });
    expect(parseMemoryContext(`${markdown}\n## Dismissals\n`)).toMatchObject({
      ok: false,
      problem: "unexpected_section",
    });
    expect(parseMemoryContext(`${markdown}- extra entry\n`)).toMatchObject({
      ok: false,
      problem: "incomplete_entry",
    });
    // Text that the store would refuse is refused on the way back in too.
    expect(broken("- Use", `- ${PROMPT_CANARY} Use`)).toMatchObject({ ok: false });
    // The preamble is compared exactly, and the repository must be a GitHub name (review N2).
    expect(broken("Rocky quotes these", "Rocky obeys these")).toMatchObject({
      ok: false,
      line: 3,
      problem: "invalid_preamble",
    });
    expect(
      parseMemoryContext(markdown.replace("Format", "## Conventions\n\nFormat")),
    ).toMatchObject({ ok: false });
    for (const name of ["acme", "acme/api/x", "-acme/api", "acme/..", "acme/a b"])
      expect(broken("acme/api", name), name).toMatchObject({
        ok: false,
        problem: "invalid_repository",
      });
  });
});

/** HTML entities micromark writes for text. */
const decode = (html: string): string =>
  html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

describe("the export as GitHub renders it (review S1)", () => {
  /** GFM (autolinks, tables, strikethrough, footnotes, task lists) with raw HTML let through. */
  const render = (markdown: string): string =>
    micromark(markdown, {
      allowDangerousHtml: true,
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
    });

  it("renders every tricky text and path as literal text: no link, heading, HTML or markup", () => {
    for (const [i, text] of TRICKY.entries()) {
      const path = [
        "docs/# notes.md",
        "src/a_b/*.ts",
        "src/<x>/[id].tsx",
        "www.evil.example/a@b.ts",
      ][i % 4]!;
      const e = entry({ text: text.trim(), evidence: { ...entry().evidence, path } });
      const { markdown, exported } = renderMemoryContext({ repository: "acme/api", entries: [e] });
      expect(exported, text).toBe(1);
      const html = render(markdown);
      // The file's own structure only: one h1, one h2, no links, images or raw HTML.
      expect(html.match(/<h[1-6]>/gu), text).toEqual(["<h1>", "<h2>"]);
      for (const tag of [
        "<a ",
        "<img",
        "<script",
        "<details",
        "<!--",
        "<table",
        "<del",
        "<em",
        "<strong",
        "<code",
        "<input",
        "<sup",
        "<blockquote",
        "<ol",
      ])
        expect(html, `${text} → ${tag}`).not.toContain(tag);
      // The entry's item holds exactly its text, as text.
      const item = /<li>([^<\n]*)\n?<ul>/u.exec(html)?.[1];
      expect(item === undefined ? undefined : decode(item), text).toBe(text.trim());
      expect(html, text).toContain(
        `<li>Evidence: ${path.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}, `,
      );
    }
  });

  it("a renderer without the escaping would link them (the test can fail)", () => {
    expect(render("- https://evil.example/login")).toContain(
      '<a href="https://evil.example/login"',
    );
    expect(render("- www.evil.example")).toContain("<a ");
    expect(render("- someone@evil.example")).toContain('<a href="mailto:');
  });
});
