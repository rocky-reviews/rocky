// P0-10: colours live only in apps/web/src/styles/tokens.css. Everything else in apps/web must
// use var(--token). Fails on hex, rgb()/hsl()/oklch() literals outside the tokens file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "apps/web/src";
const ALLOWED = new Set(["apps/web/src/styles/tokens.css"]);
const EXTENSIONS = /\.(css|ts|tsx|html)$/;
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
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
      for (const match of line.matchAll(COLOUR)) problems.push(`${rel}:${i + 1}  ${match[0]}`);
    });
}

if (problems.length > 0) {
  console.error("Raw colours found; use a token from apps/web/src/styles/tokens.css instead:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
