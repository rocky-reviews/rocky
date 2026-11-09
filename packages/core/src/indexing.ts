/**
 * Repository indexing (P9-1, ADR 0040): the pure half. Which files of a repository are indexed,
 * how a file becomes function- and class-level chunks, which files a run must fetch again, and
 * the one vector width every embedding space is stored at. No parser, no hashing, no I/O: the
 * tree-sitter adapter (`packages/indexer`) hands a syntax tree in as `SyntaxNodeView`, and the
 * worker does the reading and writing.
 *
 * Repository content is untrusted input: paths and text come from whoever pushed. Nothing here
 * interprets the text beyond line breaks and a few header markers, and every bound is fixed.
 */
import { CHARS_PER_TOKEN, patchTokens } from "./analysis/estimate.js";

/**
 * The width of the stored vector column (`embeddings.embedding vector(1024)`, migration 0022).
 * Every embedding space is stored at this width: hosted providers are asked for at most this many
 * dimensions (OpenAI `dimensions`, Voyage `output_dimension`), and a narrower vector is padded
 * with zeros, which leaves cosine and inner-product similarity unchanged (ADR 0040 §3).
 */
export const INDEX_VECTOR_DIMENSIONS = 1024;

export const INDEX_LIMITS = Object.freeze({
  /** Larger files are skipped (`too_large`): at this size source is almost always generated. */
  maxFileBytes: 512 * 1024,
  /** A chunk never spans more lines than this… */
  maxChunkLines: 150,
  /** …nor more characters (about 2 000 tokens of code at CHARS_PER_TOKEN). */
  maxChunkChars: 6_000,
  /** A chunk shorter than this is folded into its neighbour when they fit together. */
  minChunkLines: 4,
  /** Chunks kept per file; the rest of a pathological file is not indexed. */
  maxChunksPerFile: 500,
  /** Longer paths are skipped (`invalid_path`). */
  maxPathBytes: 1024,
});

/** Languages chunked from a tree-sitter syntax tree (ADR 0040 §2 justifies the set). */
export const PARSED_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
] as const;
export type ParsedLanguage = (typeof PARSED_LANGUAGES)[number];

export const INDEX_SKIP_REASONS = [
  "invalid_path",
  "vendored",
  "generated",
  "unsupported",
  "too_large",
  "empty",
  "binary",
] as const;
export type IndexSkipReason = (typeof INDEX_SKIP_REASONS)[number];

export type PathClass =
  | { readonly kind: "parse"; readonly language: ParsedLanguage }
  | { readonly kind: "text"; readonly language: string }
  | { readonly kind: "skip"; readonly reason: IndexSkipReason };

/** One embedding space: vectors are only ever compared within one (ADR 0040 §3). */
export interface EmbeddingSpace {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
}

export const isSameSpace = (a: EmbeddingSpace, b: EmbeddingSpace | null | undefined): boolean =>
  b !== null &&
  b !== undefined &&
  a.provider === b.provider &&
  a.model === b.model &&
  a.dimensions === b.dimensions;

/** A refused input: a fixed message, never the offending value. */
export class IndexInputError extends Error {
  override readonly name = "IndexInputError";
}

// --- Which files ---------------------------------------------------------------------------------

const PARSED_BY_EXTENSION: Readonly<Record<string, ParsedLanguage>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
};

/** Text Rocky indexes with line windows: docs, config, schemas and the other common languages. */
const TEXT_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  rst: "rst",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  json: "json",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  scala: "scala",
  lua: "lua",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  dart: "dart",
  gradle: "groovy",
  groovy: "groovy",
  tf: "hcl",
  hcl: "hcl",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
};

const TEXT_BY_NAME: Readonly<Record<string, string>> = {
  Dockerfile: "dockerfile",
  Containerfile: "dockerfile",
  Makefile: "make",
  Justfile: "make",
  Rakefile: "ruby",
};

/** Directories that hold someone else's code or build output, at any depth. */
const VENDORED_DIRS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "vendors",
  "third_party",
  "third-party",
  "thirdparty",
  "external",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".gradle",
  ".idea",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "Pods",
  "Carthage",
  "DerivedData",
]);

const GENERATED_DIRS = new Set(["__snapshots__", "__generated__", "generated"]);

const GENERATED_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "go.sum",
  "go.work.sum",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "Podfile.lock",
  "packages.lock.json",
  "flake.lock",
]);

