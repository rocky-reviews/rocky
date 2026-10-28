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
const CLASS_TOKEN = /^cm(?:-[a-z]+)*$/;
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
      if (!value.split(" ").every((token) => CLASS_TOKEN.test(token)))
        throw new Error(`class="${value}"`);
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

const checkVisible = (value: string): void => {
  const found = INVISIBLE_OR_CONTROL.exec(value);
  if (found !== null)
    throw new Error(`U+${found[0].codePointAt(0)?.toString(16).toUpperCase()} in output`);
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
