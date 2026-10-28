/**
 * The markup seam (svg/markup.ts) on its own: normalisation, escaping, the element, attribute,
 * value and class allowlists, the document check and the SafeSvg brand.
 */
import { describe, expect, it } from "vitest";
import { renderChangeMap } from "./index.js";
import { normalised } from "./reference-normalise.js";
import {
  cleanText,
  escapeXml,
  isSafeSvg,
  lines,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  serialise,
  svgDocument,
  tag,
  textElement,
  wrap,
} from "./svg/markup.js";
import { pr847 } from "./test-support.js";

describe("text normalisation", () => {
  it("escapes the five XML specials and drops characters XML cannot spell", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeXml("a\u0000b\u0008c\uFFFEd")).toBe("abcd");
    expect(escapeXml("emoji 😀 stays")).toBe("emoji 😀 stays");
  });

  it.each([
    ["line breaks become spaces", "a\nb\r\nc\td\u2028e\u2029f\u0085g", "a b  c d e f g"],
    ["bidi controls are dropped", "safe\u202Eevil\u2066x\u2069\u200E\u200F", "safeevilx"],
    ["zero-width characters are dropped", "pa\u200By\u2060p\uFEFFa\u00ADl", "paypal"],
    ["tag characters are dropped", "\u{E0041}\u{E007F}ok", "ok"],
    ["lone surrogates are dropped", "a\uD800b\uDC00c\uDC00\uD800d", "abcd"],
    ["pairs survive", "😀𝒜", "😀𝒜"],
    ["non-characters are dropped", "\uFDD0a\uFFFF\u{1FFFE}b\u{10FFFF}", "ab"],
    ["C1 controls and DEL are dropped", "a\u007Fb\u0080c\u009F", "abc"],
    ["joiner runs collapse", "a\u200D\u200D\u200Db", "a\u200Db"],
    ["a leading or trailing joiner goes", "\u200Ca\u200D", "a"],
    [
      "emoji sequences survive",
      "👨\u200D👩\u200D👧 ❤\uFE0F\u200D🔥 🏳\uFE0F\u200D🌈",
      "👨\u200D👩\u200D👧 ❤\uFE0F\u200D🔥 🏳\uFE0F\u200D🌈",
    ],
    ["a trailing variation selector stays", "❤\uFE0F", "❤\uFE0F"],
    ["mark runs are capped at six", `e${"\u0301".repeat(20)}x`, `e${"\u0301".repeat(6)}x`],
    ["the braille blank goes", "a\u2800b", "ab"],
    ["alternating joiner and selector runs go", `a${"\u200D\uFE0F\u200C\uFE0E".repeat(20)}b`, "ab"],
    ["a selector after a space goes", "x \uFE0F y", "x  y"],
    ["a selector after a letter or a selector goes", "a\uFE0F\u2764\uFE0F\uFE0E", "a\u2764\uFE0F"],
    ["a joiner before a mark or a space goes", "a\u200D\u0301 b\u200D c", "a\u0301 b c"],
    [
      "heart on fire keeps its joiner",
      "\u2764\uFE0F\u200D\u{1F525}",
      "\u2764\uFE0F\u200D\u{1F525}",
    ],
    [
      "a long family keeps one joiner per two emoji",
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u{1F466}",
    ],
  ])("%s", (_, input, output) => {
    expect(cleanText(input)).toBe(output);
    expect(normalised(input)).toBe(output);
  });

  it("keeps at most 32 joiners and selectors, and one joiner per two drawn characters", () => {
    const input = `${"\u{1F600}\uFE0F\u200D".repeat(60)}\u{1F600}`;
    const out = cleanText(input);
    const invisible = [...out].filter((c) => ["\u200D", "\uFE0F"].includes(c)).length;
    const joiners = [...out].filter((c) => c === "\u200D").length;
    const drawn = [...out].filter((c) => c === "\u{1F600}").length;
    expect(invisible).toBe(32);
    expect(joiners).toBeLessThanOrEqual(Math.ceil(drawn / 2));
    expect(out).toBe(normalised(input));
  });

  it("is stable under cutting: a prefix of clean text is clean", () => {
    const clean = cleanText(
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} \u2764\uFE0F\u200D\u{1F525} x",
    );
    const characters = [...clean];
    for (let end = 0; end <= characters.length; end += 1) {
      const prefix = characters.slice(0, end).join("");
      expect(cleanText(`${prefix}\u2026`)).toBe(`${prefix}\u2026`);
    }
  });

  it("is idempotent", () => {
    for (const input of ["a\u200D\u200D", "x\u202Ey", "\u0301".repeat(9), "ok"])
      expect(cleanText(cleanText(input))).toBe(cleanText(input));
  });

  it("caps text and titles by code point, without splitting a pair", () => {
    const long = "😀".repeat(MAX_TITLE_LENGTH + 50);
    const title = textElement("title", {}, long);
    const text = textElement("text", {}, long);
    expect(title.children).toEqual([`${"😀".repeat(MAX_TITLE_LENGTH)}…`]);
    expect(text.children).toEqual([`${"😀".repeat(MAX_TEXT_LENGTH)}…`]);
    expect(
      textElement("title", {}, `${"a".repeat(MAX_TITLE_LENGTH - 1)}\u200Dzz`).children,
    ).toEqual([`${"a".repeat(MAX_TITLE_LENGTH - 1)}…`]);
  });
});

