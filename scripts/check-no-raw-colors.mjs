// P0-10: colours live only in apps/web/src/styles/tokens.css. Everything else in apps/web must
// use var(--token). Fails on hex literals, colour functions (any case) and CSS named colours.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "apps/web";
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);
const ALLOWED = new Set(["apps/web/src/styles/tokens.css"]);
const EXTENSIONS = /\.(css|scss|sass|less|ts|tsx|js|jsx|mjs|cjs|html|svg|vue|md)$/i;

const HEX = /#[0-9a-f]{3,8}\b/gi;
const FUNCTIONS = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)\s*\(/gi;
// CSS named colours, only where a colour is expected (property value or SVG paint attribute).
const NAMED =
  /(?:\b(?:color|background(?:-color)?|border(?:-[a-z]+)*-color|border|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration-color|column-rule-color|stop-color|flood-color|lighting-color)\s*[:=]\s*["']?[^;"'{}]*?)\b(black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia|cyan|magenta|brown|gold|indigo|violet|crimson|coral|salmon|tomato|khaki|beige|ivory|lavender|turquoise|tan|plum|orchid|chocolate|firebrick|darkred|darkblue|darkgreen|lightgray|lightgrey|darkgray|darkgrey|whitesmoke|gainsboro)\b/gi;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const problems = [];
for (const file of walk(ROOT)) {
  const rel = relative(".", file);
  if (!EXTENSIONS.test(file) || ALLOWED.has(rel)) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const re of [HEX, FUNCTIONS, NAMED]) {
        for (const match of line.matchAll(re)) problems.push(`${rel}:${i + 1}  ${match[0].trim()}`);
      }
    });
}

if (problems.length > 0) {
  console.error("Raw colours found; use a token from apps/web/src/styles/tokens.css instead:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
