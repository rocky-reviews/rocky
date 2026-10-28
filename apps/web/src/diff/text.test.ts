import { describe, expect, it } from "vitest";
import { codeSpans, splitControls } from "./text.js";

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