/** Name patterns of generated, minified or compiled-in files. */
const GENERATED_NAME =
  /(?:\.min\.(?:js|css)|\.map|\.bundle\.js|\.snap|\.pb\.go|_pb2(?:_grpc)?\.pyi?|\.pb\.(?:ts|js)|_pb\.(?:ts|js)|\.g\.dart|\.freezed\.dart|_generated\.go|\.gen\.go|\.designer\.cs)$|\.generated\./;

/** A path as a forge lists it: relative, `/`-separated, no empty, `.` or `..` segment. */
const isUsablePath = (path: string): boolean => {
  if (typeof path !== "string" || path === "" || path.startsWith("/")) return false;
  if (utf8Length(path) > INDEX_LIMITS.maxPathBytes) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};

/**
 * What to do with a file, from its path and size alone (before anything is fetched). The size is
 * the forge's byte count.
 */
export const classifyPath = (path: string, size: number): PathClass => {
  if (!isUsablePath(path) || !Number.isSafeInteger(size) || size < 0) {
    return { kind: "skip", reason: "invalid_path" };
  }
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  const dirs = segments.slice(0, -1);
  if (dirs.some((dir) => VENDORED_DIRS.has(dir))) return { kind: "skip", reason: "vendored" };
  if (
    dirs.some((dir) => GENERATED_DIRS.has(dir)) ||
    GENERATED_NAMES.has(name) ||
    GENERATED_NAME.test(name)
  ) {
    return { kind: "skip", reason: "generated" };
  }
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const parsed = Object.hasOwn(PARSED_BY_EXTENSION, extension)
    ? PARSED_BY_EXTENSION[extension]
    : undefined;
  const text = Object.hasOwn(TEXT_BY_EXTENSION, extension)
    ? TEXT_BY_EXTENSION[extension]
    : Object.hasOwn(TEXT_BY_NAME, name)
      ? TEXT_BY_NAME[name]
      : undefined;
  if (parsed === undefined && text === undefined) return { kind: "skip", reason: "unsupported" };
  if (size === 0) return { kind: "skip", reason: "empty" };
  if (size > INDEX_LIMITS.maxFileBytes) return { kind: "skip", reason: "too_large" };
  return parsed !== undefined
    ? { kind: "parse", language: parsed }
    : { kind: "text", language: text ?? "text" };
};

/** Bytes looked at for a NUL (git's own heuristic reads the first 8 000). */
const BINARY_SNIFF_BYTES = 8_000;
const HEADER_CHARS = 1_024;
const HEADER_LINES = 5;
const GENERATED_HEADER = [
  /@generated\b/,
  /\bcode generated\b.*\bdo not (?:edit|modify)\b/i,
  /\bgenerated by\b.*\bdo not (?:edit|modify)\b/i,
  /\b(?:auto-?generated|automatically generated)\b/i,
];
const MINIFIED_LINE_CHARS = 5_000;
const MINIFIED_AVERAGE_CHARS = 400;
/** The average-line rule applies only from this size, so a short file with long lines passes. */
const MINIFIED_MIN_CHARS = 4_000;

/**
 * What to do with a fetched file. `text` is its UTF-8 decoding, `undefined` when it is not valid
 * UTF-8 (decoded by the caller, which has a strict decoder).
 */
export const classifyContent = (
  bytes: Uint8Array,
  text: string | undefined,
): { readonly kind: "index" } | { readonly kind: "skip"; readonly reason: IndexSkipReason } => {
  const sniff = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniff; i++) {
    if (bytes[i] === 0) return { kind: "skip", reason: "binary" };
  }
  if (text === undefined) return { kind: "skip", reason: "binary" };
  if (text.trim() === "") return { kind: "skip", reason: "empty" };
  const header = text.slice(0, HEADER_CHARS).split(/\r?\n/).slice(0, HEADER_LINES).join("\n");
  if (GENERATED_HEADER.some((pattern) => pattern.test(header))) {
    return { kind: "skip", reason: "generated" };
  }
  const lines = text.split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (
    longest > MINIFIED_LINE_CHARS ||
    (text.length >= MINIFIED_MIN_CHARS && text.length / lines.length > MINIFIED_AVERAGE_CHARS)
  ) {
    return { kind: "skip", reason: "generated" };
  }
  return { kind: "index" };
};

// --- How a file becomes chunks -------------------------------------------------------------------

/**
 * The part of a syntax tree the chunker reads (the tree-sitter adapter wraps a `Node`). Rows are
 * 0-based; `endRow` is the last row holding any of the node.
 */
