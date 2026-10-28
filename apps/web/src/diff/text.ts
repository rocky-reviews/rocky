/**
 * Text helpers for the diff view (P6-3). Both return plain parts that the view renders as React
 * text children; nothing here produces HTML.
 */

/**
 * Characters that are invisible or reorder text. In code they can make a line read differently
 * from what runs ("Trojan Source", CVE-2021-42574; zero-width and tag characters hide content),
 * so the view shows each one as a visible `U+XXXX` marker:
 * - bidi controls and marks: U+061C, U+200E/F, U+202A–202E, U+2066–2069;
 * - zero-width and invisible operators: U+200B–200D, U+2060–2064, U+FEFF;
 * - soft hyphen U+00AD, Mongolian vowel separator U+180E;
 * - line and paragraph separators U+2028/2029;
 * - tag characters U+E0000–E007F.
 */
const CONTROLS =
  /[\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

export type TextPart = { readonly control: boolean; readonly text: string };

export const splitControls = (text: string): TextPart[] => {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CONTROLS)) {
    if (match.index > last) parts.push({ control: false, text: text.slice(last, match.index) });
    parts.push({ control: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ control: false, text: text.slice(last) });
  return parts;
};

/** `U+202E` for a control character. */
export const codePoint = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

export type ProsePart = { readonly code: boolean; readonly text: string };

/** Flag text uses `backticks` for code (schema prose subset); everything else is prose. */
export const codeSpans = (text: string): ProsePart[] => {
  const parts: ProsePart[] = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf("`");
    const close = open === -1 ? -1 : rest.indexOf("`", open + 1);
    if (close === -1) break;
    if (open > 0) parts.push({ code: false, text: rest.slice(0, open) });
    parts.push({ code: true, text: rest.slice(open + 1, close) });
    rest = rest.slice(close + 1);
  }
  if (rest !== "") parts.push({ code: false, text: rest });
  return parts;
};
