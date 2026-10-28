/**
 * P5-2: the map needs nothing a strict CSP (P7-3: `default-src 'self'; style-src 'self';
 * script-src 'self'`) would block. No inline style or script in the SVG, and the stylesheet that
 * colours it loads nothing. The browser half of this (a page served with that header, no
 * violation events) is apps/web/e2e/change-map-csp.e2e.spec.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderChangeMap } from "./index.js";
import { HOSTILE_CORPUS } from "./hostile-corpus.js";
import { parseXml, type XmlElement } from "./inspect.js";
import {
  deepNesting,
  longLabels,
  pr847,
  singleNode,
  wideFanOut,
  withLabels,
} from "./test-support.js";

const everyElement = function* (element: XmlElement): Generator<XmlElement> {
  yield element;
  for (const child of element.children) if (typeof child !== "string") yield* everyElement(child);
};

describe("CSP: nothing inline", () => {
  const maps = [
    pr847(),
    singleNode(),
    wideFanOut(),
    deepNesting(),
    longLabels(),
    ...HOSTILE_CORPUS.filter(({ technique }) =>
      ["styles", "handlers and links"].includes(technique),
    ).map(({ label }) => withLabels(label)),
  ].map((source) => renderChangeMap(source).svg);

  it("has no style or script element and no style, event or link attribute", () => {
    for (const svg of maps)
      for (const element of everyElement(parseXml(svg))) {
        expect(["style", "script"]).not.toContain(element.name);
        for (const name of Object.keys(element.attributes)) {
          expect(name).not.toMatch(/^(?:style|on.*|href|src|.*:href)$/i);
        }
      }
  });

  it("has a stylesheet that loads nothing (no url(), @import or expression())", () => {
    const css = readFileSync(new URL("./change-map.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/url\(|@import|expression\(|javascript:/i);
  });
});
