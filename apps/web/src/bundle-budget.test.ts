import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { initialChunks, INITIAL_JS_BUDGET_GZ, type Manifest } from "./bundle-budget.js";

/**
 * P6-8 acceptance: "JS bundle < 300 KB gz initial" (ADR 0032). Builds the app for production
 * and gzips (zlib, level 9) every script the page runs before its first render: the module
 * entry with its static imports (from Vite's manifest) and the classic scripts `index.html`
 * names (the theme script in public/). Fails above the budget. The numbers go to
 * artifacts/perf/P6-8/bundle.json.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "../..");
const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

describe("initialChunks", () => {
  const manifest: Manifest = {
    "index.html": { file: "assets/index.js", isEntry: true, imports: ["_react.js", "_ui.js"] },
    "_react.js": { file: "assets/react.js" },
    "_ui.js": { file: "assets/ui.js", imports: ["_react.js"], dynamicImports: ["lazy.tsx"] },
    "lazy.tsx": { file: "assets/lazy.js", imports: ["_ui.js"] },
  };

  it("follows static imports transitively, once each, and leaves dynamic imports out", () => {
    expect(initialChunks(manifest, "index.html")).toEqual([
      "assets/index.js",
      "assets/react.js",
      "assets/ui.js",
    ]);
  });

  it("refuses an entry or import missing from the manifest", () => {
    expect(() => initialChunks(manifest, "nope.html")).toThrow(/not in the manifest/);
    expect(() =>
      initialChunks({ "a.html": { file: "a.js", imports: ["_gone.js"] } }, "a.html"),
    ).toThrow(/_gone\.js/);
  });
});

describe("the production build", () => {
  const outDir = mkdtempSync(join(tmpdir(), "rocky-web-budget-"));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it(`loads at most ${INITIAL_JS_BUDGET_GZ / 1024} KB of gzipped JavaScript before the first render`, async () => {
    // Vitest sets NODE_ENV=test, and Vite would then build React's development bundles.
    const nodeEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await build({
        root: ROOT,
        logLevel: "silent",
        build: { outDir, emptyOutDir: true, manifest: "manifest.json" },
      });
    } finally {
      process.env["NODE_ENV"] = nodeEnv;
    }
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as Manifest;
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    // Classic scripts (public/) are not in the manifest; module scripts are, as the entry.
    const classic = [...html.matchAll(/<script(?![^>]*type="module")[^>]*\ssrc="\/([^"]+)"/g)]
      .map((m) => m[1])
      .filter((file): file is string => file !== undefined);
    expect(classic).toContain("theme-init.js");
    const files = [...classic, ...initialChunks(manifest, "index.html")];
    const sizes = files.map((file) => {
      const raw = readFileSync(join(outDir, file));
      return { file, kb: kb(raw.length), gzKb: kb(gzipSync(raw, { level: 9 }).length) };
    });
    const totalGz = sizes.reduce(
      (sum, s) => sum + gzipSync(readFileSync(join(outDir, s.file)), { level: 9 }).length,
      0,
    );
    const out = join(REPO, "artifacts/perf/P6-8");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "bundle.json"),
      `${JSON.stringify({ budgetGzKb: INITIAL_JS_BUDGET_GZ / 1024, initialGzKb: kb(totalGz), files: sizes }, null, 2)}\n`,
    );
    expect(kb(totalGz), "initial JavaScript, KB gzipped").toBeLessThanOrEqual(
      INITIAL_JS_BUDGET_GZ / 1024,
    );
  }, 120_000);
});
