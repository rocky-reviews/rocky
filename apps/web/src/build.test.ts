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
 * element, style attribute, event handler or `javascript:` URL. Builds the app for real and
 * reads the result as a browser would (parse5), the same way the server checks `ROCKY_WEB_DIR`
 * at boot (`apps/server/src/web-app.ts`, `findInlineContent`).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let outDir: string;
let elements: Tree.Element[];

const isElement = (node: Tree.Node): node is Tree.Element => "tagName" in node;
const isTemplate = (node: Tree.Element): node is Tree.Template => "content" in node;
const isText = (node: Tree.ChildNode): node is Tree.TextNode => node.nodeName === "#text";

/** Every element of the document, in every namespace and inside `<template>` contents. */
const allElements = (html: string): Tree.Element[] => {
  const out: Tree.Element[] = [];
  const visit = (node: Tree.Node): void => {
    if (isElement(node)) {
      out.push(node);
      if (isTemplate(node)) visit(node.content);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(html, { scriptingEnabled: false }));
  return out;
};

const attr = (el: Tree.Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name.toLowerCase() === name)?.value;
const text = (el: Tree.Element): string =>
  el.childNodes.map((c) => (isText(c) ? c.value : "")).join("");
/** The URL parser drops tabs and newlines and leading controls before it reads the scheme. */
const isJavascriptUrl = (value: string): boolean =>
  value
    .replaceAll(/[\t\n\r]/g, "")
    .trimStart()
    .toLowerCase()
    .startsWith("javascript:");

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
      expect(attr(script, "src")).toMatch(/^\/[^/]/);
    }
  });

  it("has no <style> element, style= attribute, on*= handler or javascript: URL", () => {
    for (const el of elements) {
      const name = el.tagName.toLowerCase();
      expect(name).not.toBe("style");
      for (const a of el.attrs) {
        const attrName = a.name.toLowerCase();
        expect(attrName, `${name} ${attrName}`).not.toBe("style");
        expect(attrName.startsWith("on"), `${name} ${attrName}`).toBe(false);
        expect(isJavascriptUrl(a.value), `${name} ${attrName}`).toBe(false);
      }
    }
  });

  it("stylesheets are external, same-origin", () => {
    const links = elements.filter(
      (el) => el.tagName.toLowerCase() === "link" && attr(el, "rel") === "stylesheet",
    );
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) expect(attr(link, "href")).toMatch(/^\/[^/]/);
  });
});
