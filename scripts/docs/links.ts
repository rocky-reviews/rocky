import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

/**
 * The docs build (P10-3): every relative link in the repository's Markdown resolves to a file or
 * directory, and every `#anchor` to a heading (or an explicit `id`/`name` anchor) of the target
 * file, with GitHub's heading slugs. External links are not fetched.
 */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Every Markdown file under `repo`, repo-relative, sorted. */
export const markdownFiles = (repo: string): string[] =>
  walk(repo)
    .filter((path) => path.endsWith(".md"))
    .map((path) => relative(repo, path).split("\\").join("/"))
    .sort();

/** Lines outside fenced code blocks, with inline code spans blanked; numbering is kept. */
const proseLines = (markdown: string): string[] => {
  let fence: string | undefined;
  return markdown.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      return "";
    }
    if (marker !== undefined) {
      fence = marker;
      return "";
    }
    return line.replace(/(`+)[^`]*?\1/g, (span) => " ".repeat(span.length));
  });
};

/** Drops inline HTML tags, repeating until none is left (a removal can join a new tag). */
const stripTags = (text: string): string => {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(/<[^<>]*>/g, "");
  } while (current !== previous);
  return current;
};

/** GitHub's slug for a heading's text. */
export const githubSlug = (heading: string): string =>
  stripTags(heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"))
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** The anchors a Markdown file defines: heading slugs (deduplicated as GitHub does) and ids. */
export const anchorsOf = (markdown: string): Set<string> => {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      const base = githubSlug(heading);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of line.matchAll(/<a\s+(?:[^>]*?\s)?(?:id|name)=["']([^"']+)["']/gi)) {
      anchors.add(match[1] as string);
    }
  }
  return anchors;
};

export interface Link {
  readonly line: number;
  readonly target: string;
}

/** Inline links and images, and reference definitions, outside code. */
export const linksOf = (markdown: string): Link[] => {
  const links: Link[] = [];
  proseLines(markdown).forEach((text, index) => {
    for (const match of text.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'(][^)]*)?\)/g)) {
      links.push({ line: index + 1, target: (match[1] as string).replace(/^<|>$/g, "") });
    }
    const definition = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(text)?.[1];
    if (definition !== undefined) {
      links.push({ line: index + 1, target: definition.replace(/^<|>$/g, "") });
    }
  });
  return links;
};

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Problems with the relative links of `file` (repo-relative), as `file:line: message`.
 * `read` returns a file's text; `exists` says whether a repo-relative path exists, and
 * `isDirectory` whether it is a directory.
 */
export const checkFile = (
  file: string,
  read: (path: string) => string,
  exists: (path: string) => boolean,
  isDirectory: (path: string) => boolean,
): string[] => {
  const problems: string[] = [];
  const source = read(file);
  for (const { line, target } of linksOf(source)) {
    if (EXTERNAL.test(target)) continue;
    const where = `${file}:${line}`;
    const hash = target.indexOf("#");
    const pathPart = decodeURI(hash === -1 ? target : target.slice(0, hash));
    const anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
    if (pathPart.startsWith("/")) {
      problems.push(`${where}: ${target}: use a path relative to this file`);
      continue;
    }
    const path =
      pathPart === "" ? file : posix.join(posix.dirname(file), pathPart).replace(/\/+$/, "");
    if (path.startsWith("..")) {
      problems.push(`${where}: ${target}: points outside the repository`);
      continue;
    }
    if (!exists(path)) {
      problems.push(`${where}: ${target}: no such file`);
      continue;
    }
    if (anchor === undefined || anchor === "" || isDirectory(path) || !path.endsWith(".md")) {
      continue;
    }
    if (!anchorsOf(read(path)).has(anchor)) {
      problems.push(`${where}: ${target}: no heading or anchor #${anchor}`);
    }
  }
  return problems;
};

/** Checks every Markdown file of the repository. */
export const checkRepository = (repo: string): { files: number; problems: string[] } => {
  const root = resolve(repo);
  const cache = new Map<string, string>();
  const read = (path: string): string => {
    let text = cache.get(path);
    if (text === undefined) {
      text = readFileSync(join(root, path), "utf8");
      cache.set(path, text);
    }
    return text;
  };
  const files = markdownFiles(root);
  const problems = files.flatMap((file) =>
    checkFile(
      file,
      read,
      (path) => existsSync(join(root, path)),
      (path) => statSync(join(root, path)).isDirectory(),
    ),
  );
  return { files: files.length, problems };
};
