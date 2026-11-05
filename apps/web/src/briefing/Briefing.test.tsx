import type { AnalysisDocument } from "@rocky-reviews/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFixtureSource, DEFAULT_PULL } from "../data/fixture-source.js";
import { parseShellData, type ShellData } from "../data/shell-data.js";
import { memoryReviewSource } from "../drafts/testing.js";
import { memoryPostingSource } from "../finish/testing.js";
import { Shell } from "../shell/Shell.js";
import { BriefingView } from "./Briefing.js";
import { BRIEFING_FIXTURE_PULLS, type BriefingFixture } from "./fixtures.js";

const source = createFixtureSource();
const load = async (number: number): Promise<ShellData> =>
  parseShellData(await source.load({ ...DEFAULT_PULL, number }));
const fixture = (name: BriefingFixture) => load(BRIEFING_FIXTURE_PULLS[name]);

const render = (data: ShellData): string =>
  renderToStaticMarkup(
    <BriefingView
      analysis={data.analysis}
      run={data.analysisRun}
      headSha={data.pull.headSha}
      onOpenFile={() => {}}
    />,
  );

/** Text content without tags, whitespace collapsed. */
const text = (html: string): string =>
  html
    .replace(/<wbr\/>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&") // last, so "&amp;quot;" stays "&quot;"
    .replace(/\s+/g, " ")
    .trim();

/** The markup of the section whose eyebrow or heading starts with `title`. */
const section = (html: string, title: string): string => {
  const start = html.indexOf(`>${title}`);
  if (start < 0) throw new Error(`no section ${title}`);
  const end = html.indexOf('<section class="section', start);
  return html.slice(start, end < 0 ? undefined : end);
};

/** The risk level chips (`role="tab"` buttons), in order. */
const tabs = (html: string): string[] =>
  [...html.matchAll(/<button type="button" role="tab"(?:(?!<\/button>).)*<\/button>/gs)].map(
    (m) => m[0],
  );

/** The one tab panel: the selected level's files. */
const riskPanel = (html: string): string =>
  html.slice(
    html.indexOf('role="tabpanel"'),
    html.indexOf("</div>", html.indexOf('role="tabpanel"')),
  );

const main = await load(DEFAULT_PULL.number);

describe("briefing from the pr-847 analysis document", () => {
  const html = render(main);
  const t = text(html);

  it("heads it with the AI mark and no review-time estimate (H4-9)", () => {
    expect(html).toContain('<span class="ai-tag">AI briefing</span>');
    expect(t).not.toContain("min review");
    expect(t).not.toContain("AI briefing ·");
    expect(html).toMatch(/<h2[^>]*>Briefing &amp; change map<\/h2>/);
  });

  it("opens with the verdict, then the TL;DR as a bulleted list under its own heading (H4-8)", () => {
    expect(html).not.toContain("brief-summary");
    expect(html).toContain('<h3 class="h-eyebrow" id="tldr-title">TL;DR</h3>');
    const list = html.slice(
      html.indexOf('<ul class="tldr-list" aria-labelledby="tldr-title">'),
      html.indexOf("</ul>", html.indexOf('class="tldr-list"')),
    );
    expect(list.match(/<li>/g)).toHaveLength(4);
    expect(list).toContain("<li><bdi>Adds <strong>email invitations to orgs</strong>:");
    expect(list).toContain("<code>src/auth/invitations.ts</code>");
    expect(text(list)).toContain("admin included (F1).");
    // The verdict sits above the TL;DR, and the files by risk after it.
    expect(html.indexOf('class="verdict v-critical"')).toBeLessThan(html.indexOf("tldr-title"));
    expect(html.indexOf("tldr-title")).toBeLessThan(html.indexOf('role="tablist"'));
  });

  it("shows the risk verdict: level and why", () => {
    const verdict = section(html, "Critical risk");
    expect(html).toContain('class="verdict v-critical"');
    expect(text(verdict)).toContain("This PR adds a new way to gain membership in an org");
  });

  it('heads the risk levels with "Files by risk" and shows one chip per level with its count (H4-10)', () => {
    const files = section(html, "Files by risk");
    expect(html).toContain('<h3 class="h-eyebrow" id="risk-title">Files by risk</h3>');
    expect(html).not.toContain("risk-table");
    const chips = tabs(html);
    expect(chips.map((c) => text(c))).toEqual([
      "Critical 3 files",
      "Important 1 file",
      "Normal 2 files",
      "Ignore 3 files",
    ]);
    // The count is visible; "files" is for screen readers only.
    expect(chips[0]).toContain('Critical <b>3</b><span class="sr-only"> files</span>');
    expect(chips[0]).toContain('<span class="risk-dot" aria-hidden="true"></span>');
    // The old sentences are gone.
    for (const gone of ["need your attention", "worth a careful look", "to skim", "don't matter"])
      expect(text(files)).not.toContain(gone);
  });

  it("is a WAI-ARIA tablist: the selected tab is the highest risk level and controls the one panel", () => {
    expect(html).toMatch(/<div class="risk-chips" role="tablist" aria-labelledby="risk-title">/);
    const chips = tabs(html);
    for (const chip of chips) {
      expect(chip).toMatch(/^<button type="button" role="tab"/);
      expect(chip).toContain('aria-controls="risk-panel"');
    }
    expect(chips.map((c) => /aria-selected="(\w+)"/.exec(c)?.[1])).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    // Roving tabindex: only the selected tab is in the Tab order.
    expect(chips.map((c) => /tabindex="(-?\d)"/.exec(c)?.[1])).toEqual(["0", "-1", "-1", "-1"]);
    expect(chips[0]).toContain('id="risk-tab-critical"');
    expect(chips[0]).toContain('class="risk-chip r-critical"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(html).toMatch(
      /<div class="risk-files" role="tabpanel" id="risk-panel" aria-labelledby="risk-tab-critical">/,
    );
  });

  it("lists the selected level's files as buttons named by their full path", () => {
    const panel = riskPanel(html);
    expect(panel.match(/<button\b/g)).toHaveLength(3);
    expect(panel).toContain('aria-label="Open src/auth/invitations.ts"');
    expect(panel).toContain("<bdi>auth/invitations.ts</bdi>");
    expect(panel).not.toContain('aria-label="Open pnpm-lock.yaml"');
  });

  it("selects the highest risk level present by default", async () => {
    const data = await fixture("graphUnavailable");
    const doc = data.analysis;
    if (doc === null) throw new Error("PR 849 has an analysis");
    const noCritical = {
      ...doc,
      triage: { ...doc.triage, files: doc.triage.files.filter((f) => f.level !== "critical") },
    };
    const markup = renderToStaticMarkup(
      <BriefingView
        analysis={noCritical}
        run={{ status: "done" }}
        headSha={data.pull.headSha}
        onOpenFile={() => {}}
      />,
    );
    const chips = tabs(markup);
    expect(chips.map((c) => text(c).split(" ")[0])).toEqual([
      "Important",
      "Normal",
      "Not",
      "Ignore",
    ]);
    expect(chips[0]).toContain('aria-selected="true"');
    expect(markup).toContain('aria-labelledby="risk-tab-important"');
  });

  it("opens on Not analysed when only Ignore and Not analysed have files", async () => {
    const data = await fixture("graphUnavailable");
    const doc = data.analysis;
    if (doc === null) throw new Error("PR 849 has an analysis");
    const markup = renderToStaticMarkup(
      <BriefingView
        analysis={{
          ...doc,
          triage: { ...doc.triage, files: doc.triage.files.filter((f) => f.level === "low") },
        }}
        run={{ status: "done" }}
        headSha={data.pull.headSha}
        onOpenFile={() => {}}
      />,
    );
    expect(tabs(markup).map((c) => text(c))).toEqual(["Not analysed 1 file", "Ignore 2 files"]);
    expect(tabs(markup)[0]).toContain('aria-selected="true"');
    expect(markup).toContain('aria-labelledby="risk-tab-unanalysed"');
  });

  it("says so when the document lists no files", () => {
    const doc = main.analysis;
    if (doc === null) throw new Error("pr-847 has an analysis");
    const markup = renderToStaticMarkup(
      <BriefingView
        analysis={{ ...doc, triage: { files: [], noise: [] } }}
        run={{ status: "done" }}
        headSha={main.pull.headSha}
        onOpenFile={() => {}}
      />,
    );
    expect(markup).not.toContain('role="tablist"');
    expect(text(section(markup, "Files by risk"))).toContain("No files to show.");
  });

  it("has the change map slot: hint and legend as page HTML, the renderer's map between", () => {
    const map = section(html, "Change map");
    expect(text(map)).toContain("click a card to open its file, a badge to open its finding");
    expect(text(map)).toContain(
      "New in this PR Changed Existing, untouched Where the change matters Open findings",
    );
    // H4-6: Live traffic is the default style, so the map is drawn with motion.
    expect(map).toMatch(/<div class="map-scroll"><svg [^>]*class="cm cm-motion"[^>]*role="group"/);
    expect(text(map)).toMatch(/WEB .*API .*DATA .*WORKERS/);
  });

  it("makes the map's cards and badges buttons, ids under the brief- prefix (P5-3)", () => {
    const map = section(html, "Change map");
    expect(map).toContain(
      '<g class="cm-node cm-added cm-wave-0" data-node="page" tabindex="0" role="button" ' +
        'aria-label="InvitePage web/src/pages, opens web/src/pages/InvitePage.tsx">',
    );
    expect(map.match(/role="button"/g)).toHaveLength(10);
    expect(map).toContain('id="brief-arrow-hero"');
    // No handler or style is written into the markup: the listeners are React's, delegated.
    expect(map).not.toMatch(/ on[a-z]+=| style=/i);
  });

  it("has no suggested review path section (H4-11)", () => {
    expect(t).not.toContain("Suggested review path");
    expect(t).not.toContain("No suggested order");
    expect(html).not.toContain("path-list");
    expect(html).not.toContain("New path that grants org membership");
  });

  it("lists the project memory applied with its source", () => {
    // The source's PR number is matched loosely: the raw-colour check reads "#" + digits as hex.
    expect(text(section(html, "Project memory applied"))).toMatch(
      /Secrets and tokens are stored hashed, never raw · decision · PR .612/,
    );
  });

  it('lists what the AI checked under "AI checked, looks fine"', () => {
    expect(text(section(html, "AI checked, looks fine"))).toContain(
      "Tokens are 256-bit and come from a CSPRNG",
    );
  });

  it("offers to start with the riskiest file", () => {
    expect(t).toContain("Start with the riskiest file");
    expect(html).toMatch(
      /<button[^>]*class="btn btn-primary"[^>]*data-path="src\/auth\/invitations.ts"/,
    );
  });

  it("never nests one control inside another", () => {
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<(?:button|input|a)\b/s);
  });
});

