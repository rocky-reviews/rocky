/**
 * The only way the renderer writes markup (P5-1), hardened by P5-2 (sanitisation, ADR 0022).
 *
 * Adapted from PR Lens (https://github.com/coldteadotai/pr-lens, packages/renderer/src/svg/
 * primitives.ts at 918ffe82cb1dd71d20ce70b27917aeb80a7a4b49), MIT License, Copyright (c) 2026
 * Coldtea AI. See NOTICE. Changes: the renderer builds a frozen tree rather than strings; text
 * is normalised before it is escaped; element names, attribute names, attribute values and
 * class tokens are checked against allowlists; a finished document is checked for its ids and
 * references and branded as `SafeSvg`.
 *
 * Labels come from a model by way of the schema, which bounds their length and refuses control
 * and invisible characters but not markup. The renderer does not rely on that: every text and
 * attribute value is normalised here, where it is written, and escaped when it is serialised
 * (React escapes the same tree on its own when the web app renders it). Names and most values
 * are code constants; checking them anyway means a later change cannot add a script, a
 * foreignObject, an event handler, an inline style (CSP), a link that loads anything, or a
 * class an attacker chose, without a test failing. A refusal throws: the map fails closed.
 * Errors name the attribute, never the value, because values can be PR content.
 */

// --- Text ---------------------------------------------------------------------------------------

/** Tab, CR, LF, NEL and the Unicode line and paragraph separators: drawn as one space each. */
const LINE_BREAK = /[\t\n\r\u0085\u2028\u2029]/g;

/**
 * Dropped, because XML cannot spell them (most controls, lone surrogates, U+FFFE/FFFF), because
 * they are discouraged in XML and draw nothing (C1 controls, DEL, the other non-characters), or
 * because they draw nothing and can hide, reorder or spoof the text around them: every
 * default-ignorable or format character (zero-width space, word joiner, BOM, soft hyphen, the
 * bidi embeddings, overrides, isolates and marks, the TAG block…) and the braille blank. The
 * joiners real text needs (ZWNJ, ZWJ, VS15, VS16) are not matched here; see `placeJoiners`.
 * With the `u` flag `\p{Cs}` matches only a lone surrogate, so astral characters survive.
 */
