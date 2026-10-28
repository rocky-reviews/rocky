/**
 * The documented text normalisation (README "Safety", ADR 0022), written out a second time and
 * step by step for the tests, so the renderer's implementation is checked against the rules
 * rather than against itself. Test helper; not part of the package's main export.
 */
const LINE_BREAK = new Set([0x09, 0x0a, 0x0d, 0x85, 0x2028, 0x2029]);
const JOINERS = new Set([0x200c, 0x200d]);
const SELECTORS = new Set([0xfe0e, 0xfe0f]);
const DROPPED =
  /^(?:\p{Cc}|\p{Cs}|\p{Noncharacter_Code_Point}|\p{Default_Ignorable_Code_Point}|\p{Cf}|\u2800)$/u;
const MARK = /^\p{M}$/u;
const SPACE = /^[\s\p{Z}]$/u;
const MAX_MARK_RUN = 6;

/**
 * 1. Tab, CR, LF, NEL and the line and paragraph separators become a space.
 * 2. Dropped: control characters, lone surrogates, non-characters, every default-ignorable or
 *    format character (zero-width, bidi controls, tags, soft hyphen, BOM…) except ZWNJ, ZWJ,
 *    VS15 and VS16, and the braille blank.
 * 3. ZWNJ or ZWJ is dropped at the start, straight after ZWNJ or ZWJ, before a space and at the
 *    end; VS15 or VS16 is dropped at the start and straight after VS15 or VS16.
 * 4. A run of combining marks keeps its first six.
 * 5. Longer than `cap` code points: the first `cap`, a trailing ZWNJ or ZWJ dropped, then "…".
 */
export const normalised = (input: string, cap = Number.POSITIVE_INFINITY): string => {
  // Code units first: a lone surrogate must be seen on its own, not as half of a pair.
  const points: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const unit = input.charCodeAt(index);
    const next = input.charCodeAt(index + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      points.push((unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000);
      index += 1;
    } else points.push(unit);
  }

  const kept: number[] = [];
  let marks = 0;
  for (const point of points) {
    if (LINE_BREAK.has(point)) {
      if (JOINERS.has(kept.at(-1) ?? 0)) kept.pop();
      kept.push(0x20);
      marks = 0;
      continue;
    }
    const character = point >= 0xd800 && point <= 0xdfff ? "\uD800" : String.fromCodePoint(point);
    const kind = JOINERS.has(point) ? JOINERS : SELECTORS.has(point) ? SELECTORS : undefined;
    if (kind !== undefined) {
      const previous = kept.at(-1);
      if (previous !== undefined && !kind.has(previous)) kept.push(point);
      continue;
    }
    if (DROPPED.test(character)) continue;
    if (SPACE.test(character) && JOINERS.has(kept.at(-1) ?? 0)) kept.pop();
    if (MARK.test(character)) {
      marks += 1;
      if (marks > MAX_MARK_RUN) continue;
    } else marks = 0;
    kept.push(point);
  }
  while (JOINERS.has(kept.at(-1) ?? 0)) kept.pop();

  const text = (points: number[]) => points.map((point) => String.fromCodePoint(point)).join("");
  if (kept.length <= cap) return text(kept);
  const cut = kept.slice(0, cap);
  while (JOINERS.has(cut.at(-1) ?? 0)) cut.pop();
  return `${text(cut)}…`;
};
