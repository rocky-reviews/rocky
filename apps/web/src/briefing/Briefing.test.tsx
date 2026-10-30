import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFixtureSource, DEFAULT_PULL } from "../data/fixture-source.js";
import { parseShellData, type ShellData } from "../data/shell-data.js";
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

const main = await load(DEFAULT_PULL.number);

describe("briefing from the pr-847 analysis document", () => {
  const html = render(main);
  const t = text(html);

  it("heads it with the AI mark and the estimated time", () => {
    expect(html).toContain('<span class="ai-tag">AI briefing</span>');
    expect(t).toContain("AI briefing · est. ~7 min review");
    expect(html).toMatch(/<h2[^>]*>Briefing &amp; change map<\/h2>/);
  });

  it("shows the summary with its emphasis", () => {
    expect(html).toContain(
      '<p class="brief-summary"><bdi>Adds <strong>email invitations to orgs</strong>.',
    );
  });

  it("shows the risk verdict: level and why", () => {
    const verdict = section(html, "Critical risk");
    expect(html).toContain('class="verdict v-critical"');
    expect(text(verdict)).toContain("This PR adds a new way to gain membership in an org");
  });

  it("has a risk table with critical, important, normal and ignore rows", () => {
    expect(t).toContain("Critical 3 files need your attention");
    expect(t).toContain("Important 1 file worth a careful look");
    expect(t).toContain("Normal 2 files to skim");
    expect(t).toContain("Ignore 3 files don't matter");
    expect(html.match(/<tr\b/g)).toHaveLength(4);
  });

  it("makes every file in the risk table a button named by its full path", () => {
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    expect(table.match(/<button\b/g)).toHaveLength(9);
    expect(table).toContain('aria-label="Open src/auth/invitations.ts"');
    expect(table).toContain("<bdi>auth/invitations.ts</bdi>");
    expect(table).toContain('aria-label="Open pnpm-lock.yaml"');
  });

  it("has the change map slot: hint and legend as page HTML, the renderer's map between", () => {
    const map = section(html, "Change map");
    expect(text(map)).toContain("click a card to open its file, a badge to open its finding");
    expect(text(map)).toContain(
      "New in this PR Changed Existing, untouched Where the change matters Open findings",
    );
    expect(map).toMatch(/<div class="map-scroll"><svg [^>]*class="cm"[^>]*role="group"/);
    expect(text(map)).toMatch(/WEB .*API .*DATA .*WORKERS/);
  });

  it("makes the map's cards and badges buttons, ids under the brief- prefix (P5-3)", () => {
    const map = section(html, "Change map");
    expect(map).toContain(
      '<g class="cm-node cm-added" data-node="page" tabindex="0" role="button" ' +
        'aria-label="InvitePage web/src/pages, opens web/src/pages/InvitePage.tsx">',
    );
    expect(map.match(/role="button"/g)).toHaveLength(10);
    expect(map).toContain('id="brief-arrow-hero"');
    // No handler or style is written into the markup: the listeners are React's, delegated.
    expect(map).not.toMatch(/ on[a-z]+=| style=/i);
  });

  it("numbers the suggested path with why and score, each a button", () => {
    const path = section(html, "Suggested review path");
    expect(path.match(/<li\b/g)).toHaveLength(4);
    expect(text(path)).toContain(
      "src/auth/invitations.ts New path that grants org membership and sets the member's role. risk score 97",
    );
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

describe("briefing the pipeline wrote itself (provenance.briefingUnavailable)", async () => {
  const html = render(await fixture("briefingUnavailable"));
  const t = text(html);

  it("does not call it an AI briefing, and says why", () => {
    expect(html).not.toContain('class="ai-tag"');
    expect(t).toContain("Briefing by Rocky · est. ~7 min review");
    expect(t).toContain("AI briefing unavailable: The AI's briefing did not pass Rocky's checks.");
  });

  it("still shows the verdict, risk table and path", () => {
    expect(t).toContain("Critical risk");
    expect(t).toContain("3 files need your attention");
    expect(t).toContain("Suggested review path");
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
    expect(t).toContain("AI briefing · est. ~7 min review");
    expect(t).toContain("Suggested review path");
  });

  it("lists the files the AI could not analyse and the ones to read by hand", () => {
    expect(t).toContain("Not analysed 1 file the AI couldn't analyse: read it yourself");
    expect(html).toContain('aria-label="Open src/api/index.ts"');
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
    expect(text(html)).toContain("Critical 3 files need your attention");
  });

  it("out of date: a done document of another commit says so", async () => {
    const t = text(render(await fixture("outOfDate")));
    expect(t).toContain("This briefing is out of date");
    expect(t).toContain("an earlier commit, 9b4e1d7; the pull request's head is now 1c2d3e4.");
    expect(t).toContain("Suggested review path");
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
      summary: hostile,
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

  it("renders summary, reason, path, memory and checks as text", () => {
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("isolates bidi controls in every place they appear", () => {
    const textOnly = html.replace(/="[^"]*"/g, '=""');
    expect(textOnly).not.toMatch(/‮(?![^<]*<\/bdi>)/);
  });
});

describe("in the shell", () => {
  it("lists files the AI could not analyse in the sidebar, so they can be opened", async () => {
    const html = renderToStaticMarkup(<Shell data={await fixture("graphUnavailable")} now={0} />);
    const side = html.slice(html.indexOf('<nav id="sidebar"'), html.indexOf("</nav>"));
    expect(text(side)).toContain("Not analysed 1");
    expect(side).toContain('<li class="nav-item r-unanalysed">');
    expect(side).toContain('aria-label="Viewed src/api/index.ts"');
  });

  it("fills the main column with the briefing when it is selected", () => {
    const html = renderToStaticMarkup(<Shell data={main} now={Date.now()} />);
    const mainColumn = html.slice(html.indexOf('<main id="main"'), html.indexOf("</main>"));
    expect(text(mainColumn)).toContain("Critical 3 files need your attention");
  });
});
