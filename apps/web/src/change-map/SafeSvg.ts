/**
 * Puts a change map in the page (P5-2, ADR 0022): the renderer's checked tree becomes React
 * elements, one `createElement` per node. No HTML or XML is parsed in the browser, there is no
 * `innerHTML` (the lint ban stands), and React escapes every text and attribute on its own, on
 * top of the renderer's normalisation. Only a tree `@rocky-reviews/renderer` built and checked
 * (`isSafeSvg`) is accepted: a copy, a fragment or an object literal throws, so nothing else can
 * come through this door. Elements and attributes are mapped from fixed tables, so a name the
 * renderer does not write cannot reach the DOM even if the brand were bypassed.
 *
 * Click-through (P5-3) attaches one handler to a wrapper and reads `data-node` / `data-findings`
 * from `event.target.closest(...)` with `dataset`, never by building a selector or URL from
 * the value.
 */
import { isSafeSvg, type SafeSvg, type SvgNode } from "@rocky-reviews/renderer";
import { createElement, type ReactNode } from "react";

/** Renderer attribute → React prop. Anything else throws. */
const PROPS: Readonly<Record<string, string>> = {
  xmlns: "xmlns",
  viewBox: "viewBox",
  width: "width",
  height: "height",
  x: "x",
  y: "y",
  rx: "rx",
  d: "d",
  class: "className",
  id: "id",
  role: "role",
  tabindex: "tabIndex",
  "aria-label": "aria-label",
  "aria-hidden": "aria-hidden",
  "text-anchor": "textAnchor",
  "marker-end": "markerEnd",
  markerWidth: "markerWidth",
  markerHeight: "markerHeight",
  refX: "refX",
  refY: "refY",
  orient: "orient",
  "data-node": "data-node",
  "data-edge": "data-edge",
  "data-findings": "data-findings",
};

const ELEMENTS = new Set(["svg", "defs", "marker", "path", "g", "rect", "text", "title"]);

const toReact = (node: SvgNode): ReactNode => {
  if (typeof node === "string") return node;
  if (!ELEMENTS.has(node.name)) throw new Error("SafeSvgView: element not allowed");
  const props: Record<string, string> = {};
  for (const [name, value] of node.attributes) {
    const prop = Object.hasOwn(PROPS, name) ? PROPS[name] : undefined;
    if (prop === undefined) throw new Error("SafeSvgView: attribute not allowed");
    props[prop] = value;
  }
  return createElement(node.name, props, ...(node.children ?? []).map(toReact));
};

type Props = { svg: SafeSvg };

/** `<SafeSvgView svg={renderChangeMap(doc).tree} />` */
export const SafeSvgView = ({ svg }: Props): ReactNode => {
  if (!isSafeSvg(svg)) throw new Error("SafeSvgView: not a change map built by the renderer");
  return toReact(svg);
};
