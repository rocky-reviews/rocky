import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The pieces of the self-host config reference check (P10-3): which environment variables the
 * code reads, which ones `docs/self-host/configuration.md` documents, and the difference.
 *
 * Where a config module has a list of its variables (`LLM_ENV_VARS`, `RATE_LIMIT_ENV_VARS`,
 * `RETENTION_ENV_VARS`, ...) the test takes it from there. Everything else is found by scanning
 * the source for literal reads: an `env` object indexed by a string literal, a property access
 * on it, a helper called with `env` and a string literal, or an index by an identifier that a
 * same-file `const` binds to a string literal. A read the scan cannot resolve (an index by a
 * variable, a walk over the whole environment) is reported as dynamic, so a new one fails the
 * test until a schema list covers it. (This comment avoids the literal forms on purpose: the
 * scan reads this file too.)
 */

const NAME = "[A-Z][A-Z0-9_]*";

const LITERAL_READS = [
  new RegExp(String.raw`\benv\??\.?\[\s*["'](${NAME})["']\s*\]`, "g"),
  new RegExp(String.raw`\benv\.(${NAME})\b`, "g"),
  new RegExp(String.raw`\(\s*env\s*,\s*["'](${NAME})["']`, "g"),
];
/** An index or a helper call by identifier: resolved through a same-file string constant. */
const INDIRECT_READS = [
  /\benv\??\.?\[\s*([A-Za-z_$][\w$]*)\s*\]/g,
  /[\w$]\(\s*env\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g,
];
/** Reads no scan can name: computed keys and whole-environment walks. */
const OPAQUE_READS = [
  /\benv\??\.?\[\s*(?!["'\s]|[A-Za-z_$][\w$]*\s*\])[^\]]+\]/g,
  /\bObject\.(?:keys|entries)\(\s*(?:process\.)?env\s*\)/g,
];

export interface SourceScan {
  /** Variable names read by literal (or through a same-file constant). */
  readonly keys: ReadonlySet<string>;
  /** Reads whose name the scan cannot see, as `<file>: <expression>`. */
  readonly dynamic: readonly string[];
}

const stringConstant = (source: string, ident: string): string | undefined =>
  new RegExp(String.raw`\bconst\s+${ident.replace(/\$/g, "\\$")}\s*=\s*["'](${NAME})["']`).exec(
    source,
  )?.[1];

/** Scans one file's text. `file` only labels dynamic reads. */
export const scanSource = (file: string, source: string): SourceScan => {
  const keys = new Set<string>();
  const dynamic: string[] = [];
  for (const pattern of LITERAL_READS) {
    for (const match of source.matchAll(pattern)) keys.add(match[1] as string);
  }
  for (const pattern of INDIRECT_READS) {
    for (const match of source.matchAll(pattern)) {
      const ident = match[1] as string;
      const resolved = stringConstant(source, ident);
      if (resolved === undefined) dynamic.push(`${file}: ${match[0].trim()}`);
      else keys.add(resolved);
    }
  }
  for (const pattern of OPAQUE_READS) {
    for (const match of source.matchAll(pattern)) dynamic.push(`${file}: ${match[0]}`);
  }
  return { keys, dynamic };
};

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "test-results", "e2e", "testing"]);
const SOURCE = /\.(?:ts|tsx|mjs|js)$/;
/** Tests and test helpers set variables for themselves; they are not configuration. */
const NOT_PRODUCT =
  /\.(?:test|spec|e2e\.test|perf\.spec)\.(?:ts|tsx)$|(?:^|\/)(?:testing|test-support)\.ts$/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Product source files under `roots` (relative to `repo`), sorted, as repo-relative paths. */
export const sourceFiles = (repo: string, roots: readonly string[]): string[] =>
  roots
    .flatMap((root) => {
      const path = join(repo, root);
      return statSync(path).isDirectory() ? walk(path) : [path];
    })
    .map((path) => relative(repo, path).split("\\").join("/"))
    .filter((path) => SOURCE.test(path) && !NOT_PRODUCT.test(path))
    .sort();

/** Scans every file and merges the results. */
export const scanRepository = (repo: string, roots: readonly string[]): SourceScan => {
  const keys = new Set<string>();
  const dynamic: string[] = [];
  for (const file of sourceFiles(repo, roots)) {
    const scan = scanSource(file, readFileSync(join(repo, file), "utf8"));
    for (const key of scan.keys) keys.add(key);
    dynamic.push(...scan.dynamic);
  }
  return { keys, dynamic };
};

/** The file part of a dynamic-read label. */
export const dynamicFile = (label: string): string => label.slice(0, label.indexOf(": "));

export interface DocumentedKeys {
  readonly keys: ReadonlySet<string>;
  readonly duplicates: readonly string[];
}

/**
 * Keys the reference documents: the first cell of a table row, written as code
 * (`` | `NAME` | ... ``). Prose mentions do not count, so a key is documented only where its row is.
 */
export const documentedKeys = (markdown: string): DocumentedKeys => {
  const keys = new Set<string>();
  const duplicates: string[] = [];
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const key = new RegExp(String.raw`^\|\s*\`(${NAME})\`\s*\|`).exec(line)?.[1];
    if (key === undefined) continue;
    if (keys.has(key)) duplicates.push(key);
    keys.add(key);
  }
  return { keys, duplicates };
};

/** Keys `.env.example` assigns, commented out or not (`NAME=` or `# NAME=` at a line start). */
export const envExampleKeys = (text: string): Set<string> =>
  new Set(
    [...text.matchAll(new RegExp(String.raw`^#?[ \t]*(${NAME})=`, "gm"))].map(
      (match) => match[1] as string,
    ),
  );

export interface KeyDiff {
  /** Read by the code, missing from the docs. */
  readonly undocumented: readonly string[];
  /** In the docs, not read by the code. */
  readonly unknown: readonly string[];
}

export const compareKeys = (code: ReadonlySet<string>, docs: ReadonlySet<string>): KeyDiff => ({
  undocumented: [...code].filter((key) => !docs.has(key)).sort(),
  unknown: [...docs].filter((key) => !code.has(key)).sort(),
});
