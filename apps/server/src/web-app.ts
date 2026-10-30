import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent,
} from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5";
import { publicRoute } from "./auth/policy.js";
import { ConfigError } from "./config.js";

/**
 * The built web app (P7-3, ADR 0025): the server serves `apps/web`'s Vite build from
 * `ROCKY_WEB_DIR`, so the SPA gets the same security headers as the API (one origin, one
 * header module). Files are read once at boot into a fixed route table: a request never touches
 * the filesystem, so there is no path to traverse. Symlinks, unknown file types and an HTML
 * file with inline script or style are refused at boot (the CSP would block them).
 *
 * Every file is read through one handle opened with `O_NOFOLLOW`: what is checked (`fstat`) is
 * what is read, so a path swapped for a symlink or a device between the two cannot be served.
 * Directories are listed by path (Node has no `openat`); each one is checked by `fstat` on its
 * handle before and by `stat` (device and inode) after its entries were read, so a directory
 * swapped for a symlink or another directory during the walk refuses the whole load. A swap
 * that is undone again before that second check is out of scope: the directory is the
 * operator's build output, read once at boot.
 */

export interface WebFile {
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface WebApp {
  /** URL path (`/assets/index-abc.js`) → file. */
  readonly files: ReadonlyMap<string, WebFile>;
  readonly index: WebFile;
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Vite puts content-hashed files under `assets/`: a new build never reuses their names. */
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const MAX_FILES = 2_000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const SAFE_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * What an SPA route can look like: non-empty segments of unreserved characters, none of them only dots. No `//`, `;`,
 * `%`, `\\` or the like, so `//api/session` or `/api;x` cannot dodge `NOT_SPA` (review round 1).
 */
const SPA_PATH = /^(?:\/(?!\.+(?:\/|$))[A-Za-z0-9._~@+-]+)*\/?$/;

/** Paths that are never the SPA, even when nothing matches (fixed 404 instead). */
const NOT_SPA = /^\/(?:api|auth|webhooks|setup|assets|healthz)(?:\/|$)/;

const isElement = (node: Tree.Node): node is Tree.Element => "tagName" in node;
const isTemplate = (node: Tree.Element): node is Tree.Template => "content" in node;
const isText = (node: Tree.ChildNode): node is Tree.TextNode => node.nodeName === "#text";

/**
 * The scheme of a URL a browser could run as script or markup (`javascript:`, `data:`,
 * `vbscript:`), or `undefined`. The URL parser drops every tab, LF and CR and leading C0
 * controls and spaces before it reads the scheme, case-insensitively, so this does the same.
 */
const scriptScheme = (value: string): string | undefined => {
  const stripped = value.replaceAll(/[\t\n\r]/g, "");
  let start = 0;
  while (start < stripped.length && stripped.charCodeAt(start) <= 0x20) start += 1;
  const lower = stripped.slice(start).toLowerCase();
  if (lower.startsWith("javascript:")) return "javascript";
  if (lower.startsWith("data:")) return "data";
  if (lower.startsWith("vbscript:")) return "vbscript";
  return undefined;
};

/**
 * Elements a Vite build never emits and whose presence alone changes what the page loads, runs
 * or navigates to: `<noscript>` (parsed differently with scripting on and off: raw text that
 * ends at the first `</noscript>`, even inside an attribute, so markup can hide in it), `<base>`,
 * plugins and frames, SVG animation of attribute values (`href` → `javascript:`), frames.
 */
const REFUSED_ELEMENTS: ReadonlySet<string> = new Set([
  "noscript",
  "base",
  "object",
  "embed",
  "iframe",
  "frame",
  "frameset",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);

/** Same-origin absolute path: `/assets/x.js`, never `//host/x.js`, `https:` or `x.js`. */
const SAME_ORIGIN_PATH = /^\/(?!\/)/;

/** `<link>` relations that load code or style; their targets must be same-origin paths. */
const LOADING_LINK_RELS: ReadonlySet<string> = new Set(["stylesheet", "modulepreload", "preload"]);

/**
 * Content a strict CSP would block or that changes what the page runs, found in an HTML
 * document. Names only, each once.
 *
 * The document is parsed twice with parse5 (the WHATWG algorithm): as a browser with scripting
 * on and as one with it off parse it, since the two differ inside `<noscript>` (raw text in one,
 * elements in the other), and every element of both trees is visited, in every namespace
 * (`<svg>`) and inside `<template>` contents. A text search for tags cannot know where a
 * `</script\t\n bar>` ends or what the parser makes of odd markup; `<noscript>` itself is
 * refused, so neither parse can hide anything in it.
 */
export const findInlineContent = (html: string): string[] => {
  const found = new Set<string>();
  const visit = (node: Tree.Node): void => {
    if (isElement(node)) {
      const name = node.tagName.toLowerCase();
      const attrs = new Map(node.attrs.map((a) => [a.name.toLowerCase(), a.value] as const));
      if (REFUSED_ELEMENTS.has(name)) found.add(`<${name}> element`);
      if (name === "script") {
        const src = attrs.get("src") ?? "";
        const body = node.childNodes.map((c) => (isText(c) ? c.value : "")).join("");
        if (src.trim() === "" || body.trim() !== "") found.add("inline <script>");
        else if (!SAME_ORIGIN_PATH.test(src)) found.add("cross-origin or relative script src");
      }
      if (name === "style") found.add("<style> element");
      if (name === "meta" && attrs.has("http-equiv")) found.add("meta http-equiv");
      if (name === "link") {
        const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
        if (rels.some((r) => LOADING_LINK_RELS.has(r))) {
          if (!SAME_ORIGIN_PATH.test(attrs.get("href") ?? "")) {
            found.add("cross-origin or relative link href");
          }
        }
      }
      for (const [attrName, value] of attrs) {
        if (attrName === "style") found.add("style= attribute");
        else if (attrName.startsWith("on")) found.add("on*= event handler");
        else if (attrName === "srcdoc") found.add("srcdoc= attribute");
        const scheme = scriptScheme(value);
        if (scheme !== undefined) found.add(`${scheme}: URL`);
      }
      if (isTemplate(node)) visit(node.content);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  for (const scriptingEnabled of [true, false]) visit(parse(html, { scriptingEnabled }));
  return [...found];
};

/** `fs.constants` without the flag this needs (another platform): refuse, never read bare. */
const flag = (name: "O_RDONLY" | "O_NOFOLLOW" | "O_NONBLOCK"): number => {
  const value = (constants as Readonly<Record<string, number | undefined>>)[name];
  if (value === undefined) {
    throw new ConfigError(
      `ROCKY_WEB_DIR cannot be loaded safely here: fs.constants.${name} is missing`,
    );
  }
  return value;
};

const changed = (): ConfigError =>
  new ConfigError("ROCKY_WEB_DIR changed while it was being loaded");

/**
 * Opens without following a symlink at the last step (`O_NOFOLLOW`) and without blocking on a
 * FIFO (`O_NONBLOCK`; a regular file reads the same). The error says what, never the path.
 */
const openNoFollow = (path: string, flags: number): number => {
  try {
    return openSync(path, flags);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new ConfigError(
      code === "ELOOP"
        ? "ROCKY_WEB_DIR must not contain symlinks"
        : "ROCKY_WEB_DIR has a file that cannot be read",
    );
  }
};

/** Exactly the `fstat` size from the same handle; a file that grew or shrank meanwhile is refused. */
const readExactly = (fd: number, size: number): Buffer => {
  const body = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, body, offset, size - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  if (offset !== size || readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) throw changed();
  return body;
};

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export const loadWebApp = (dir: string): WebApp => {
  if (!isAbsolute(dir)) throw new ConfigError("ROCKY_WEB_DIR must be an absolute path");
  const flags = flag("O_RDONLY") | flag("O_NOFOLLOW") | flag("O_NONBLOCK");
  const files = new Map<string, WebFile>();
  let total = 0;

  /** `dirFd` is an open handle to `current`; the caller closes it. */
  const walk = (current: string, dirFd: number): void => {
    const expected = fstatSync(dirFd);
    if (!expected.isDirectory()) throw changed();
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      throw new ConfigError("ROCKY_WEB_DIR is not a readable directory");
    }
    for (const entry of entries.sort(byName)) {
      const { name } = entry;
      if (name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) throw new ConfigError("ROCKY_WEB_DIR must not contain symlinks");
      const path = join(current, name);
      if (entry.isDirectory()) {
        const fd = openNoFollow(path, flags);
        try {
          walk(path, fd);
        } finally {
          closeSync(fd);
        }
        continue;
      }
      // Only candidates are ever opened: regular files by the listing, with a served extension
      // and a safe URL path. Devices, sockets, FIFOs, source maps or dotfiles are never touched.
      if (!entry.isFile()) continue;
      const contentType = TYPES[extname(name).toLowerCase()];
      if (contentType === undefined) continue;
      const url = `/${relative(dir, path).split(sep).join("/")}`;
      if (!SAFE_PATH.test(url)) continue;
      const fd = openNoFollow(path, flags);
      try {
        // The handle decides: whatever the listing said, this is what gets read.
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw changed();
        total += stat.size;
        if (files.size >= MAX_FILES || total > MAX_TOTAL_BYTES) {
          throw new ConfigError("ROCKY_WEB_DIR is too large for a web app build");
        }
        files.set(url, {
          body: readExactly(fd, stat.size),
          contentType,
          cacheControl: url.startsWith("/assets/") ? IMMUTABLE : REVALIDATE,
        });
      } finally {
        closeSync(fd);
      }
    }
    // The directory that was listed is still the one whose handle was checked (device and
    // inode), so what was read above came from it and not from a symlink or another directory
    // swapped in meanwhile.
    const after = statSync(current);
    if (after.dev !== expected.dev || after.ino !== expected.ino) throw changed();
  };

  let rootFd: number;
  try {
    // The root itself may be a symlink (a release directory); nothing below it may be.
    rootFd = openSync(dir, flag("O_RDONLY") | flag("O_NONBLOCK"));
  } catch {
    throw new ConfigError("ROCKY_WEB_DIR is not a readable directory");
  }
  try {
    walk(dir, rootFd);
  } finally {
    closeSync(rootFd);
  }

  // Every served HTML document, not only the shell: all of them run under the app CSP.
  for (const [url, file] of files) {
    if (!file.contentType.startsWith("text/html")) continue;
    const inline = findInlineContent(file.body.toString("utf8"));
    if (inline.length > 0) {
      throw new ConfigError(`ROCKY_WEB_DIR${url} has content the CSP blocks: ${inline.join(", ")}`);
    }
  }
  const built = files.get("/index.html");
  if (built === undefined) throw new ConfigError("ROCKY_WEB_DIR has no index.html");
  // The shell itself is never cached: a deploy must reach every browser at once.
  const index: WebFile = { ...built, cacheControl: "no-store" };
  files.set("/index.html", index);
  return { files, index };
};

const NOT_FOUND = { error: "not_found" } as const;

const sendFile = (reply: FastifyReply, file: WebFile) =>
  reply
    .header("content-type", file.contentType)
    .header("cache-control", file.cacheControl)
    .send(file.body);

/**
 * The fixed 404 (never echoes the URL), and with a web app its files plus the SPA fallback:
 * a GET for a path that is not an API, auth, webhook or file path gets `index.html`. The files
 * are public routes (P7-2): the shell holds no tenant data, and the sign-in page is in it.
 */
export const registerWebApp = (app: FastifyInstance, web: WebApp | undefined): void => {
  if (web !== undefined) {
    const policy = publicRoute("a file of the built web app (P7-3)");
    for (const [url, file] of web.files) {
      app.get(url, { config: { policy } }, async (_request, reply) => sendFile(reply, file));
    }
    app.get("/", { config: { policy } }, async (_request, reply) => sendFile(reply, web.index));
  }
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split(/[?#]/, 1)[0] ?? "/";
    const last = path.slice(path.lastIndexOf("/") + 1);
    if (
      web !== undefined &&
      (request.method === "GET" || request.method === "HEAD") &&
      SPA_PATH.test(path) &&
      !NOT_SPA.test(path.toLowerCase()) &&
      !last.includes(".")
    ) {
      return sendFile(reply, web.index);
    }
    return reply.code(404).send(NOT_FOUND);
  });
};
