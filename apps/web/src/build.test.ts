import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P7-3 (ADR 0025): the production build must work under `script-src 'self'; style-src 'self'`
 * with no hashes or nonces, so the built `index.html` may contain no inline script, style
 * element, style attribute, event handler or `javascript:`/`data:`/`vbscript:` URL, and none
 * of the markup the server refuses (`<noscript>`, `<base>`, frames, plugins, `srcdoc`, `meta
 * http-equiv`, cross-origin script or stylesheet targets). Builds the app for real and reads
 * the result the way the server checks `ROCKY_WEB_DIR` at boot (`apps/server/src/web-app.ts`,
 * `findInlineContent`): parsed with parse5 both as a browser with scripting on and off would,
 * since the two differ inside `<noscript>`. The walk is repeated here because `apps/web` cannot
 * depend on `apps/server`; keep the two in step.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let outDir: string;
let elements: Tree.Element[];

const isElement = (node: Tree.Node): node is Tree.Element => "tagName" in node;
const isTemplate = (node: Tree.Element): node is Tree.Template => "content" in node;
const isText = (node: Tree.ChildNode): node is Tree.TextNode => node.nodeName === "#text";

/** Every element of the document in both parse modes, in every namespace, inside templates. */
const allElements = (html: string): Tree.Element[] => {
  const out: Tree.Element[] = [];
  const visit = (node: Tree.Node): void => {
    if (isElement(node)) {
      out.push(node);
      if (isTemplate(node)) visit(node.content);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  for (const scriptingEnabled of [true, false]) visit(parse(html, { scriptingEnabled }));
  return out;
};

const attr = (el: Tree.Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name.toLowerCase() === name)?.value;
const text = (el: Tree.Element): string =>
  el.childNodes.map((c) => (isText(c) ? c.value : "")).join("");
/**
 * A scheme a browser could run as script or markup; the URL parser drops tabs, LF and CR and
 * leading C0 controls and spaces before it reads the scheme.
 */
const hasScriptScheme = (value: string): boolean => {
  const stripped = value.replaceAll(/[\t\n\r]/g, "");
  let start = 0;
  while (start < stripped.length && stripped.charCodeAt(start) <= 0x20) start += 1;
  const lower = stripped.slice(start).toLowerCase();
  return (
    lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("vbscript:")
  );
};
const REFUSED_ELEMENTS = new Set([
  "noscript",
  "base",
  "object",
  "embed",
  "iframe",
  "frame",
  "frameset",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);
const SAME_ORIGIN_PATH = /^\/(?!\/)/;
const LOADING_LINK_RELS = new Set(["stylesheet", "modulepreload", "preload"]);

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "rocky-web-build-"));
  await build({ root: ROOT, logLevel: "silent", build: { outDir, emptyOutDir: true } });
  elements = allElements(readFileSync(join(outDir, "index.html"), "utf8"));
}, 60_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("the production index.html (CSP without inline content)", () => {
  it("every <script> is external, same-origin, with an empty body", () => {
    const scripts = elements.filter((el) => el.tagName.toLowerCase() === "script");
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const script of scripts) {
      expect(text(script).trim()).toBe("");
      expect(attr(script, "src")).toMatch(SAME_ORIGIN_PATH);
    }
  });

  it("has no <style>, style=, on*=, srcdoc=, script-capable URL, meta http-equiv or refused element", () => {
    for (const el of elements) {
      const name = el.tagName.toLowerCase();
      expect(name).not.toBe("style");
      expect(REFUSED_ELEMENTS.has(name), name).toBe(false);
      if (name === "meta") expect(attr(el, "http-equiv")).toBeUndefined();
      for (const a of el.attrs) {
        const attrName = a.name.toLowerCase();
        expect(attrName, `${name} ${attrName}`).not.toBe("style");
        expect(attrName, `${name} ${attrName}`).not.toBe("srcdoc");
        expect(attrName.startsWith("on"), `${name} ${attrName}`).toBe(false);
        expect(hasScriptScheme(a.value), `${name} ${attrName}`).toBe(false);
      }
    }
  });

  it("stylesheets and preloads are external, same-origin", () => {
    const links = elements.filter(
      (el) =>
        el.tagName.toLowerCase() === "link" &&
        (attr(el, "rel") ?? "")
          .toLowerCase()
          .split(/\s+/)
          .some((r) => LOADING_LINK_RELS.has(r)),
    );
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) expect(attr(link, "href")).toMatch(SAME_ORIGIN_PATH);
  });
});
