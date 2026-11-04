import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { parseAnalysisDocument } from "@rocky-reviews/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LOWER_RISK_KEY } from "./lower-risk.js";
import { type Selection, SidebarContent } from "./Sidebar.js";
import { coverage, noiseGroup, type SidebarGroup, sidebarGroups } from "./triage-model.js";

/**
 * H4-9: the Normal, Low and noise groups are collapsed by default behind one toggle. Rendered
 * statically; the click itself is covered by `shell.e2e.spec.ts`.
 */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error(parsed.error.message);
const doc = parsed.value;
const groups = sidebarGroups(doc);
const noise = noiseGroup(doc);

const stored = (value: string | null) => (): Storage =>
  ({ getItem: (k: string) => (k === LOWER_RISK_KEY ? value : null) }) as Storage;
const throwing = (): Storage => {
  throw new Error("blocked");
};

const render = ({
  storage = stored(null),
  selection = { kind: "briefing" },
  g = groups,
}: {
  storage?: () => Storage;
  selection?: Selection;
  g?: readonly SidebarGroup[];
} = {}): string =>
  renderToStaticMarkup(
    <SidebarContent
      groups={g}
      noise={noise}
      coverage={coverage(g, new Set())}
      selection={selection}
      viewed={new Set()}
      onSelect={() => undefined}
      onToggleViewed={() => undefined}
      onMarkViewed={() => undefined}
      storage={storage}
    />,
  );

const rows = (html: string, path: string): number =>
  html.split(`aria-label="Viewed ${path}"`).length - 1;

const toggle = (html: string): string =>
  /<button[^>]*class="[^"]*lower-risk-toggle[^>]*>[^<]*/.exec(html)?.[0] ?? "";

describe("lower-risk files in the sidebar (H4-9)", () => {
  it("hides Normal, Low and noise rows by default, keeping their headers and counts", () => {
    const html = render();
    expect(rows(html, "src/auth/invitations.ts")).toBe(1);
    expect(rows(html, "src/jobs/sendInviteEmail.ts")).toBe(1);
    expect(rows(html, "web/src/pages/InvitePage.tsx")).toBe(0);
    expect(rows(html, "src/api/index.ts")).toBe(0);
    expect(html).toMatch(/id="group-normal"><span>Normal<\/span><span><span aria-hidden="true">2/);
    expect(html).toMatch(/id="group-low"><span>Low<\/span>/);
    expect(html).toMatch(/id="group-noise"><span>Noise · auto-summarized<\/span>/);
    expect(html).not.toContain("noise-box");
    expect(html).not.toContain("Trust &amp; mark viewed");
  });

  it("offers one toggle naming how many files it shows, wired to the three groups", () => {
    const button = toggle(render());
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-controls="section-normal section-low section-noise"');
    expect(button).toMatch(/>Show 5 lower-risk files$/);
    const html = render();
    for (const id of ["section-normal", "section-low", "section-noise"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("shows them, and noise as today, when the saved choice says so", () => {
    const html = render({ storage: stored("shown") });
    expect(rows(html, "web/src/pages/InvitePage.tsx")).toBe(1);
    expect(rows(html, "src/api/index.ts")).toBe(1);
    expect(html).toContain("noise-box");
    expect(html).toContain("2 files (85 lines) the AI summarised as noise.");
    expect(html).toContain("Trust &amp; mark viewed");
    expect(rows(html, "pnpm-lock.yaml")).toBe(0);
    const button = toggle(html);
    expect(button).toContain('aria-expanded="true"');
    expect(button).toMatch(/>Hide lower-risk files$/);
  });

  it("falls back to the default when storage throws or holds something else", () => {
    for (const storage of [throwing, stored("true")]) {
      const html = render({ storage });
      expect(rows(html, "web/src/pages/InvitePage.tsx")).toBe(0);
      expect(toggle(html)).toContain('aria-expanded="false"');
    }
  });

  it("never hides the selected file: its group shows its rows", () => {
    const html = render({ selection: { kind: "file", path: "src/api/index.ts" } });
    expect(rows(html, "src/api/index.ts")).toBe(1);
    expect(rows(html, "web/src/pages/InvitePage.tsx")).toBe(0);
    const inNoise = render({ selection: { kind: "file", path: "pnpm-lock.yaml" } });
    expect(rows(inNoise, "pnpm-lock.yaml")).toBe(1);
  });

  it("always shows them, with no toggle, when nothing is Critical or Important", () => {
    const low = groups.filter((g) => g.level === "normal" || g.level === "low");
    const html = render({ g: low });
    expect(rows(html, "web/src/pages/InvitePage.tsx")).toBe(1);
    expect(html).toContain("noise-box");
    expect(html).not.toContain("lower-risk-toggle");
  });

  it('ignores a saved "hidden" when nothing is Critical or Important', () => {
    const low = groups.filter((g) => g.level === "normal" || g.level === "low");
    const html = render({ g: low, storage: stored("hidden") });
    expect(rows(html, "src/api/index.ts")).toBe(1);
    expect(rows(html, "web/src/pages/InvitePage.tsx")).toBe(1);
    expect(html).not.toContain("lower-risk-toggle");
  });
});

describe("the change tree button (H4-12)", () => {
  const withTree = (): string =>
    renderToStaticMarkup(
      <SidebarContent
        groups={groups}
        noise={noise}
        coverage={coverage(groups, new Set())}
        selection={{ kind: "briefing" }}
        viewed={new Set()}
        onSelect={() => undefined}
        onToggleViewed={() => undefined}
        onMarkViewed={() => undefined}
        storage={stored(null)}
        onOpenTree={() => undefined}
      />,
    );

  it("sits under the coverage card, before the briefing entry, with its t hint", () => {
    const html = withTree();
    const button = /<button[^>]*class="btn btn-sm btn-ghost tree-btn"[^>]*>.*?<\/button>/s.exec(
      html,
    )?.[0];
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toContain('aria-keyshortcuts="t"');
    expect(button).toContain('<span class="sr-only">Change </span>Tree');
    expect(button).toContain('<kbd aria-hidden="true">t</kbd>');
    expect(html.indexOf("tree-btn")).toBeGreaterThan(html.indexOf("coverage-note"));
    expect(html.indexOf("tree-btn")).toBeLessThan(html.indexOf("nav-brief"));
  });

  it("is left out when the shell offers no tree", () => {
    expect(render()).not.toContain("tree-btn");
  });
});
