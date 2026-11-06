import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark.js";

/**
 * H4-18: the top bar's brand mark is the website's Rocky mark (it replaced the POC's gradient
 * square). Drawn in the text colour, so it follows the theme through tokens, and the same
 * strokes as the favicon.
 */

const FAVICON = join(dirname(fileURLToPath(import.meta.url)), "../../public/favicon.svg");
const paths = (svg: string) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);

describe("BrandMark", () => {
  const html = renderToStaticMarkup(<BrandMark />);

  it("is a decorative SVG drawn in the current text colour", () => {
    expect(html).toMatch(/^<svg class="brand-mark"/);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("draws the same mountain as the favicon", () => {
    const mark = paths(html);
    expect(mark.length).toBeGreaterThan(0);
    expect(mark).toEqual(paths(readFileSync(FAVICON, "utf8")));
  });

  it("the favicon's light and dark strokes are the --text tokens", () => {
    const tokens = readFileSync(join(dirname(FAVICON), "../src/styles/tokens.css"), "utf8");
    const text = [...tokens.matchAll(/--text:\s*(#[0-9a-f]+);/gi)].map((m) => m[1]);
    const strokes = [...readFileSync(FAVICON, "utf8").matchAll(/stroke:\s*(#[0-9a-f]+);/gi)].map(
      (m) => m[1],
    );
    expect(text.length).toBeGreaterThanOrEqual(2);
    expect(strokes).toEqual(text.slice(0, 2));
  });
});
