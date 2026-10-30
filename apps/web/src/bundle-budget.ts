/**
 * P6-8 (ADR 0032): which JavaScript a page loads before its first render, read from Vite's
 * build manifest. The entry chunk and every chunk it imports statically, transitively; a chunk
 * reached only through `import()` is loaded later and is not initial. Shared chunks count once.
 */

/** The subset of a Vite manifest entry this needs (vite `ManifestChunk`). */
export type ManifestChunk = {
  file: string;
  isEntry?: boolean;
  imports?: readonly string[];
  dynamicImports?: readonly string[];
};
export type Manifest = Readonly<Record<string, ManifestChunk>>;

/** Initial JavaScript must stay under this, gzipped (the task's budget). */
export const INITIAL_JS_BUDGET_GZ = 300 * 1024;

/** The output files of `entry` and its static imports, in load order, each once. */
export const initialChunks = (manifest: Manifest, entry: string): string[] => {
  const files: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (chunk === undefined) throw new Error(`bundle budget: ${key} is not in the manifest`);
    files.push(chunk.file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(entry);
  return files;
};
