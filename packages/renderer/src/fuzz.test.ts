/**
 * Property tests (P5-2): random hostile strings, built from code units (so lone surrogates
 * occur), whole code points, and fragments of markup, entities, URLs and invisible characters.
 * Whatever the label, the map parses, walks clean, and the escaping round-trips to the
 * documented normalisation.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { renderChangeMap } from "./index.js";
import { HOSTILE_CORPUS } from "./hostile-corpus.js";
import { inspectSvg, parseXml } from "./inspect.js";
import { normalised } from "./reference-normalise.js";
import { cleanText, escapeXml } from "./svg/markup.js";
import { withLabels } from "./test-support.js";

const FRAGMENTS = [
  "<",
  ">",
  "&",
  '"',
  "'",
  "/",
  "=",
  "<script>",
  "</text>",
  "</title>",
  "<!--",
  "-->",
  "<![CDATA[",
  "]]>",
  "<?",
  "?>",
  "&amp;",
  "&#x3C;",
  "&lt",
  "javascript:",
  "data:",
  "url(#",
  ")",
  " onload=",
  "xlink:href",
  "\u202E",
  "\u2066",
  "\u200B",
  "\u200D",
  "\uFE0F",
  "\uFEFF",
  "\uD800",
  "\uDFFF",
  "\uFFFE",
  "\u0301",
  "\n",
  "\u0000",
  "ß",
  "ﬃ",
  "😀",
  ...HOSTILE_CORPUS.slice(0, 40).map(({ label }) => label.slice(0, 40)),
];

const hostileString = fc
  .array(
    fc.oneof(
      fc.constantFrom(...FRAGMENTS),
      fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit)),
      fc.integer({ min: 0, max: 0x10ffff }).map((point) => String.fromCodePoint(point)),
    ),
    { maxLength: 80 },
  )
  .map((parts) => parts.join(""));

describe("fuzz: random hostile strings", () => {
  it("normalise exactly as documented", () => {
    fc.assert(
      fc.property(hostileString, (input) => {
        expect(cleanText(input)).toBe(normalised(input));
      }),
      { numRuns: 2_000 },
    );
  });

  it("round-trip through the escaping, in text and in attributes", () => {
    fc.assert(
      fc.property(hostileString, (input) => {
        const escaped = escapeXml(input);
        const root = parseXml(
          `<svg xmlns="http://www.w3.org/2000/svg" aria-label="${escaped}"><text>${escaped}</text></svg>`,
        );
        expect(root.attributes["aria-label"]).toBe(normalised(input));
        const text = root.children[0];
        const content = typeof text === "object" ? (text.children[0] ?? "") : undefined;
        expect(content).toBe(normalised(input));
      }),
      { numRuns: 2_000 },
    );
  });

  it("render to an inert map", () => {
    fc.assert(
      fc.property(hostileString, (input) => {
        const map = renderChangeMap(withLabels(input));
        expect(map.status).toBe("rendered");
        inspectSvg(map.svg);
      }),
      { numRuns: 150 },
    );
  });
});
