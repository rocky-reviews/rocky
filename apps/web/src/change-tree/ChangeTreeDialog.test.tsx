import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { type AnalysisDocument, parseAnalysisDocument } from "@rocky-reviews/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { changeTree } from "./change-tree-model.js";
import { ChangeTreeDialog } from "./ChangeTreeDialog.js";

/**
 * H4-12: the change tree modal, rendered statically. Opening it, Escape, focus return and file
 * clicks are covered by `change-tree.e2e.spec.ts`.
 */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error(parsed.error.message);
const tree = changeTree(parsed.value);

const render = (selected: string | null = null): string =>
  renderToStaticMarkup(
    <ChangeTreeDialog
      tree={tree}
      selected={selected}
      onOpenFile={() => undefined}
      onClose={() => undefined}
    />,
  );

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** The disclosure button for a folder label. */
const toggle = (html: string, label: string): string =>
  new RegExp(
    `<button[^>]*class="ct-toggle"[^>]*>(?:(?!</button>).)*?<bdi>${label}/</bdi>`,
    "s",
  ).exec(html)?.[0] ?? "";

const listFor = (html: string, button: string): string => {
  const id = /aria-controls="([^"]+)"/.exec(button)?.[1] ?? "";
  return /<ul[^>]*>/.exec(html.slice(html.indexOf(`id="${id}"`) - 40))?.[0] ?? "";
};

describe("ChangeTreeDialog (H4-12)", () => {
  const html = render();

  it("is a labelled modal dialog", () => {
    expect(html).toMatch(
      /<div id="change-tree-dialog" class="modal change-tree-modal" role="dialog" aria-modal="true" aria-labelledby="change-tree-title">/,
    );
    expect(html).toContain('<h2 id="change-tree-title">Change tree</h2>');
    expect(html).toContain('aria-label="Close"');
  });

  it("says how many files, folders and files to read", () => {
    expect(text(html)).toContain("9 files in 8 folders · 4 to read carefully");
  });

  it("gives each folder a disclosure button; the riskiest starts expanded", () => {
    const src = toggle(html, "src");
    expect(src).toContain('aria-expanded="true"');
    expect(listFor(html, src)).not.toContain("hidden");
    const db = toggle(html, "db/migrations");
    expect(db).toContain('aria-expanded="false"');
    expect(db).toContain('title="db/migrations"');
    expect(listFor(html, db)).toContain("hidden");
  });

  it("shows a folder's counts, new tag, lines and risk bar", () => {
    // src holds modified (ignored) files, so it is not new; src/auth is.
    expect(text(html)).toContain("src/ 4 files · 3 to read");
    expect(text(html)).toContain("auth/ new 2 files · 1 to read");
    expect(html).toContain('aria-label="2 critical, 1 important, 1 normal"');
    expect(text(html)).toMatch(/\+91\b/);
  });

  it("names the key files and folds the rest into a line that lists them", () => {
    // src/auth: the critical file named, the test folded.
    expect(html).toContain('aria-label="Open src/auth/invitations.ts (critical)"');
    expect(text(html)).toContain("+ 1 more file (1 test)");
    expect(html).not.toContain('aria-label="Open src/auth/invitations.test.ts (normal)"');
  });

  it("keeps the ignored files in one collapsed line", () => {
    const ignored = /<button[^>]*class="ct-toggle"[^>]*aria-controls="ct-ignored"[^>]*>/.exec(
      html,
    )?.[0];
    expect(ignored).toContain('aria-expanded="false"');
    expect(text(html)).toContain("Ignored · low risk and noise 3 files");
    expect(/<ul[^>]*id="ct-ignored"[^>]*>/.exec(html)?.[0]).toContain("hidden");
  });

  it("highlights the selected file and reveals it", () => {
    const sel = render("src/auth/invitations.test.ts");
    expect(sel).toMatch(/class="ct-file r-normal sel"/);
    expect(sel).toMatch(
      /aria-current="true"[^>]*aria-label="Open src\/auth\/invitations.test.ts \(normal\)"|aria-label="Open src\/auth\/invitations.test.ts \(normal\)"[^>]*aria-current="true"/,
    );
    expect(text(sel)).not.toContain("+ 1 more file");
    const lock = render("pnpm-lock.yaml");
    expect(/<ul[^>]*id="ct-ignored"[^>]*>/.exec(lock)?.[0]).not.toContain("hidden");
  });

  it("lists unanalysed files in a visible group", () => {
    const doc: AnalysisDocument = {
      ...parsed.value,
      provenance: {
        ...parsed.value.provenance,
        unanalysed: [{ path: "assets/logo.bin", reason: "binary" }],
      },
    };
    const withUnanalysed = changeTree(doc);
    const out = renderToStaticMarkup(
      <ChangeTreeDialog
        tree={withUnanalysed}
        selected={null}
        onOpenFile={() => {}}
        onClose={() => {}}
      />,
    );
    expect(text(out)).toContain("Not analysed 1 file");
    // In the legend too, only when the group is there.
    expect(out).toMatch(/<span class="ct-dot r-unanalysed"><\/span>Not analysed<\/span>/);
    expect(html).not.toMatch(/<span class="ct-dot r-unanalysed"><\/span>Not analysed<\/span>/);
    expect(out).toContain('aria-label="Open assets/logo.bin (not analysed)"');
  });
});