describe("the markup layer refuses what could run, load or restyle", () => {
  it.each(["script", "foreignObject", "a", "image", "use", "style", "iframe", "animate", "set"])(
    "element <%s>",
    (name) => {
      expect(() => tag(name, {})).toThrow(/element/);
      expect(() => wrap(name, {}, [])).toThrow(/element/);
    },
  );

  it.each([
    "onload",
    "onclick",
    "onbegin",
    "href",
    "xlink:href",
    "style",
    "src",
    "filter",
    "fill",
    "Onload",
    "x y",
    "data-",
    "data-X",
    "data-other",
  ])("attribute %s", (name) => {
    expect(() => tag("rect", { [name]: "1" })).toThrow(/attribute/);
  });

  it.each([
    ["x", "1;alert(1)"],
    ["width", "NaN"],
    ["height", "1e999"],
    ["viewBox", "0 0 1"],
    ["d", "M0,0 url(#x)"],
    ["class", "cm-evil"],
    ["class", "cm-hero  cm-added"],
    ["class", "cm-hero x"],
    ["class", ""],
    ["id", "Evil"],
    ["id", "cm-arrow added"],
    ["marker-end", "url(https://evil.example/x.svg#a)"],
    ["marker-end", "url(#cm-a) url(#cm-b)"],
    ["marker-end", "url('#cm-a')"],
    ["role", "button"],
    ["aria-hidden", "false"],
    ["text-anchor", "evil"],
    ["orient", "0deg"],
    ["xmlns", "http://www.w3.org/1999/xhtml"],
    ["data-node", '" onload="x'],
    ["data-node", "a  b"],
    ["data-node", "a b"],
    ["data-edge", "a b"],
    ["data-findings", "F1 <F2>"],
  ])("value %s=%j", (name, value) => {
    expect(() => tag("path", { [name]: value })).toThrow(/not allowed/);
  });

  it("never echoes a refused value in its error (errors may be logged)", () => {
    expect(() => tag("rect", { "data-node": "secret token <abc>" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret") }),
    );
  });

  it("accepts the values the renderer writes", () => {
    expect(() =>
      tag("path", {
        class: "cm-edge cm-added cm-hero",
        d: "M10,20 C30,40 50,60 70,80 Q1,2 3,4 L-1.5,2 z",
        "marker-end": "url(#cm-arrow-hero)",
        "data-edge": "web/api:call.1",
        "data-findings": "F1 F2",
      }),
    ).not.toThrow();
  });

  it("writes text only into text and title", () => {
    expect(() => textElement("g" as "text", {}, "x")).toThrow(/text and title/);
  });

  it("refuses text where only markup belongs", () => {
    expect(() => wrap("g", {}, ["hello"])).toThrow(/text/);
    expect(() => wrap("g", {}, ["\n"])).not.toThrow();
  });

  it("escapes attribute values", () => {
    expect(serialise(tag("g", { "aria-label": '"><script>' }))).toBe(
      '<g aria-label="&quot;&gt;&lt;script&gt;"/>',
    );
  });
});

describe("documents and the SafeSvg brand", () => {
  const root = (children: ReturnType<typeof tag>[]) =>
    wrap("svg", { xmlns: "http://www.w3.org/2000/svg" }, lines(children));

  it("refuses a dangling or foreign reference and a duplicate or unprefixed id", () => {
    const marker = (id: string) => wrap("marker", { id }, []);
    const path = (ref: string) => tag("path", { d: "M0,0", "marker-end": `url(#${ref})` });
    expect(() => svgDocument(root([path("cm-nowhere")]), "cm")).toThrow(/reference/);
    expect(() => svgDocument(root([marker("cm-a"), marker("cm-a")]), "cm")).toThrow(/duplicate/);
    expect(() => svgDocument(root([marker("other-a")]), "cm")).toThrow(/prefix/);
    expect(() => svgDocument(root([marker("cm-a"), path("cm-a")]), "cm")).not.toThrow();
    expect(() => svgDocument(tag("g", {}), "cm")).toThrow(/root/);
  });

  it("brands only documents the renderer built", () => {
    const map = renderChangeMap(pr847());
    expect(isSafeSvg(map.tree)).toBe(true);
    expect(isSafeSvg(structuredClone(map.tree))).toBe(false);
    expect(isSafeSvg({ ...map.tree })).toBe(false);
    expect(isSafeSvg(map.tree.children![1])).toBe(false);
    expect(isSafeSvg({ name: "svg", attributes: [], children: [] })).toBe(false);
    expect(isSafeSvg(null)).toBe(false);
    expect(isSafeSvg(map.svg)).toBe(false);
  });

  it("is frozen all the way down, so a branded tree cannot be edited after the check", () => {
    const { tree } = renderChangeMap(pr847());
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      expect(Object.isFrozen(node)).toBe(true);
      for (const value of Object.values(node)) walk(value);
    };
    walk(tree);
    expect(() => {
      (tree.children as unknown[]).push("x");
    }).toThrow();
  });

  it("serialises to exactly the string the map returns", () => {
    for (const map of [renderChangeMap(pr847()), renderChangeMap({ findings: [], provenance: {} })])
      expect(serialise(map.tree)).toBe(map.svg);
  });
});
