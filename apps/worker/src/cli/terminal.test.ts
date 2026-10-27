import { describe, expect, it } from "vitest";
import { oneLine, terminalJson, terminalText } from "./terminal.js";

/**
 * P4-8: model output and PR content are untrusted. Nothing they contain may reach the terminal as
 * a control sequence: ANSI/OSC escapes, C1 controls, carriage returns, bidi overrides, invisible
 * tag characters. They are shown escaped, so a reviewer sees that something was there.
 */

const ESC = "\u001b";
const DANGEROUS = [
  `${ESC}[2J${ESC}[H`, // clear screen, cursor home
  `${ESC}]8;;https://evil.example${ESC}\\link${ESC}]8;;${ESC}\\`, // OSC 8 hyperlink
  `${ESC}]0;title\u0007`, // OSC set title, BEL-terminated
  "\u009b31m", // 8-bit CSI
  "\u009d0;x\u009c", // 8-bit OSC … ST
  "ok\rLooks fine", // carriage return overwrite
  "\b\b\b", // backspaces
  "\u202eevil\u202c", // RLO … PDF
  "\u2066x\u2069\u200f\u200e\u061c", // isolates and marks
  "\u2028\u2029", // line/paragraph separators
  "\u{e0041}\u{e0042}", // tag characters (invisible ASCII)
  "\u200b\ufeff", // zero-width space, BOM
  "\u007f",
];

/** Every code point a terminal could act on, outside plain printable text, newline and tab. */
const UNSAFE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

describe("terminalText", () => {
  it("escapes every control and bidi character, visibly", () => {
    for (const text of DANGEROUS) {
      const shown = terminalText(text);
      expect(shown, JSON.stringify(text)).not.toMatch(UNSAFE);
      expect(shown.length, JSON.stringify(text)).toBeGreaterThan(0);
    }
    expect(terminalText(`${ESC}[31mred`)).toBe("\\x1b[31mred");
    expect(terminalText("a\u202eb")).toBe("a\\u202eb");
    expect(terminalText("\u{e0041}")).toBe("\\u{e0041}");
  });

  it("keeps newlines and tabs, and ordinary text untouched (accents, CJK, emoji)", () => {
    const text = "Línea uno\n\tdos — 日本語 🚀 `code` <b>";
    expect(terminalText(text)).toBe(text);
  });
});

describe("oneLine", () => {
  it("also escapes newlines and tabs, so a field cannot forge extra lines", () => {
    expect(oneLine("title\nVerdict: low\tx")).toBe("title\\nVerdict: low\\tx");
    for (const text of DANGEROUS) expect(oneLine(text)).not.toMatch(UNSAFE);
  });
});

describe("terminalJson", () => {
  it("is the same JSON value with every unsafe character as a \\u escape", () => {
    const value = { title: DANGEROUS.join(" "), nested: [{ body: "ok\u202e\u{e0041}\u0085" }] };
    const text = terminalJson(value);
    expect(text).not.toMatch(UNSAFE);
    expect(JSON.parse(text)).toEqual(value);
    expect(text).toContain("\\u202e");
    expect(text).toContain("\\udb40\\udc41");
  });
});