describe("a document written before schema 1.4 (summary paragraph, no TL;DR)", async () => {
  const html = render(await fixture("summaryOnly"));

  it("shows the summary with its emphasis, above the verdict, as before (H4-8)", () => {
    expect(html).toContain(
      '<p class="brief-summary"><bdi>Adds <strong>email invitations to orgs</strong>.',
    );
    expect(html).not.toContain("TL;DR");
    expect(html).not.toContain("tldr-list");
    expect(html.indexOf("brief-summary")).toBeLessThan(html.indexOf('class="verdict v-critical"'));
    expect(text(section(html, "Critical risk"))).toContain("The UI and wiring look routine.");
  });
});

describe("briefing the pipeline wrote itself (provenance.briefingUnavailable)", async () => {
  const html = render(await fixture("briefingUnavailable"));
  const t = text(html);

  it("does not call it an AI briefing, and says why", () => {
    expect(html).not.toContain('class="ai-tag"');
    expect(t).toContain("Briefing by Rocky");
    expect(t).not.toContain("min review");
    expect(t).toContain("AI briefing unavailable: The AI's briefing did not pass Rocky's checks.");
  });

  it("still shows the verdict, risk table and the start button", () => {
    expect(html).toContain('<p class="brief-summary"><bdi>Rocky could not produce');
    expect(html).not.toContain("TL;DR");
    expect(t).toContain("Critical risk");
    expect(t).toContain("Critical 3 files");
    expect(t).toContain("Start with the riskiest file");
  });

  it("says memory and checks are not available without the AI briefing", () => {
    expect(t.match(/Not available without the AI briefing\./g)).toHaveLength(2);
    expect(t).not.toContain("No project memory was applied.");
  });
});

