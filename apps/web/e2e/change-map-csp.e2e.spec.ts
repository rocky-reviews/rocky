/**
 * P5-2: the change map under a strict CSP (what P7-3 plans: `default-src 'self'; style-src
 * 'self'; script-src 'self'`). A page served with that header holds the map twice, as the
 * renderer's string and as SafeSvgView's React output, styled only by the external tokens.css
 * and change-map.css. No `securitypolicyviolation` may fire, the stylesheet must apply (the map
 * needs no inline style to be coloured), and hostile labels must come out as text. A control
 * page with one inline style proves the listener would have caught a violation.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderChangeMap } from "../../../packages/renderer/src/index.js";
import { HOSTILE_CORPUS } from "../../../packages/renderer/src/hostile-corpus.js";
import { pr847, withLabels } from "../../../packages/renderer/src/test-support.js";
import { SafeSvgView } from "../src/change-map/SafeSvg.js";

const ORIGIN = "http://csp.test";
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'";

const css = {
  "/tokens.css": await readFile(new URL("../src/styles/tokens.css", import.meta.url), "utf8"),
  "/change-map.css": await readFile(
    new URL("../../../packages/renderer/src/change-map.css", import.meta.url),
    "utf8",
  ),
};

const page = (body: string) =>
  `<!doctype html><html data-mode="light"><head><meta charset="utf-8">` +
  `<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/change-map.css">` +
  `</head><body>${body}</body></html>`;

const serve = async (tab: Page, html: string): Promise<string[]> => {
  await tab.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const console: string[] = [];
  tab.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) console.push(message.text());
  });
  await tab.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const sheet = css[path as keyof typeof css];
    await route.fulfill(
      sheet === undefined
        ? {
            status: 200,
            contentType: "text/html",
            headers: { "content-security-policy": CSP },
            body: html,
          }
        : { status: 200, contentType: "text/css", body: sheet },
    );
  });
  await tab.goto(`${ORIGIN}/`);
  await tab.waitForLoadState("load");
  return console;
};

const violations = (tab: Page) =>
  tab.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);

test("a strict CSP accepts the change map as string and as React output", async ({ page: tab }) => {
  const maps = [
    renderChangeMap(pr847()),
    ...HOSTILE_CORPUS.filter(({ technique }) =>
      ["markup", "styles", "handlers and links", "URLs"].includes(technique),
    ).map(({ label }) => renderChangeMap(withLabels(label))),
    // P5-3: the clickable map adds only tabindex, roles and names.
    renderChangeMap(pr847(), {
      idPrefix: "click",
      interactive: { files: pr847().provenance.files.map((file) => file.path) },
    }),
  ];
  const body = maps
    .map(
      (map, index) =>
        `<div data-map="${index}">${map.svg}</div>` +
        `<div data-react="${index}">${renderToStaticMarkup(createElement(SafeSvgView, { svg: map.tree }))}</div>`,
    )
    .join("");
  const unstyled = '<svg data-unstyled width="1" height="1"><rect width="1" height="1"/></svg>';
  const console = await serve(tab, page(body + unstyled));

  expect(await violations(tab)).toEqual([]);
  expect(console).toEqual([]);
  // Nothing the labels spelled became an element, in either copy.
  expect(
    await tab.locator("script, foreignObject, iframe, img, image, use, style, a").count(),
  ).toBe(0);
  // The external stylesheet coloured the map: a card's fill differs from an unstyled rect's.
  const fill = (selector: string) =>
    tab
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).fill);
  expect(await fill('[data-map="0"] .cm-card')).not.toBe(await fill("[data-unstyled] rect"));
  // A hostile label is drawn as its text.
  await expect(tab.locator('[data-react="1"] .cm-node-title').first()).toHaveText(/^<script>/i);
});

test("control: the listener does catch an inline style", async ({ page: tab }) => {
  await serve(tab, page('<p style="display: none">inline</p>'));
  await expect.poll(() => violations(tab)).toContainEqual(expect.stringMatching(/^style-src/));
});