const DROPPED =
  /\p{Cc}|\p{Cs}|\p{Noncharacter_Code_Point}|\u2800|(?!\u200C|\u200D|\uFE0E|\uFE0F)[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const isJoiner = (point: number | undefined): boolean => point === ZWNJ || point === ZWJ;
const isSelector = (point: number | undefined): boolean => point === VS15 || point === VS16;
const MARK = /^\p{M}$/u;
const SPACE = /^[\s\p{Z}]$/u;
/** Combining marks kept in a row (the schema's single-line cap): Zalgo text cannot tower. */
const MAX_MARK_RUN = 6;

/** A base a variation selector may follow (the schema's rule). */
const EMOJI_OR_SYMBOL = /^[\p{Extended_Pictographic}\p{S}]$/u;
/** Joiners and selectors per string, whatever its length (the schema's MAX_JOINERS). */
const MAX_JOINERS = 32;

/** Drawn and not a joiner, selector, space or mark: what a joiner may join to. */
const isBase = (character: string | undefined): boolean => {
  if (character === undefined) return false;
  const point = character.codePointAt(0);
  return !isJoiner(point) && !isSelector(point) && !SPACE.test(character) && !MARK.test(character);
};

/**
 * Keeps a joiner or variation selector only where it joins something, after the schema's rules
 * (primitives.ts), so no run of invisible characters can carry hidden bits:
 * - VS15/VS16 only straight after an emoji or symbol (never after a space, a mark, a joiner or
 *   another selector);
 * - ZWNJ/ZWJ only after a drawn character or a placed selector, and before a drawn character
 *   that is not a mark. A ZWJ after a placed VS16 is allowed, so the heart-on-fire emoji
 *   (U+2764 U+FE0F U+200D U+1F525) survives; the schema refuses it (docs/progress.md);
 * - at most MAX_JOINERS of both, and ZWNJ/ZWJ at most one per two drawn characters, counted as
 *   the text goes, so cutting a label never changes what comes before the cut.
 * Runs of combining marks are capped too. Works on code points, after `DROPPED`.
 */
const placeJoiners = (text: string): string => {
  const input = [...text];
  const kept: string[] = [];
  let marks = 0;
  let invisible = 0;
  let joiners = 0;
  let drawn = 0;
  for (const [index, character] of input.entries()) {
    const point = character.codePointAt(0);
    const previous = kept.at(-1);
    if (isSelector(point)) {
      if (previous !== undefined && EMOJI_OR_SYMBOL.test(previous) && invisible < MAX_JOINERS) {
        kept.push(character);
        invisible += 1;
      }
      continue; // joiners and selectors do not break a run of marks
    }
    if (isJoiner(point)) {
      const after = isBase(input[index + 1]);
      const before =
        previous !== undefined && !isJoiner(previous.codePointAt(0)) && !SPACE.test(previous);
      if (before && after && invisible < MAX_JOINERS && joiners + 1 <= Math.ceil((drawn + 1) / 2)) {
        kept.push(character);
        invisible += 1;
        joiners += 1;
      }
      continue;
    }
    if (MARK.test(character)) {
      marks += 1;
      if (marks <= MAX_MARK_RUN) kept.push(character);
      continue;
    }
    marks = 0;
    if (!SPACE.test(character)) drawn += 1;
    kept.push(character);
  }
  return kept.join("");
};

/**
 * The documented normalisation every drawn string goes through (README "Safety seam"):
 * line breaks become spaces, invisible, control and unspellable characters are dropped, joiners
 * and selectors are kept only where they join (and are capped), and combining-mark runs are
 * capped. Idempotent, and stable under cutting: a prefix of clean text is clean. No Unicode
 * normalisation form is applied: the text is drawn as the model wrote it.
 */
export const cleanText = (value: string): string =>
  placeJoiners(value.replace(LINE_BREAK, " ").replace(DROPPED, ""));

/** The XML escape alone, for values the tree already holds normalised and checked. */
const escapeOnly = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Longest tooltip (`<title>`), in code points, before an ellipsis. */
export const MAX_TITLE_LENGTH = 400;
/** Longest drawn text, in code points. The layout cuts far shorter; this is the backstop. */
export const MAX_TEXT_LENGTH = 200;

const ELLIPSIS = "…";

const cap = (text: string, max: number): string => {
  const characters = [...text];
  if (characters.length <= max) return text;
  const cut = characters.slice(0, max);
  while (isJoiner(cut.at(-1)?.codePointAt(0))) cut.pop();
  return `${cut.join("")}${ELLIPSIS}`;
};

/** For text nodes and attribute values alike; attributes are always double-quoted. */
export const escapeXml = (value: string): string => escapeOnly(cleanText(value));

// --- Allowlists ---------------------------------------------------------------------------------

/** Every element the change map draws. Nothing that runs, embeds, links, animates or styles. */
const ELEMENTS = new Set(["svg", "defs", "marker", "path", "g", "rect", "text", "title"]);
export type ElementName = "svg" | "defs" | "marker" | "path" | "g" | "rect" | "text" | "title";
const TEXT_ELEMENTS = new Set<string>(["text", "title"]);

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const NUMBER = /^-?\d+(?:\.\d+)?$/;
/** A schema id (primitives.ts ID_PATTERN): no space, quote, bracket or parenthesis. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PREFIXED_ID = /^[a-z][a-z0-9-]*$/;
/** Several schema ids separated by single spaces. */
const ID_LIST = /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?: [A-Za-z0-9][A-Za-z0-9._:/-]*)*$/;
/** Absolute moves, lines, curves and closes, as routes.ts writes them. */
const PATH_DATA = /^[MLCQZz][MLCQZz0-9 ,.-]*$/;
const MARKER_REFERENCE = /^url\(#([a-z][a-z0-9-]*)\)$/;

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const DELTAS = ["added", "modified", "removed", "unchanged"] as const;
const ARROW_TONES = [...DELTAS, "hero"] as const;

/**
 * Every class the map writes. A token outside this list (a delta or severity the schema would
 * refuse, `cm-hero` smuggled in through a field) is refused, so PR content cannot pick which
 * rules of change-map.css apply.
 */
const CLASS_TOKENS = new Set([
  "cm",
  "cm-unavailable",
  "cm-unavailable-bg",
  "cm-unavailable-title",
  "cm-unavailable-reason",
  "cm-lanes",
  "cm-lane",
  "cm-lane-bg",
  "cm-lane-label",
  "cm-edges",
  "cm-edge",
  "cm-hero",
  "cm-muted",
  "cm-animated",
  "cm-nodes",
  "cm-node",
  "cm-card",
  "cm-node-title",
  "cm-node-sub",
  "cm-badge",
  "cm-badge-bg",
  "cm-badge-count",
  "cm-labels",
  "cm-label",
  "cm-pill",
  "cm-pill-text",
  "cm-arrow",
  ...SEVERITIES.map((severity) => `cm-${severity}`),
  ...DELTAS.map((delta) => `cm-${delta}`),
  ...ARROW_TONES.map((tone) => `cm-arrow-${tone}`),
]);

const isClassList = (value: string): boolean =>
  value.length > 0 && value.split(" ").every((token) => CLASS_TOKENS.has(token));

const fixed =
  (...values: string[]) =>
  (value: string): boolean =>
    values.includes(value);
const number = (value: string): boolean => NUMBER.test(value);
const anyText = (): boolean => true;

/**
 * Every attribute the change map writes, with the shape its value must have: geometry is
 * numbers, ids are prefixed, the one URL is a fragment reference to an arrowhead, data-* hooks
 * for click-through (P5-3) hold schema ids. No `on*`, no `href`, no `style`, no presentation
 * colours, no other `url(…)`.
 */
const ATTRIBUTES: Readonly<Record<string, (value: string) => boolean>> = {
  xmlns: fixed(SVG_NAMESPACE),
  viewBox: (value) => {
    const parts = value.split(" ");
    return parts.length === 4 && parts.every(number);
  },
  width: number,
  height: number,
  x: number,
  y: number,
  rx: number,
  d: (value) => PATH_DATA.test(value),
  class: isClassList,
  id: (value) => PREFIXED_ID.test(value),
  role: fixed("img"),
  "aria-label": anyText,
  "aria-hidden": fixed("true"),
  "text-anchor": fixed("middle"),
  "marker-end": (value) => MARKER_REFERENCE.test(value),
  markerWidth: number,
  markerHeight: number,
  refX: number,
  refY: number,
  orient: fixed("auto-start-reverse"),
  "data-node": (value) => ID.test(value),
  "data-edge": (value) => ID.test(value),
  "data-findings": (value) => ID_LIST.test(value),
};

const checkElement = (name: string): ElementName => {
  if (!ELEMENTS.has(name)) throw new Error(`change map: element <${name}> is not allowed`);
  return name as ElementName;
};

const checkAttribute = (name: string, value: string): void => {
  const valid = Object.hasOwn(ATTRIBUTES, name) ? ATTRIBUTES[name] : undefined;
  if (valid === undefined) throw new Error(`change map: attribute "${name}" is not allowed`);
  if (!valid(value)) throw new Error(`change map: this value of "${name}" is not allowed`);
};

// --- Tree ---------------------------------------------------------------------------------------

/** Text (already normalised; escaped on serialisation) or an element. */
export type SvgNode = SvgElement | string;

export type SvgElement = {
  readonly name: ElementName;
  /** Name/value pairs in the order the painter wrote them, values normalised, not escaped. */
  readonly attributes: readonly (readonly [string, string])[];
  /** `undefined` for an element written self-closing. */
  readonly children: readonly SvgNode[] | undefined;
};

declare const safe: unique symbol;
/** A whole change map that passed every check here. Only `svgDocument` makes one. */
export type SafeSvg = SvgElement & { readonly [safe]: true };

const BUILT = new WeakSet<SvgElement>();
const DOCUMENTS = new WeakSet<SvgElement>();

export type Attributes = Readonly<Record<string, string | number | undefined>>;

const attributeList = (attributes: Attributes): (readonly [string, string])[] =>
  Object.entries(attributes)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, raw]) => {
      // Free text is normalised; every other value must already have its exact shape, so an
      // id carrying a bidi control is refused rather than quietly becoming another id.
      const value = name === "aria-label" ? cleanText(String(raw)) : String(raw);
      checkAttribute(name, value);
      return Object.freeze([name, value] as const);
    });

