import { describe, expect, it } from "vitest";
import { codePoint, codeSpans, splitControls } from "./text.js";

describe("splitControls", () => {
  it("separates invisible bidi controls from the text around them", () => {
    expect(splitControls("a‮b⁦c")).toEqual([
      { control: false, text: "a" },
      { control: true, text: "‮" },
      { control: false, text: "b" },
      { control: true, text: "⁦" },
      { control: false, text: "c" },
    ]);
  });

  it("returns the text unchanged when there is no control", () => {
    expect(splitControls("plain é 日本")).toEqual([{ control: false, text: "plain é 日本" }]);
    expect(splitControls("")).toEqual([]);
  });

  it("finds zero-width, invisible-operator, separator and BOM characters", () => {
    const all = "\u200B\u200C\u200D\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u180E\u2028\u2029";
    expect(splitControls(all).every((p) => p.control)).toBe(true);
    expect(splitControls(all)).toHaveLength(all.length);
  });

  it("finds a zero-width character inside a string literal", () => {
    expect(splitControls('const role = "ad\u200Bmin";')).toEqual([
      { control: false, text: 'const role = "ad' },
      { control: true, text: "\u200B" },
      { control: false, text: 'min";' },
    ]);
  });

  it("marks each tag character of a run (astral code points, whole)", () => {
    const tags = "\u{E0041}\u{E0042}\u{E007F}";
    const parts = splitControls(`x${tags}y`);
    expect(parts.map((p) => p.control)).toEqual([false, true, true, true, false]);
    expect(parts.filter((p) => p.control).map((p) => codePoint(p.text))).toEqual([
      "U+E0041",
      "U+E0042",
      "U+E007F",
    ]);
  });

  it("finds every bidi control and mark", () => {
    const all = "؜‎‏‪‫‬‭‮⁦⁧⁨⁩";
    expect(splitControls(all).every((p) => p.control)).toBe(true);
    expect(splitControls(all)).toHaveLength(all.length);
  });
});

describe("codeSpans", () => {
  it("splits backtick spans out of flag text, keeping the rest as prose", () => {
    expect(codeSpans("Token uses `crypto.randomBytes`. Fine.")).toEqual([
      { code: false, text: "Token uses " },
      { code: true, text: "crypto.randomBytes" },
      { code: false, text: ". Fine." },
    ]);
  });

  it("keeps an unmatched backtick as text", () => {
    expect(codeSpans("a `b")).toEqual([{ code: false, text: "a `b" }]);
    expect(codeSpans("`a` `b")).toEqual([
      { code: true, text: "a" },
      { code: false, text: " `b" },
    ]);
  });

  it("keeps markup as text", () => {
    expect(codeSpans("`<img onerror=x>` <b>")).toEqual([
      { code: true, text: "<img onerror=x>" },
      { code: false, text: " <b>" },
    ]);
  });
});
