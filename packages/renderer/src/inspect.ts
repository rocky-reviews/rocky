/**
 * Proves an SVG inert by parsing it, not by pattern-matching it (P5-2). Shared by the test
 * files here and in apps/web through `@rocky-reviews/renderer/testing`; not part of the
 * package's main export.
 *
 * The parser is saxes: a strict, non-validating XML 1.0 parser with namespace checking (the one
 * jsdom uses for XML). It refuses anything that is not well-formed, never fetches or expands
 * external entities, and reports comments, CDATA, processing instructions and doctypes as
 * events, which are refused here. The rules below are written out again on purpose rather than
 * imported from svg/markup.ts, so a change to the renderer's allowlist cannot loosen the test.
 */
import { SaxesParser, type SaxesTagNS } from "saxes";

export const SVG_NS = "http://www.w3.org/2000/svg";

export type XmlElement = {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: XmlNode[];
};
export type XmlNode = XmlElement | string;

/** Parses `xml` into a tree; throws on anything but a single well-formed element. */
export const parseXml = (xml: string): XmlElement => {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  const refuse = (what: string) => () => {
    throw new Error(`output contains ${what}`);
  };
  parser.on("comment", refuse("a comment"));
  parser.on("cdata", refuse("a CDATA section"));
  parser.on("processinginstruction", refuse("a processing instruction"));
  parser.on("doctype", refuse("a doctype"));
  parser.on("xmldecl", refuse("an XML declaration"));
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    if (tag.uri !== SVG_NS || tag.prefix !== "")
      throw new Error(`element <${tag.name}> is not an unprefixed SVG element`);
    const attributes: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes)) {
      // Only the default SVG namespace may be declared: no xlink, no xhtml, no custom prefix.
      if (attribute.name.includes(":")) throw new Error(`prefixed attribute ${attribute.name}`);
      attributes[attribute.name] = attribute.value;
    }
    const element: XmlElement = { name: tag.local, attributes, children: [] };
    const parent = stack.at(-1);
    if (parent === undefined) root = element;
    else parent.children.push(element);
    stack.push(element);
  });
  parser.on("text", (text) => {
    const parent = stack.at(-1);
    if (parent === undefined) {
      if (text.trim() !== "") throw new Error("text outside the root element");
      return;
    }
    const last = parent.children.at(-1);
    if (typeof last === "string") parent.children[parent.children.length - 1] = last + text;
    else parent.children.push(text);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  if (root === undefined) throw new Error("no root element");
  return root;
};

const ELEMENTS = new Set(["svg", "defs", "marker", "path", "g", "rect", "text", "title"]);
const TEXT_ELEMENTS = new Set(["text", "title"]);
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const NUMERIC = new Set([
  "width",
  "height",
  "x",
  "y",
  "rx",
  "refX",
  "refY",
  "markerWidth",
  "markerHeight",
]);
const FIXED: Readonly<Record<string, ReadonlySet<string>>> = {
  xmlns: new Set([SVG_NS]),
  role: new Set(["img"]),
  "aria-hidden": new Set(["true"]),
  "text-anchor": new Set(["middle"]),
  orient: new Set(["auto-start-reverse"]),
};
const DELTA = "(?:added|modified|removed|unchanged)";
const SEVERITY = "(?:critical|high|medium|low)";
/**
 * The exact class lists the renderer writes, per element, in the order it writes them. A token
 * on the wrong element (`cm-hero` on a card, `cm-critical` on a lane) fails the walk.
 */
const CLASSES: Readonly<Record<string, RegExp>> = {
  svg: /^cm(?: cm-unavailable)?$/,
  rect: /^(?:cm-unavailable-bg|cm-lane-bg|cm-card|cm-badge-bg|cm-pill)$/,
  text: /^(?:cm-unavailable-title|cm-unavailable-reason|cm-lane-label|cm-node-title|cm-node-sub|cm-badge-count|cm-pill-text)$/,
  g: new RegExp(
    `^(?:cm-lanes|cm-lane|cm-edges|cm-nodes|cm-labels|cm-label|cm-node cm-${DELTA}|cm-badge cm-${SEVERITY})$`,
  ),
  path: new RegExp(
    `^(?:cm-edge cm-${DELTA}(?: cm-hero)?(?: cm-muted)?(?: cm-animated)?|cm-arrow cm-arrow-(?:added|modified|removed|unchanged|hero))$`,
  ),
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ID_LIST = /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?: [A-Za-z0-9][A-Za-z0-9._:/-]*)*$/;
const PATH_DATA = /^[MLCQZz0-9 ,.-]+$/;

export type InertReport = {
  /** Every element, depth first, with the text it holds (text and title only). */
  texts: { element: string; className: string | undefined; parentClass: string; text: string }[];
  ids: string[];
};

/**
 * Walks a parsed change map and throws on the first thing that could run, load, restyle or
 * mislead: an element or attribute outside the allowlist, a URL other than an internal
 * `url(#<prefix>-…)` marker reference, an attribute value of the wrong shape, text outside
 * `<text>`/`<title>`, an invisible or bidi control character anywhere.
 */
export const assertInert = (root: XmlElement, prefix: string): InertReport => {
  if (root.name !== "svg") throw new Error(`root is <${root.name}>`);
  const report: InertReport = { texts: [], ids: [] };
  const references: string[] = [];

  const visit = (element: XmlElement, parentClass: string): void => {
    if (!ELEMENTS.has(element.name)) throw new Error(`element <${element.name}>`);
    for (const [name, value] of Object.entries(element.attributes)) {
      checkAttribute(element.name, name, value, prefix, references, report.ids);
    }
    const className = element.attributes.class;
    for (const child of element.children) {
      if (typeof child === "string") {
        if (TEXT_ELEMENTS.has(element.name)) {
          checkVisible(child);
          report.texts.push({ element: element.name, className, parentClass, text: child });
        } else if (child.trim() !== "") {
          throw new Error(`text inside <${element.name}>`);
        }
      } else {
        if (TEXT_ELEMENTS.has(element.name)) throw new Error(`element inside <${element.name}>`);
        visit(child, className ?? parentClass);
      }
    }
    // An empty text element still reports, so callers can check what was drawn.
    if (TEXT_ELEMENTS.has(element.name) && element.children.length === 0)
      report.texts.push({ element: element.name, className, parentClass, text: "" });
  };
  visit(root, "");

  if (new Set(report.ids).size !== report.ids.length) throw new Error("duplicate id");
  for (const reference of references)
    if (!report.ids.includes(reference)) throw new Error(`dangling reference #${reference}`);
  return report;
};

const checkAttribute = (
  element: string,
  name: string,
  value: string,
  prefix: string,
  references: string[],
  ids: string[],
): void => {
  checkVisible(value);
  const fixed = FIXED[name];
  if (fixed !== undefined) {
    if (!fixed.has(value)) throw new Error(`${name}="${value}"`);
    if (name === "xmlns" && element !== "svg") throw new Error("xmlns below the root");
    return;
  }
  if (NUMERIC.has(name)) {
    if (!NUMBER.test(value)) throw new Error(`${name} is not a number: ${value}`);
    return;
  }
  switch (name) {
    case "viewBox":
      if (!value.split(" ").every((part) => NUMBER.test(part)) || value.split(" ").length !== 4)
        throw new Error(`viewBox="${value}"`);
      return;
    case "d":
      if (!PATH_DATA.test(value)) throw new Error(`d="${value}"`);
      return;
    case "class":
      if (!(CLASSES[element]?.test(value) ?? false))
        throw new Error(`class="${value}" on <${element}>`);
      return;
    case "id":
      if (!value.startsWith(`${prefix}-`) || !/^[a-z][a-z0-9-]*$/.test(value))
        throw new Error(`id="${value}"`);
      ids.push(value);
      return;
    case "marker-end": {
      // The one URL the change map may carry: a fragment reference to its own arrowhead.
      const match = /^url\(#([a-z][a-z0-9-]*)\)$/.exec(value);
      if (match?.[1] === undefined || !match[1].startsWith(`${prefix}-`))
        throw new Error(`marker-end="${value}"`);
      references.push(match[1]);
      return;
    }
    case "aria-label":
      return;
    default:
      if (name === "data-node" || name === "data-edge") {
        if (!ID.test(value)) throw new Error(`${name}="${value}"`);
        return;
      }
      if (name === "data-findings") {
        if (!ID_LIST.test(value)) throw new Error(`${name}="${value}"`);
        return;
      }
      throw new Error(`attribute ${name} on <${element}>`);
  }
};

/** Characters that may never reach the page, in text or attributes. */
const INVISIBLE_OR_CONTROL =
  /[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}\u2800]|(?!\u200C|\u200D|\uFE0E|\uFE0F)[\p{Default_Ignorable_Code_Point}\p{Cf}]/u;

const isJoiner = (c: string | undefined) => c === "\u200C" || c === "\u200D";
const isSelector = (c: string | undefined) => c === "\uFE0E" || c === "\uFE0F";
const EMOJI_OR_SYMBOL = /^[\p{Extended_Pictographic}\p{S}]$/u;
const SPACE_OR_MARK = /^[\s\p{Z}\p{M}]$/u;

/**
 * Joiners and selectors must join something, independently of how the renderer decides:
 * a selector straight after an emoji or symbol; a ZWNJ/ZWJ after a non-space character that is
 * not another ZWNJ/ZWJ and before a character that is not a space, mark, joiner or selector.
 * So no two of them are adjacent, except a selector followed by a joiner (U+2764 U+FE0F U+200D
 * U+1F525). At most 32 per string, and ZWNJ/ZWJ at most half (rounded up) the drawn characters.
 */
const checkJoiners = (value: string): void => {
  const characters = [...value];
  let invisible = 0;
  let joiners = 0;
  let drawn = 0;
  for (const [index, character] of characters.entries()) {
    const previous = characters[index - 1];
    const next = characters[index + 1];
    if (isSelector(character)) {
      invisible += 1;
      if (previous === undefined || !EMOJI_OR_SYMBOL.test(previous))
        throw new Error("a variation selector without an emoji or symbol before it");
    } else if (isJoiner(character)) {
      invisible += 1;
      joiners += 1;
      if (previous === undefined || isJoiner(previous) || /^[\s\p{Z}]$/u.test(previous))
        throw new Error("a joiner without a character before it");
      if (next === undefined || isJoiner(next) || isSelector(next) || SPACE_OR_MARK.test(next))
        throw new Error("a joiner without a character after it");
    } else if (!SPACE_OR_MARK.test(character)) {
      drawn += 1;
    }
  }
  if (invisible > 32) throw new Error("more than 32 joiners and selectors");
  if (joiners > Math.ceil(drawn / 2)) throw new Error("more joiners than half the drawn text");
};

const checkVisible = (value: string): void => {
  const found = INVISIBLE_OR_CONTROL.exec(value);
  if (found !== null)
    throw new Error(`U+${found[0].codePointAt(0)?.toString(16).toUpperCase()} in output`);
  checkJoiners(value);
};

/** Parses and walks in one step; returns what the walk found. */
export const inspectSvg = (svg: string, prefix = "cm"): InertReport =>
  assertInert(parseXml(svg), prefix);

/** The parsed tree with whitespace-only text between elements dropped, for comparisons. */
export const canonical = (svg: string): XmlElement => {
  const strip = (element: XmlElement): XmlElement => ({
    name: element.name,
    attributes: element.attributes,
    children: element.children.flatMap((child): XmlNode[] =>
      typeof child === "string" ? (TEXT_ELEMENTS.has(element.name) ? [child] : []) : [strip(child)],
    ),
  });
  return strip(parseXml(svg));
};