describe("change map unavailable (provenance.graphUnavailable)", async () => {
  const html = render(await fixture("graphUnavailable"));
  const t = text(html);

  it("shows the fixed reason instead of the map, and no legend or hint", () => {
    const map = text(section(html, "Change map"));
    expect(map).toContain("Change map unavailable This pull request is too large to map.");
    expect(map).not.toContain("click a card");
    expect(map).not.toContain("New in this PR");
  });

  it("keeps the rest of the briefing", () => {
    expect(t).toContain("AI briefing");
    expect(t).toContain("Project memory applied");
  });

  it("lists the files the AI could not analyse and the ones to read by hand", () => {
    // Files to read by hand rank above Ignore, as in the sidebar.
    expect(tabs(html).map((c) => text(c).split(" ")[0])).toEqual([
      "Critical",
      "Important",
      "Normal",
      "Not",
      "Ignore",
    ]);
    expect(tabs(html)[3]).toContain('aria-selected="false"');
    expect(t).toContain(
      "Read by hand: the AI reviewed these risky files and drafted nothing. sendInviteEmail.ts",
    );
  });
});

describe("a document that is not the latest word", () => {
  it("has no banner when the document is of the PR's head and the run is done", () => {
    expect(render(main)).not.toContain("brief-banner");
  });

  it("re-analysing: the previous briefing under a live banner", async () => {
    const html = render(await fixture("reanalysing"));
    expect(html).toMatch(/<div class="brief-banner tone-ai" role="status">/);
    expect(text(html)).toContain(
      "Re-analysing the latest push… Showing the briefing for an earlier commit, 9b4e1d7; the pull request's head is now 1c2d3e4.",
    );
    expect(text(html)).toContain("Critical 3 files");
  });

  it("out of date: a done document of another commit says so", async () => {
    const t = text(render(await fixture("outOfDate")));
    expect(t).toContain("This briefing is out of date");
    expect(t).toContain("an earlier commit, 9b4e1d7; the pull request's head is now 1c2d3e4.");
    expect(t).toContain("Critical 3 files");
  });
});

