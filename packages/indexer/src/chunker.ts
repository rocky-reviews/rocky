import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  chunkFromSyntax,
  classifyContent,
  classifyPath,
  embeddingInput,
  fallbackChunks,
  type CodeChunkDraft,
  type IndexSkipReason,
  type ParsedLanguage,
  type SyntaxNodeView,
} from "@rocky-reviews/core";
import { Language, Parser, type Node } from "web-tree-sitter";

/**
 * The tree-sitter adapter (P9-1, ADR 0040 §2): parses a file with its language's grammar (the
 * WebAssembly build each grammar package ships, exact versions in package.json) and hands the
 * syntax tree to core's chunker. WebAssembly, not the native bindings: nothing compiles at
 * install time (the grammars' install scripts are not run), the same build runs on every platform
 * and in the distroless image, and a parser bug cannot corrupt the worker's own memory.
 *
 * Parsing is bounded in time (`parseTimeoutMs`); a parse that gives up, or a parser that cannot
 * load, falls back to line windows, so a hostile file costs at most the timeout.
 */

/** The `.wasm` of each parsed language, resolved inside its exact-versioned package. */
const GRAMMARS: Readonly<Record<ParsedLanguage, string>> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
};

/** Default bound on one file's parse. */
export const PARSE_TIMEOUT_MS = 2_000;

export interface ChunkerOptions {
  readonly parseTimeoutMs?: number;
}

export interface FileChunker {
  /** Chunks of a parsed language from its syntax tree; line windows when the parse gives up. */
  chunk(language: ParsedLanguage, text: string): Promise<CodeChunkDraft[]>;
}

let initialised: Promise<void> | undefined;
const languages = new Map<ParsedLanguage, Promise<Language>>();

const loadLanguage = (language: ParsedLanguage): Promise<Language> => {
  let loading = languages.get(language);
  if (loading === undefined) {
    loading = (async () => {
      const wasm = await readFile(fileURLToPath(import.meta.resolve(GRAMMARS[language])));
      return Language.load(wasm);
    })();
    // A failed load is not cached: the next file tries again.
    loading.catch(() => languages.delete(language));
    languages.set(language, loading);
  }
  return loading;
};

/** A tree-sitter node as core's chunker reads it; only named children, read on demand. */
const view = (node: Node): SyntaxNodeView => {
  const end = node.endPosition;
  const start = node.startPosition;
  return {
    type: node.type,
    startRow: start.row,
    // A node that ends at column 0 ends on the row before (its last newline).
    endRow: end.column === 0 && end.row > start.row ? end.row - 1 : end.row,
    namedChildren: () => node.namedChildren.filter((c): c is Node => c !== null).map(view),
  };
};

export const createTreeSitterChunker = async (
  options: ChunkerOptions = {},
): Promise<FileChunker> => {
  initialised ??= Parser.init();
  await initialised;
  const timeoutMs = options.parseTimeoutMs ?? PARSE_TIMEOUT_MS;
  return {
    chunk: async (language, text) => {
      let grammar: Language;
      try {
        grammar = await loadLanguage(language);
      } catch {
        return fallbackChunks(text);
      }
      const parser = new Parser();
      try {
        parser.setLanguage(grammar);
        const deadline = Date.now() + timeoutMs;
        const tree = parser.parse(text, null, {
          // Returning true cancels the parse (web-tree-sitter's progress callback).
          progressCallback: () => Date.now() >= deadline,
        });
        if (tree === null) return fallbackChunks(text);
        try {
          return chunkFromSyntax(language, view(tree.rootNode), text);
        } finally {
          tree.delete();
        }
      } catch {
        return fallbackChunks(text);
      } finally {
        parser.delete();
      }
    },
  };
};

/** git's blob id of `bytes` (`git hash-object`): what a tree listing names the content by. */
export const gitBlobSha = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

/** A chunk ready to store: its draft plus the sha256 of its embedded input (hex). */
export interface PreparedChunk extends CodeChunkDraft {
  readonly inputSha256: string;
}

export type PreparedFile =
  | { readonly kind: "skip"; readonly reason: IndexSkipReason }
  | {
      readonly kind: "chunks";
      readonly language: string;
      readonly chunks: readonly PreparedChunk[];
    };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const decode = (bytes: Uint8Array): string | undefined => {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * One fetched file to chunks, or the reason it is skipped. The path is classified again (the
 * caller may hold a file its tree listing sized differently), then the content, then it is
 * chunked by its language's parser or by line windows.
 */
export const prepareFile = async (
  chunker: FileChunker,
  path: string,
  bytes: Uint8Array,
): Promise<PreparedFile> => {
  const byPath = classifyPath(path, bytes.byteLength);
  if (byPath.kind === "skip") return byPath;
  const text = decode(bytes);
  const byContent = classifyContent(bytes, text);
  if (byContent.kind === "skip" || text === undefined) {
    return byContent.kind === "skip" ? byContent : { kind: "skip", reason: "binary" };
  }
  const drafts =
    byPath.kind === "parse" ? await chunker.chunk(byPath.language, text) : fallbackChunks(text);
  return {
    kind: "chunks",
    language: byPath.language,
    chunks: drafts.map((draft) => ({
      ...draft,
      // The hash of exactly what is embedded: reuse never carries a vector made for another path.
      inputSha256: createHash("sha256").update(embeddingInput(path, draft)).digest("hex"),
    })),
  };
};