export interface SyntaxNodeView {
  readonly type: string;
  readonly startRow: number;
  readonly endRow: number;
  namedChildren(): readonly SyntaxNodeView[];
}

/** One chunk, before hashing and embedding. Lines are 1-based and inclusive. */
export interface CodeChunkDraft {
  readonly startLine: number;
  readonly endLine: number;
  /** The syntax node type it was cut from, `block` (code between units) or `window`. */
  readonly kind: string;
  /** The chunk's lines, joined with `\n`, cut at `maxChunkChars`. Untrusted: never logged. */
  readonly text: string;
}

interface LanguageUnits {
  /** Nodes that make a chunk of their own. */
  readonly units: ReadonlySet<string>;
  /** Nodes that are a unit when one is inside them (`export function …`). */
  readonly wrappers: ReadonlySet<string>;
  /** Nodes looked through for the units of a unit that is too large (a class body). */
  readonly containers: ReadonlySet<string>;
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items);

const JS_UNITS: LanguageUnits = {
  units: set(
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "method_definition",
    "abstract_method_signature",
    "lexical_declaration",
    "variable_declaration",
    "internal_module",
    "module",
  ),
  wrappers: set("export_statement", "ambient_declaration"),
  containers: set("class_body", "interface_body", "object_type", "enum_body"),
};

const UNITS: Readonly<Record<ParsedLanguage, LanguageUnits>> = {
  typescript: JS_UNITS,
  tsx: JS_UNITS,
  javascript: JS_UNITS,
  python: {
    units: set("function_definition", "class_definition", "decorated_definition"),
    wrappers: set(),
    containers: set("block"),
  },
  go: {
    units: set("function_declaration", "method_declaration", "type_declaration"),
    wrappers: set(),
    containers: set(),
  },
  rust: {
    units: set(
      "function_item",
      "impl_item",
      "struct_item",
      "enum_item",
      "trait_item",
      "mod_item",
      "macro_definition",
      "union_item",
    ),
    wrappers: set(),
    containers: set("declaration_list"),
  },
  java: {
    units: set(
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "record_declaration",
      "annotation_type_declaration",
      "method_declaration",
      "constructor_declaration",
    ),
    wrappers: set(),
    containers: set("class_body", "interface_body", "enum_body", "enum_body_declarations"),
  },
};

/** How deep the chunker looks for a large unit's inner units (class → body → method). */
const MAX_CONTAINER_DEPTH = 4;

interface Range {
  start: number;
  end: number;
  kind: string;
}

const BLOCK = "block";
const WINDOW = "window";

class Lines {
  readonly rows: readonly string[];
  constructor(text: string) {
    this.rows = text.split(/\r?\n/);
  }
  get last(): number {
    return this.rows.length - 1;
  }
  blank(row: number): boolean {
    return (this.rows[row] ?? "").trim() === "";
  }
  /** Characters of rows start..end, counting one per line break. */
  chars(start: number, end: number): number {
    let total = 0;
    for (let row = start; row <= end; row++) total += (this.rows[row]?.length ?? 0) + 1;
    return total - 1;
  }
  fits(start: number, end: number): boolean {
    return (
      end - start + 1 <= INDEX_LIMITS.maxChunkLines &&
      this.chars(start, end) <= INDEX_LIMITS.maxChunkChars
    );
  }
  text(start: number, end: number): string {
    return this.rows
      .slice(start, end + 1)
      .join("\n")
      .slice(0, INDEX_LIMITS.maxChunkChars);
  }
}

/**
 * Rows start..end in windows within the caps. A window that must be cut is cut after the last
 * blank row in its final quarter, when there is one, so paragraphs and functions stay whole.
 */
const windows = (lines: Lines, start: number, end: number, kind: string): Range[] => {
  const out: Range[] = [];
  let from = start;
  while (from <= end) {
    let to = from;
    while (to < end && lines.fits(from, to + 1)) to++;
    if (to < end) {
      const floor = from + Math.floor(((to - from + 1) * 3) / 4);
      for (let row = to; row >= floor && row > from; row--) {
        if (lines.blank(row)) {
          to = row;
          break;
        }
      }
    }
    out.push({ start: from, end: to, kind });
    from = to + 1;
  }
  return out;
};

const clampRow = (row: number, lines: Lines): number => Math.min(Math.max(row, 0), lines.last);