describe("states without an analysis document", () => {
  it("no analysis yet", async () => {
    const t = text(render(await fixture("none")));
    expect(t).toContain("No analysis yet");
    expect(t).toContain("Rocky has not analysed this pull request yet.");
  });

  it("analysis in progress, announced politely", async () => {
    const html = render(await fixture("running"));
    expect(html).toContain('role="status"');
    expect(text(html)).toContain("Analysing this pull request");
  });

  it("awaiting approval shows the estimate against the limit", async () => {
    const t = text(render(await fixture("awaitingApproval")));
    expect(t).toContain("Waiting for approval");
    expect(t).toContain("about 212,000 tokens, over the per-PR limit of 150,000");
    expect(t).toContain("Nothing has been sent to a model.");
  });

  it("failed shows plain words and the fixed code", async () => {
    const t = text(render(await fixture("failed")));
    expect(t).toContain("Analysis failed");
    expect(t).toContain("Rocky can no longer read this repository");
    expect(t).toContain("Code: repository_inaccessible");
  });

  it("superseded says the revision moved on", async () => {
    const t = text(render(await fixture("superseded")));
    expect(t).toContain("Analysis out of date");
    expect(t).toContain("A newer commit was pushed or the pull request was closed");
    expect(t).not.toContain("Code:");
  });

  it("treats done without a document as no analysis yet", () => {
    const html = renderToStaticMarkup(
      <BriefingView
        analysis={null}
        run={{ status: "done" }}
        headSha={main.pull.headSha}
        onOpenFile={() => {}}
      />,
    );
    expect(text(html)).toContain("No analysis yet");
  });
});

describe("untrusted model output", () => {
  const hostile = "<img src=x onerror=alert(1)>‮";
  const doc = main.analysis;
  if (doc === null) throw new Error("pr-847 has an analysis");
  const evil = {
    ...doc,
    briefing: {
      ...doc.briefing,
      tldr: [hostile, `Second ${hostile}`],
      verdict: { ...doc.briefing.verdict, reason: hostile },
      reviewPath: doc.briefing.reviewPath.map((s) => ({ ...s, why: hostile })),
      checkedOk: [hostile],
      memoryApplied: [{ entryId: "m1", text: hostile, source: hostile }],
    },
  };
  const html = renderToStaticMarkup(
    <BriefingView
      analysis={evil}
      run={{ status: "done" }}
      headSha={main.pull.headSha}
      onOpenFile={() => {}}
    />,
  );

  it("renders the TL;DR, reason, path, memory and checks as text", () => {
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<li><bdi>Second &lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders a hostile summary paragraph as text too", () => {
    const briefing: AnalysisDocument["briefing"] = { ...evil.briefing, summary: hostile };
    delete briefing.tldr;
    const old = renderToStaticMarkup(
      <BriefingView
        analysis={{ ...evil, briefing }}
        run={{ status: "done" }}
        headSha={main.pull.headSha}
        onOpenFile={() => {}}
      />,
    );
    expect(old).not.toContain("<img");
    expect(old).toContain('<p class="brief-summary"><bdi>&lt;img src=x onerror=alert(1)&gt;');
  });

  it("isolates bidi controls in every place they appear", () => {
    const textOnly = html.replace(/="[^"]*"/g, '=""');
    expect(textOnly).not.toMatch(/‮(?![^<]*<\/bdi>)/);
  });
});

describe("in the shell", () => {
  it("lists files the AI could not analyse in the sidebar, so they can be opened", async () => {
    const html = renderToStaticMarkup(
      <Shell
        data={await fixture("graphUnavailable")}
        now={0}
        review={memoryReviewSource([])}
        posting={memoryPostingSource()}
      />,
    );
    const side = html.slice(html.indexOf('<nav id="sidebar"'), html.indexOf("</nav>"));
    expect(text(side)).toContain("Not analysed 1");
    expect(side).toContain('<li class="nav-item r-unanalysed">');
    expect(side).toContain('aria-label="Viewed src/api/index.ts"');
  });

  it("fills the main column with the briefing when it is selected", () => {
    const html = renderToStaticMarkup(
      <Shell
        data={main}
        now={Date.now()}
        review={memoryReviewSource([])}
        posting={memoryPostingSource()}
      />,
    );
    const mainColumn = html.slice(html.indexOf('<main id="main"'), html.indexOf("</main>"));
    expect(text(mainColumn)).toContain("Critical 3 files");
  });
});
