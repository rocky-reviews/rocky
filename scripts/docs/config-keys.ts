import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The pieces of the self-host config reference check (P10-3): which environment variables the
 * code reads, which ones `docs/self-host/configuration.md` documents, and the difference.
 *
 * Where a config module has a list of its variables (`LLM_ENV_VARS`, `RATE_LIMIT_ENV_VARS`,
 * `RETENTION_ENV_VARS`, ...) the test takes it from there. Everything else is found by scanning
 * the source for literal reads of an environment object (a bare `env` binding or one reached
 * through members such as `process.`, `this.` or `deps.`): indexed by a string literal (also with
 * optional chaining), a property access on it, a helper called with it and a string literal in
 * either order, a membership test, destructuring, or an index by an identifier that a same-file
 * `const` binds to a string literal. A read the scan cannot resolve (an index by a variable, a
 * walk over the whole environment, an alias of it, a rest element) is reported as dynamic under
 * an exact label, so a new one fails the test until it is reviewed. (This comment avoids the
 * literal forms on purpose: the scan reads this file too.)
 */

const NAME = "[A-Z][A-Z0-9_]*";
const IDENT = "[A-Za-z_$][\\w$]*";
/** An environment object: a bare binding, or one reached through members (`process.`, `this.`). */
const ENV = String.raw`\b(?:[\w$]+\??\.)*env`;
const QUOTED = String.raw`["'](${NAME})["']`;

const LITERAL_READS = [
  // indexed, also with optional chaining
  new RegExp(String.raw`${ENV}\s*(?:\?\.)?\[\s*${QUOTED}\s*\]`, "g"),
  // property access, also with optional chaining
  new RegExp(String.raw`${ENV}(?:\?\.|\.)(${NAME})\b`, "g"),
  // a helper called with the environment, then the name
  new RegExp(String.raw`(?<=[\w$])\(\s*${ENV}\s*,\s*${QUOTED}`, "g"),
  // a helper called with the name, then the environment
  new RegExp(String.raw`(?<=[\w$])\(\s*${QUOTED}\s*,\s*${ENV}\s*[,)]`, "g"),
  // a membership test
  new RegExp(String.raw`${QUOTED}\s+in\s+${ENV}\b`, "g"),
];
/** An index or a helper call by identifier: resolved through a same-file string constant. */
const INDIRECT_READS = [
  new RegExp(String.raw`${ENV}\s*(?:\?\.)?\[\s*(${IDENT})\s*\]`, "g"),
  new RegExp(String.raw`(?<=[\w$])\(\s*${ENV}\s*,\s*(${IDENT})\s*[,)]`, "g"),
];
/** Destructuring the environment: each property is a read (a rest element is opaque). */
const DESTRUCTURING = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${ENV}\b(?!\s*[.[(?])`, "g");
/** Reads no scan can name: computed keys, whole-environment walks, and aliases. */
const OPAQUE_READS = [
  new RegExp(String.raw`${ENV}\s*(?:\?\.)?\[\s*(?!["'\s]|${IDENT}\s*\])[^\]]+\]`, "g"),
  new RegExp(String.raw`\bObject\.(?:keys|entries|values)\(\s*${ENV}\s*\)`, "g"),
  new RegExp(String.raw`\bfor\s*\(\s*(?:const|let|var)\s+${IDENT}\s+in\s+${ENV}\b`, "g"),
  new RegExp(String.raw`\b(?:const|let|var)\s+${IDENT}\s*=\s*${ENV}\s*(?=;|\n|$)`, "g"),
];

export interface SourceScan {
  /** Variable names read by literal (or through a same-file constant). */
  readonly keys: ReadonlySet<string>;
  /** Reads whose name the scan cannot see, as `<file>: <expression>`. */
  readonly dynamic: readonly string[];
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const stringConstant = (source: string, ident: string): string | undefined =>
  new RegExp(String.raw`\bconst\s+${escapeRegExp(ident)}\s*=\s*${QUOTED}`).exec(source)?.[1];

const label = (file: string, expression: string): string =>
  `${file}: ${expression.replace(/\s+/g, " ").trim()}`;

/** Scans one file's text. `file` only labels dynamic reads. */
export const scanSource = (file: string, source: string): SourceScan => {
  const keys = new Set<string>();
  const dynamic: string[] = [];
  for (const pattern of LITERAL_READS) {
    for (const match of source.matchAll(pattern)) keys.add(match[1] as string);
  }
  for (const pattern of INDIRECT_READS) {
    for (const match of source.matchAll(pattern)) {
      const resolved = stringConstant(source, match[1] as string);
      if (resolved === undefined) dynamic.push(label(file, match[0]));
      else keys.add(resolved);
    }
  }
  for (const match of source.matchAll(DESTRUCTURING)) {
    for (const element of (match[1] as string).split(",")) {
      const name = element.split(/[:=]/)[0]?.trim() ?? "";
      if (name.startsWith("...")) dynamic.push(label(file, match[0]));
      else if (new RegExp(`^${NAME}$`).test(name)) keys.add(name);
    }
  }
  for (const pattern of OPAQUE_READS) {
    for (const match of source.matchAll(pattern)) dynamic.push(label(file, match[0]));
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

export interface RepositoryScan {
  /** Keys found, per repo-relative file. */
  readonly keysByFile: ReadonlyMap<string, ReadonlySet<string>>;
  /** Distinct dynamic-read labels, sorted. */
  readonly dynamic: readonly string[];
}

/** Scans every file. */
export const scanRepository = (repo: string, roots: readonly string[]): RepositoryScan => {
  const keysByFile = new Map<string, ReadonlySet<string>>();
  const dynamic = new Set<string>();
  for (const file of sourceFiles(repo, roots)) {
    const scan = scanSource(file, readFileSync(join(repo, file), "utf8"));
    if (scan.keys.size > 0) keysByFile.set(file, scan.keys);
    for (const entry of scan.dynamic) dynamic.add(entry);
  }
  return { keysByFile, dynamic: [...dynamic].sort() };
};

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
