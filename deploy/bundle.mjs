// Builds what the images run (P10-1, ADR 0043 §1): one ESM file per process, bundled with
// esbuild from the sources and the lockfile-installed dependencies, plus the SQL migrations
// and the few packages that must stay on disk (the tree-sitter grammars and `web-tree-sitter`,
// whose .wasm is resolved at run time). Run from the repository root, after `pnpm install`:
//
//   node deploy/bundle.mjs <out-dir>
//
// Layout of <out-dir> (what deploy/Dockerfile copies into /app):
//   server/main.mjs   worker/main.mjs   migrate/main.mjs   (+ main.mjs.LEGAL.txt each)
//   migrations/*.sql                    (packages/db resolves ../migrations/ from its own URL)
//   node_modules/<grammar>/             (package.json, licence, .wasm and .js only)
import { build } from "esbuild";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
if (out === undefined || out === "") {
  console.error("usage: node deploy/bundle.mjs <out-dir>");
  process.exit(2);
}

const ENTRIES = {
  server: "apps/server/src/main.ts",
  worker: "apps/worker/src/main.ts",
  migrate: "scripts/migrate.ts",
};

/**
 * Packages left out of the bundle and copied as files: `packages/indexer`'s grammars and the
 * tree-sitter runtime (read from its manifest, so a new grammar needs no edit here) and the
 * optional native `pg` binding, which is never installed.
 */
const indexerDeps = Object.keys(
  JSON.parse(readFileSync(join(root, "packages/indexer/package.json"), "utf8")).dependencies ?? {},
);
const RUNTIME_PACKAGES = indexerDeps.filter((name) => /^(web-)?tree-sitter(-|$)/.test(name));
const EXTERNAL = ["pg-native", ...RUNTIME_PACKAGES];

/** Top-level files of a runtime package worth shipping; sources, bindings and maps stay out. */
const KEEP = /^(package\.json|LICENSE.*|.*\.wasm|.*\.(c|m)?js)$/;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const [name, entry] of Object.entries(ENTRIES)) {
  const outfile = join(out, name, "main.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: EXTERNAL,
    // Bundled CommonJS dependencies call `require` for Node built-ins at run time.
    banner: {
      js: 'import { createRequire as __rockyCreateRequire } from "node:module";\nconst require = __rockyCreateRequire(import.meta.url);',
    },
    legalComments: "linked",
    logLevel: "warning",
  });
  console.log(`${name}: ${(statSync(outfile).size / 1e6).toFixed(1)} MB`);
}

const migrations = join(root, "packages/db/migrations");
mkdirSync(join(out, "migrations"));
let count = 0;
for (const file of readdirSync(migrations)) {
  if (!file.endsWith(".sql")) continue;
  copyFileSync(join(migrations, file), join(out, "migrations", file));
  count += 1;
}
console.log(`migrations: ${count} files`);

for (const name of RUNTIME_PACKAGES) {
  // The package pnpm installed for the indexer (a symlink into the store), by real path.
  const from = realpathSync(join(root, "packages/indexer/node_modules", name));
  const to = join(out, "node_modules", name);
  mkdirSync(to, { recursive: true });
  let bytes = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !KEEP.test(entry.name) || entry.name.endsWith(".map")) continue;
    copyFileSync(join(from, entry.name), join(to, entry.name));
    bytes += statSync(join(to, entry.name)).size;
  }
  console.log(`${name}: ${(bytes / 1e6).toFixed(1)} MB`);
}
