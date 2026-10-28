/**
 * The only way the renderer writes markup, and the seam P5-2 (sanitisation) hardens.
 *
 * Adapted from PR Lens (https://github.com/coldteadotai/pr-lens, packages/renderer/src/svg/
 * primitives.ts at 918ffe82cb1dd71d20ce70b27917aeb80a7a4b49), MIT License, Copyright (c) 2026
 * Coldtea AI. See NOTICE. Changes: the single quote is escaped too, and element and attribute
 * names are checked against an allowlist.
 *
 * Labels come from a model by way of the schema, which bounds their length and refuses control
 * characters but not markup, so every text and attribute value is escaped here, where it is
 * written. Names are code constants; checking them anyway means a later change cannot add a
 * script, a foreignObject, an event handler, an inline style (CSP) or a link that loads
 * anything without a test failing.
 */

/**
 * Code points XML 1.0 has no spelling for: most control characters, the surrogate halves and
 * the two non-characters at the end of the basic plane. Dropped, because there is no escape.
 * Matching by code point keeps a well-formed astral character (a surrogate pair) intact.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_IN_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/gu;

/** For text nodes and attribute values alike; attributes are always double-quoted. */
export const escapeXml = (value: string): string =>
  value
    .replace(FORBIDDEN_IN_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Every element the change map draws. Nothing that runs, embeds, links or styles. */
const ELEMENTS = new Set(["svg", "defs", "marker", "path", "g", "rect", "text", "title"]);

/**
 * Every attribute the change map writes: geometry, classes, ids for markers, data-* hooks for
 * click-through (P5-3) and ARIA. No `on*`, no `href`, no `style`, no presentation colours.
 */
const ATTRIBUTES = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "rx",
  "d",
  "class",
  "id",
  "role",
  "aria-label",
  "aria-hidden",
  "text-anchor",
  "marker-end",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
]);
const DATA_ATTRIBUTE = /^data-[a-z][a-z0-9-]*$/;

const checkElement = (name: string): void => {
  if (!ELEMENTS.has(name)) throw new Error(`change map: element <${name}> is not allowed`);
};

const checkAttribute = (name: string): void => {
  if (!ATTRIBUTES.has(name) && !DATA_ATTRIBUTE.test(name))
    throw new Error(`change map: attribute "${name}" is not allowed`);
};

export type Attributes = Readonly<Record<string, string | number | undefined>>;

/** In insertion order, which is the order the painter wrote them: stable by construction. */
const serialise = (attributes: Attributes): string =>
  Object.entries(attributes)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => {
      checkAttribute(name);
      return ` ${name}="${escapeXml(String(value))}"`;
    })
    .join("");

/** A self-closing element. */
export const tag = (name: string, attributes: Attributes): string => {
  checkElement(name);
  return `<${name}${serialise(attributes)}/>`;
};

/** An element around `children`, which must already be markup from this module. */
export const wrap = (name: string, attributes: Attributes, children: string): string => {
  checkElement(name);
  return `<${name}${serialise(attributes)}>${children}</${name}>`;
};

/** An element holding escaped text. */
export const textElement = (name: "text" | "title", attributes: Attributes, content: string) =>
  wrap(name, attributes, escapeXml(content));

/** Joins fragments with newlines, dropping the ones that produced nothing. */
export const lines = (fragments: readonly string[]): string =>
  fragments.filter((fragment) => fragment.length > 0).join("\n");