const build = (
  name: string,
  attributes: Attributes,
  children: readonly SvgNode[] | undefined,
): SvgElement => {
  const element = Object.freeze({
    name: checkElement(name),
    attributes: Object.freeze(attributeList(attributes)),
    children: children === undefined ? undefined : Object.freeze([...children]),
  });
  BUILT.add(element);
  return element;
};

const checkChild = (parent: string, child: SvgNode): void => {
  if (typeof child === "string") {
    // Between elements, only the newlines `lines` writes; text lives in text and title.
    if (child !== "\n") throw new Error(`change map: text inside <${parent}> is not allowed`);
  } else if (!BUILT.has(child)) {
    throw new Error(`change map: a child of <${parent}> was not built here`);
  }
};

/** A self-closing element. */
export const tag = (name: string, attributes: Attributes): SvgElement =>
  build(name, attributes, undefined);

/** An element around `children`, which must be elements from this module or `lines` newlines. */
export const wrap = (name: string, attributes: Attributes, children: readonly SvgNode[]) => {
  if (TEXT_ELEMENTS.has(name)) throw new Error("change map: use textElement for text");
  for (const child of children) checkChild(name, child);
  return build(name, attributes, children);
};

/** An element holding normalised, capped text. */
export const textElement = (
  name: "text" | "title",
  attributes: Attributes,
  content: string,
): SvgElement => {
  if (!TEXT_ELEMENTS.has(name)) throw new Error("change map: textElement is for text and title");
  return build(name, attributes, [
    cap(cleanText(content), name === "title" ? MAX_TITLE_LENGTH : MAX_TEXT_LENGTH),
  ]);
};