/** The chunk ranges covering rows lo..hi of a node whose units are `units`. */
const cover = (
  lines: Lines,
  config: LanguageUnits,
  units: readonly SyntaxNodeView[],
  lo: number,
  hi: number,
): Range[] => {
  const out: Range[] = [];
  let cursor = lo;
  for (const unit of units) {
    const start = Math.max(clampRow(unit.startRow, lines), cursor);
    const end = Math.min(clampRow(unit.endRow, lines), hi);
    if (end < start) continue;
    if (start > cursor) out.push(...windows(lines, cursor, start - 1, BLOCK));
    out.push(...unitRanges(lines, config, unit, start, end));
    cursor = end + 1;
  }
  if (cursor <= hi) out.push(...windows(lines, cursor, hi, BLOCK));
  return out;
};

const isUnit = (config: LanguageUnits, node: SyntaxNodeView): boolean =>
  config.units.has(node.type) ||
  (config.wrappers.has(node.type) && node.namedChildren().some((c) => isUnit(config, c)));

/** The units inside `node`, looking through containers only (a class into its body). */
const innerUnits = (
  config: LanguageUnits,
  node: SyntaxNodeView,
  depth: number,
): SyntaxNodeView[] => {
  if (depth > MAX_CONTAINER_DEPTH) return [];
  const found: SyntaxNodeView[] = [];
  for (const child of node.namedChildren()) {
    if (isUnit(config, child)) found.push(child);
    else if (config.containers.has(child.type)) found.push(...innerUnits(config, child, depth + 1));
  }
  return found;
};

/**
 * A unit that fits is one chunk; a larger one is split into its inner units (each strictly
 * inside it, so this ends), or into windows when it has none.
 */
const unitRanges = (
  lines: Lines,
  config: LanguageUnits,
  unit: SyntaxNodeView,
  start: number,
  end: number,
): Range[] => {
  if (lines.fits(start, end)) return [{ start, end, kind: unit.type }];
  const inner = innerUnits(config, unit, 0);
  if (inner.length === 0) return windows(lines, start, end, unit.type);
  return cover(lines, config, inner, start, end);
};

/** Drops blank edge rows; a range left with no content goes. */
const trimmed = (lines: Lines, ranges: readonly Range[]): Range[] => {
  const out: Range[] = [];
  for (const range of ranges) {
    let { start, end } = range;
    while (start <= end && lines.blank(start)) start++;
    while (end >= start && lines.blank(end)) end--;
    if (start <= end) out.push({ ...range, start, end });
  }
  return out;
};

const isSmall = (range: Range): boolean => range.end - range.start + 1 < INDEX_LIMITS.minChunkLines;

/**
 * Folds a short chunk into the next one (a comment or decorator belongs with what follows), or
 * into the previous one at the end of the file, when the result still fits. The merged chunk
 * keeps the unit's kind rather than `block`.
 */
const merged = (lines: Lines, ranges: readonly Range[]): Range[] => {
  const out: Range[] = [];
  for (let i = 0; i < ranges.length; i++) {
    let current = ranges[i] as Range;
    const next = ranges[i + 1];
    if (isSmall(current) && next !== undefined && lines.fits(current.start, next.end)) {
      current = {
        start: current.start,
        end: next.end,
        kind: next.kind === BLOCK || next.kind === WINDOW ? current.kind : next.kind,
      };
      i++;
    }
    const previous = out.at(-1);
    if (
      previous !== undefined &&
      (isSmall(current) || isSmall(previous)) &&
      lines.fits(previous.start, current.end)
    ) {
      out[out.length - 1] = {
        start: previous.start,
        end: current.end,
        kind: previous.kind === BLOCK || previous.kind === WINDOW ? current.kind : previous.kind,
      };
      continue;
    }
    out.push(current);
  }
  return out;
};

const drafts = (lines: Lines, ranges: readonly Range[]): CodeChunkDraft[] =>
  merged(lines, trimmed(lines, ranges))
    .slice(0, INDEX_LIMITS.maxChunksPerFile)
    .map((range) => ({
      startLine: range.start + 1,
      endLine: range.end + 1,
      kind: range.kind,
      text: lines.text(range.start, range.end),
    }));

/**
 * Function- and class-level chunks from a parsed file. Every line belongs to exactly one chunk
 * (blank edges aside): a unit that fits is one chunk; a larger one is split into its inner units
 * (a class into its methods) or, without any, into windows; the code between units is windowed.
 */
