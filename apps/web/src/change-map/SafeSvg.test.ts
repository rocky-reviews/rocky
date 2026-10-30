/**
 * P5-2: the change map reaches the page as React elements built from the renderer's checked
 * tree. What React writes must be the same document the renderer vetted (same elements,
 * attributes and text, so nothing is lost or hoisted, e.g. React 19's `<title>` handling), and
 * it must be inert for every hostile label in the corpus.
 */
import { renderChangeMap, type SafeSvg } from "@rocky-reviews/renderer";
import {
  canonical,
  HOSTILE_CORPUS,
  inspectSvg,
  pr847,
  withLabels,
} from "@rocky-reviews/renderer/testing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeSvgView } from "./SafeSvg.js";

const html = (svg: SafeSvg): string => renderToStaticMarkup(createElement(SafeSvgView, { svg }));

describe("SafeSvgView", () => {
  it("writes the document the renderer checked, element for element", () => {
    for (const map of [
      renderChangeMap(pr847()),
      renderChangeMap(pr847(), { idPrefix: "brief" }),
      renderChangeMap({ findings: [], provenance: { graphUnavailable: { reason: "timeout" } } }),
      // P5-3: the interactive map's tabindex, roles and names come through as written.
      renderChangeMap(pr847(), {
        idPrefix: "brief",
        interactive: { files: pr847().provenance.files.map((file) => file.path) },
      }),
    ])
      expect(canonical(html(map.tree))).toEqual(canonical(map.svg));
  });

  it("keeps tooltips inside the SVG (React does not hoist an SVG <title>)", () => {
    const out = html(renderChangeMap(pr847()).tree);
    expect(out.startsWith("<svg")).toBe(true);
    expect(out).toMatch(/<g class="cm-node[^"]*"[^>]*><title>/);
  });

  for (const { technique, label } of HOSTILE_CORPUS)
    it(`is inert and faithful for ${technique}: ${JSON.stringify(label.slice(0, 40))}`, () => {
      const map = renderChangeMap(withLabels(label));
      const out = html(map.tree);
      inspectSvg(out);
      expect(canonical(out)).toEqual(canonical(map.svg));
    });

  it("refuses anything the renderer did not build and check", () => {
    const { tree } = renderChangeMap(pr847());
    const forged = [
      structuredClone(tree),
      { ...tree },
      { name: "svg", attributes: [["onload", "alert(1)"]], children: [] },
      tree.children?.[1],
    ] as unknown as SafeSvg[];
    for (const svg of forged) expect(() => html(svg)).toThrow(/not a change map/);
  });
});
