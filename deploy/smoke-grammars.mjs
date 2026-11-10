// Run by deploy/smoke.sh inside the running worker container (`node --input-type=module <
// smoke-grammars.mjs`, cwd /app): the tree-sitter runtime and every grammar packages/indexer
// resolves at run time (`import.meta.resolve`, ADR 0043 §1) must load from /app/node_modules in
// the distroless image, the same way the bundled chunker loads them. Exit 0 when each grammar
// parses a one-liner; 1 with the failing names otherwise. Prints nothing else.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

const SAMPLES = {
  "tree-sitter-typescript/tree-sitter-typescript.wasm": "const a: number = 1;",
  "tree-sitter-typescript/tree-sitter-tsx.wasm": "const a = <div />;",
  "tree-sitter-javascript/tree-sitter-javascript.wasm": "const a = 1;",
  "tree-sitter-python/tree-sitter-python.wasm": "a = 1",
  "tree-sitter-go/tree-sitter-go.wasm": "package main",
  "tree-sitter-rust/tree-sitter-rust.wasm": "fn main() {}",
  "tree-sitter-java/tree-sitter-java.wasm": "class A {}",
};

await Parser.init();
const failures = [];
for (const [specifier, source] of Object.entries(SAMPLES)) {
  try {
    const wasm = await readFile(fileURLToPath(import.meta.resolve(specifier)));
    const language = await Language.load(wasm);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (tree === null || tree.rootNode.hasError) failures.push(`${specifier}: parse error`);
    tree?.delete();
    parser.delete();
  } catch (error) {
    failures.push(`${specifier}: ${error?.code ?? error?.name ?? "error"}`);
  }
}
if (failures.length > 0) {
  process.stderr.write(`grammars failed: ${failures.join("; ")}\n`);
  process.exit(1);
}
