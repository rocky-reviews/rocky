import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFixtureSource, DEFAULT_PULL } from "../data/fixture-source.js";
import type { ShellData } from "../data/shell-data.js";
import { Shell } from "./Shell.js";

const NOW = Date.parse("2026-10-25T12:12:00.000Z");
const data = await createFixtureSource().load(DEFAULT_PULL);
const render = (d: ShellData = data): string => renderToStaticMarkup(<Shell data={d} now={NOW} />);

/** Text content without tags, whitespace collapsed. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("app shell layout", () => {
  const html = render();

  it("has the POC's regions as landmarks: top bar, sidebar, main and right panel", () => {
    expect(html).toMatch(/<header class="topbar"/);
    expect(html).toMatch(/<nav id="sidebar"[^>]*aria-label="Files"/);
    expect(html).toMatch(/<main id="main"/);
    expect(html).toMatch(/<aside id="review-panel"[^>]*aria-label="Review panel"/);
    expect(html.match(/<main\b/g)).toHaveLength(1);
  });

  it("starts with a skip link to the main column", () => {
    expect(html.indexOf('href="#main"')).toBeLessThan(html.indexOf("<header"));
  });

  it("gives each hidden-by-width panel a toggle wired to it", () => {
    expect(html).toMatch(/aria-label="Files" aria-controls="sidebar" aria-expanded="false"/);
    expect(html).toMatch(
      /aria-label="Review panel" aria-controls="review-panel" aria-expanded="false"/,
    );
  });
});

describe("top bar", () => {
  const bar = text(render().split("</header>")[0] ?? "");

  it("shows the PR: title, number, status, repo and branches", () => {
    expect(bar).toContain("Rocky Reviews");
    expect(bar).toContain(`Team invitations with expiring links #${data.pull.number}`);
    expect(bar).toContain("Open");
    expect(bar).toContain("acme/rocky-app");
    expect(bar).toContain("@dana-k wants to merge feat/team-invites → main");
  });

  it("shows size, file count and when it was updated", () => {
    expect(bar).toContain("+215 −3 · 9 files");
    expect(bar).toContain("updated 12 min ago");
  });

  it("shows GitHub's approvals with the approvers, and the comment count", () => {
    expect(bar).toContain("✓ 1 approval");
    expect(bar).toContain("Approved by @sam-r");
    expect(bar).toContain("4 comments");
  });

  it("links to the PR on GitHub in a new tab without an opener", () => {
    expect(render()).toContain(
      '<a class="gh-link" href="https://github.com/acme/rocky-app/pull/847" target="_blank" rel="noopener noreferrer">',
    );
  });

  it("offers the light/dark toggle", () => {
    expect(render()).toMatch(
      /<button type="button" class="mode-btn" aria-label="Switch to dark mode"/,
    );
  });

  it("shows the viewer's submitted review in the status pill", () => {
    const html = render({ ...data, myReview: "changes_requested" });
    expect(html).toContain('<span class="status-pill tone-crit">Changes requested</span>');
  });

  it("pluralises the counts", () => {
    const pull = { ...data.pull, approvers: [], commentCount: 1, changedFiles: 1 };
    const t = text(render({ ...data, pull }));
    expect(t).toContain("✓ 0 approvals");
    expect(t).toContain("1 comment");
    expect(t).toContain("· 1 file");
    expect(t).not.toContain("Approved by");
  });
});

describe("untrusted PR content", () => {
  const hostile = "<img src=x onerror=alert(1)><script>alert(2)</script>";

  it("renders title, author and branch names as text, never as markup", () => {
    const pull = { ...data.pull, title: hostile, headRef: `x"><svg onload=alert(3)>` };
    const html = render({ ...data, pull });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("drops the GitHub link when the owner, repo or number is not valid", () => {
    for (const patch of [
      { owner: "evil.com/x" },
      { repo: ".." },
      { number: -1 },
      { owner: "javascript:alert(1)//" },
    ]) {
      const html = render({ ...data, pull: { ...data.pull, ...patch } });
      expect(html).not.toContain("gh-link");
      expect(html).not.toMatch(/href="(?!#main)/);
    }
  });
});

describe("sidebar", () => {
  const html = render();
  const side = text(html.slice(html.indexOf('<nav id="sidebar"'), html.indexOf("</nav>")));

  it("shows review coverage with minutes from the analysis", () => {
    expect(side).toContain("Critical + Important reviewed 0/4");
    expect(side).toContain("About 7 min of high-risk code left");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuemax="4" aria-valuenow="0"/);
  });

  it("groups files by risk with counts, a viewed checkbox and a score", () => {
    expect(side).toMatch(/Critical 3 .*Important 1 .*Normal 2 .*Low 1/);
    expect(html).toContain('aria-label="Viewed src/auth/invitations.ts"');
    expect(side).toContain(
      "src/auth/invitations.ts 97 , risk score 97, 3 findings, worst critical",
    );
    expect(html.match(/<input type="checkbox"/g)).toHaveLength(7);
  });

  it("collapses the noise group into a summary with Trust and Show", () => {
    expect(side).toContain("Noise · auto-summarized 2");
    expect(side).toContain("2 files (85 lines) the AI summarised as noise.");
    expect(side).toContain("Trust & mark viewed");
    expect(side).not.toContain("pnpm-lock.yaml");
  });

  it("never nests one control inside another", () => {
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<(?:button|input|a)\b/s);
  });

  it("says when there is no analysis yet", () => {
    const t = text(render({ ...data, analysis: null }));
    expect(t).toContain("Files appear here once the analysis is ready.");
    expect(t).toContain("not ready yet");
  });
});
