/**
 * Terminal-safe text (P4-8). Everything the CLI prints from a pull request or a model is
 * untrusted: a title or a finding could carry ANSI/OSC escape sequences (clear the screen, forge a
 * hyperlink, set the window title), a carriage return that overwrites "critical" with "fine", or
 * bidi controls that make text read differently from what it is. The schema already refuses most
 * of these in model output; this is the last step before the terminal, for every string.
 *
 * Unsafe code points are shown escaped (`\x1b`, `\u202e`), never dropped, so a reviewer judging
 * the output can see that something was there.
 */

/**
 * Controls (C0 but newline and tab, which the caller handles; DEL; C1, the 8-bit CSI/OSC/ST),
 * format characters (zero-width and directional marks, bidi embeddings, overrides and isolates,
 * the BOM, invisible operators, interlinear annotation controls, the invisible tag characters)
 * and the line and paragraph separators.
 */
const UNSAFE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const escape = (char: string): string => {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x100) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code > 0xffff) return `\\u{${code.toString(16)}}`;
  return `\\u${code.toString(16).padStart(4, "0")}`;
};

/** Multi-line text (a finding body): newlines and tabs kept, every other unsafe character escaped. */
export const terminalText = (text: string): string => text.replace(UNSAFE, escape);

/** A single-line field (a title, a path): newlines and tabs escaped too, so it cannot forge lines. */
export const oneLine = (text: string): string =>
  terminalText(text).replace(/[\n\t]/g, (char) => (char === "\n" ? "\\n" : "\\t"));

const utf16Escape = (char: string): string =>
  Array.from(
    { length: char.length },
    (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`,
  ).join("");

/**
 * Pretty JSON with every unsafe character as a `\u` escape: the same JSON value, safe to print.
 * `JSON.stringify` already escapes C0 controls; this covers DEL, C1, bidi and tag characters.
 * Outside strings JSON has no such characters, so every replacement lands inside a string.
 */
export const terminalJson = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(UNSAFE, utf16Escape);
