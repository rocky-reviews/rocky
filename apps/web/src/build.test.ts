import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P7-3 (ADR 0025): the production build must work under `script-src 'self'; style-src 'self'`
 * with no hashes or nonces, so the built `index.html` may contain no inline script, style
 * element, style attribute, event handler or `javascript:` URL. Builds the app for real.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let outDir: string;
let html: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "rocky-web-build-"));
  await build({ root: ROOT, logLevel: "silent", build: { outDir, emptyOutDir: true } });
  html = readFileSync(join(outDir, "index.html"), "utf8");
}, 60_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("the production index.html (CSP without inline content)", () => {
  it("every <script> is external, same-origin", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const [, attrs = "", body = ""] of scripts) {
      expect(body.trim()).toBe("");
      expect(attrs).toMatch(/\ssrc="\/[^/"][^"]*"/);
    }
  });

  it("has no <style> element, style= attribute, on*= handler or javascript: URL", () => {
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("stylesheets are external, same-origin", () => {
    const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)];
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const [tag] of links) expect(tag).toMatch(/\shref="\/[^/"][^"]*"/);
  });
});