/** Separates elements with newlines, dropping the ones that were not drawn. */
export const lines = (fragments: readonly (SvgElement | undefined)[]): SvgNode[] =>
  fragments
    .filter((fragment): fragment is SvgElement => fragment !== undefined)
    .flatMap((fragment, index) => (index === 0 ? [fragment] : ["\n", fragment]));

const walk = function* (element: SvgElement): Generator<SvgElement> {
  yield element;
  for (const child of element.children ?? []) if (typeof child !== "string") yield* walk(child);
};

/**
 * Checks a finished map as a whole and brands it: an `<svg>` root in the SVG namespace, every
 * id unique and under `prefix`, every `url(#…)` pointing at one of them.
 */
export const svgDocument = (root: SvgElement, prefix: string): SafeSvg => {
  if (!BUILT.has(root) || root.name !== "svg") throw new Error("change map: root must be <svg>");
  const ids = new Set<string>();
  const references: string[] = [];
  for (const element of walk(root)) {
    for (const [name, value] of element.attributes) {
      if (name === "xmlns" && element !== root) throw new Error("change map: nested xmlns");
      if (name === "id") {
        if (!value.startsWith(`${prefix}-`)) throw new Error("change map: id outside the prefix");
        if (ids.has(value)) throw new Error("change map: duplicate id");
        ids.add(value);
      }
      if (name === "marker-end") references.push(MARKER_REFERENCE.exec(value)?.[1] ?? "");
    }
  }
  if (!root.attributes.some(([name, value]) => name === "xmlns" && value === SVG_NAMESPACE))
    throw new Error("change map: root must be in the SVG namespace");
  for (const reference of references)
    if (!ids.has(reference)) throw new Error("change map: dangling reference");
  DOCUMENTS.add(root);
  return root as SafeSvg;
};

/** True only for the root of a map `svgDocument` checked: not a copy, not a part, not a literal. */
export const isSafeSvg = (value: unknown): value is SafeSvg =>
  typeof value === "object" && value !== null && DOCUMENTS.has(value as SvgElement);

/** The tree as markup: values escaped, double-quoted, in the order they were written. */
export const serialise = (node: SvgNode): string => {
  // Text and values were normalised and checked when the tree was built, so the string and the
  // React rendering of the same tree hold exactly the same characters. `lines` newlines stay.
  if (typeof node === "string") return node === "\n" ? node : escapeOnly(node);
  const attributes = node.attributes
    .map(([name, value]) => ` ${name}="${escapeOnly(value)}"`)
    .join("");
  if (node.children === undefined) return `<${node.name}${attributes}/>`;
  return `<${node.name}${attributes}>${node.children.map(serialise).join("")}</${node.name}>`;
};