export const chunkFromSyntax = (
  language: ParsedLanguage,
  root: SyntaxNodeView,
  text: string,
): CodeChunkDraft[] => {
  const lines = new Lines(text);
  const config = UNITS[language];
  const units = root.namedChildren().filter((child) => isUnit(config, child));
  return drafts(lines, cover(lines, config, units, 0, lines.last));
};

/** Line windows, for languages without a parser and for files the parser gave up on. */
export const fallbackChunks = (text: string): CodeChunkDraft[] => {
  const lines = new Lines(text);
  return drafts(lines, windows(lines, 0, lines.last, WINDOW));
};

/** What is sent to the embedding model for a chunk: the path first, so it can match on it. */
export const embeddingInput = (path: string, chunk: CodeChunkDraft): string =>
  `${path}\n${chunk.text}`;

/** The token estimate of embedding inputs (the analysis estimate's upper bound per text). */
export const embeddingTokens = (inputs: readonly string[]): number =>
  inputs.reduce((sum, input) => sum + patchTokens(input), 0);

// --- Vectors -------------------------------------------------------------------------------------

/**
 * A provider's vector at the indexed width: checked against the space's `dimensions` (a wrong
 * width would corrupt the index), every value finite, padded with zeros to
 * `INDEX_VECTOR_DIMENSIONS`.
 */
export const toIndexVector = (vector: readonly number[], dimensions: number): number[] => {
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > INDEX_VECTOR_DIMENSIONS ||
    vector.length !== dimensions
  ) {
    throw new IndexInputError("index: vector width does not match the embedding space");
  }
  const out = new Array<number>(INDEX_VECTOR_DIMENSIONS).fill(0);
  for (let i = 0; i < dimensions; i++) {
    const value = vector[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new IndexInputError("index: vector holds a non-finite value");
    }
    out[i] = value;
  }
  return out;
};

// --- Which files a run fetches -------------------------------------------------------------------

/** A regular file of the commit being indexed, as the forge lists it. */
export interface IndexTreeEntry {
  readonly path: string;
  /** The git blob id of its content. */
  readonly blobSha: string;
  readonly size: number;
}

/** A file the index holds (indexed, or fetched and skipped) and the blob it was read from. */
export interface StoredIndexFile {
  readonly path: string;
  readonly blobSha: string;
}

export interface IndexRunPlan {
  /** Eligible files that are new or whose blob changed: fetched and indexed again. */
  readonly fetch: readonly IndexTreeEntry[];
  /** Stored files that are gone, renamed away or no longer eligible: their chunks go. */
  readonly remove: readonly string[];
  /** Eligible files whose stored blob is current. */
  readonly unchanged: number;
  /** Files skipped from their path and size alone, by reason. */
  readonly skipped: Readonly<Partial<Record<IndexSkipReason, number>>>;
  /**
   * Tokens the fetched files would cost to embed, from their sizes (ASCII at CHARS_PER_TOKEN,
   * plus each chunk's path prefix). The run's hard cap re-checks with the real text.
   */
  readonly estimatedTokens: number;
}

/**
 * Plans a run from the commit's tree and what the index holds: an incremental run after a push
 * and a first full run are the same plan (everything is new on the first).
 */
export const planIndexRun = (
  tree: readonly IndexTreeEntry[],
  stored: readonly StoredIndexFile[],
): IndexRunPlan => {
  const storedBlob = new Map(stored.map((file) => [file.path, file.blobSha]));
  const eligible = new Set<string>();
  const fetch: IndexTreeEntry[] = [];
  const skipped: Partial<Record<IndexSkipReason, number>> = {};
  let unchanged = 0;
  let estimatedTokens = 0;
  for (const entry of tree) {
    if (eligible.has(entry.path)) throw new IndexInputError("index: duplicate path in the tree");
    const decision = classifyPath(entry.path, entry.size);
    if (decision.kind === "skip") {
      skipped[decision.reason] = (skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    eligible.add(entry.path);
    if (storedBlob.get(entry.path) === entry.blobSha) {
      unchanged++;
      continue;
    }
    fetch.push(entry);
    const chunks = Math.max(1, Math.ceil(entry.size / INDEX_LIMITS.maxChunkChars));
    estimatedTokens +=
      Math.ceil(entry.size / CHARS_PER_TOKEN) +
      chunks * Math.ceil((utf8Length(entry.path) + 1) / CHARS_PER_TOKEN);
  }
  const remove = stored.filter((file) => !eligible.has(file.path)).map((file) => file.path);
  return { fetch, remove, unchanged, skipped, estimatedTokens };
};
