/**
 * The documented text normalisation (README "Safety seam", ADR 0022), written out a second time
 * and in separate stages for the tests, so the renderer's implementation is checked against the
 * rules rather than against itself. Test helper; not part of the package's main export.
 */
const LINE_BREAK = new Set([0x09, 0x0a, 0x0d, 0x85, 0x2028, 0x2029]);
const JOINERS = new Set([0x200c, 0x200d]);
const SELECTORS = new Set([0xfe0e, 0xfe0f]);
const DROPPED =
  /^(?:\p{Cc}|\p{Cs}|\p{Noncharacter_Code_Point}|\p{Default_Ignorable_Code_Point}|\p{Cf}|\u2800)$/u;
const MARK = /^\p{M}$/u;
const SPACE = /^[\s\p{Z}]$/u;
const EMOJI_OR_SYMBOL = /^[\p{Extended_Pictographic}\p{S}]$/u;
const MAX_MARK_RUN = 6;
const MAX_INVISIBLE = 32;

const char = (point: number): string =>
  point >= 0xd800 && point <= 0xdfff ? "\uD800" : String.fromCodePoint(point);
const isMark = (point: number): boolean => MARK.test(char(point));
const isSpace = (point: number): boolean => SPACE.test(char(point));
const isBase = (point: number | undefined): boolean =>
  point !== undefined &&
  !JOINERS.has(point) &&
  !SELECTORS.has(point) &&
  !isSpace(point) &&
  !isMark(point);

/**
 * 1. Tab, CR, LF, NEL and the line and paragraph separators become a space.
 * 2. Dropped: control characters, lone surrogates, non-characters, every default-ignorable or
 *    format character (zero-width, bidi controls, tags, soft hyphen, BOM…) except ZWNJ, ZWJ,
 *    VS15 and VS16, and the braille blank.
 * 3. VS15/VS16 are kept only straight after a kept emoji or symbol. ZWNJ/ZWJ are kept only after
 *    a kept character that is neither a space nor ZWNJ/ZWJ, and before a character that is not
 *    a space, mark, joiner or selector. At most 32 of the four are kept, and a ZWNJ/ZWJ only
 *    while the kept ZWNJ/ZWJ, itself included, are at most half (rounded up) of the drawn
 *    characters before it plus the one after it.
 * 4. A run of combining marks keeps its first six (joiners and selectors do not break a run).
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

  // Steps 1 and 2.
  const visible = points.flatMap((point) => {
    if (LINE_BREAK.has(point)) return [0x20];
    if (JOINERS.has(point) || SELECTORS.has(point)) return [point];
    return DROPPED.test(char(point)) ? [] : [point];
  });

  // Steps 3 and 4.
  const kept: number[] = [];
  let invisible = 0;
  let joiners = 0;
  let drawn = 0;
  let marks = 0;
  visible.forEach((point, index) => {
    const previous = kept.at(-1);
    if (SELECTORS.has(point)) {
      const onBase = previous !== undefined && EMOJI_OR_SYMBOL.test(char(previous));
      if (onBase && invisible < MAX_INVISIBLE) {
        kept.push(point);
        invisible += 1;
      }
      return;
    }
    if (JOINERS.has(point)) {
      const before = previous !== undefined && !JOINERS.has(previous) && !isSpace(previous);
      const after = isBase(visible[index + 1]);
      const ratio = joiners + 1 <= Math.ceil((drawn + 1) / 2);
      if (before && after && ratio && invisible < MAX_INVISIBLE) {
        kept.push(point);
        invisible += 1;
        joiners += 1;
      }
      return;
    }
    if (isMark(point)) {
      marks += 1;
      if (marks <= MAX_MARK_RUN) kept.push(point);
      return;
    }
    marks = 0;
    if (!isSpace(point)) drawn += 1;
    kept.push(point);
  });

  // Step 5.
  const text = (list: number[]) => list.map((point) => String.fromCodePoint(point)).join("");
  if (kept.length <= cap) return text(kept);
  const cut = kept.slice(0, cap);
  while (JOINERS.has(cut.at(-1) ?? 0)) cut.pop();
  return `${text(cut)}…`;
};
