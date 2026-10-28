import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { publicRoute } from "./auth/policy.js";
import { ConfigError } from "./config.js";

/**
 * The built web app (P7-3, ADR 0025): the server serves `apps/web`'s Vite build from
 * `ROCKY_WEB_DIR`, so the SPA gets the same security headers as the API (one origin, one
 * header module). Files are read once at boot into a fixed route table: a request never touches
 * the filesystem, so there is no path to traverse. Symlinks, unknown file types and an
 * `index.html` with inline script or style are refused at boot (the CSP would block them).
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

/** Paths that are never the SPA, even when nothing matches (fixed 404 instead). */
const NOT_SPA = /^\/(?:api|auth|webhooks|setup|assets|healthz)(?:\/|$)/;

/** Inline content a strict CSP would block, found in an HTML document. Names only. */
export const findInlineContent = (html: string): string[] => {
  const found: string[] = [];
  for (const [, attrs = "", body = ""] of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
  )) {
    if (!/\ssrc\s*=/i.test(attrs) || body.trim() !== "") found.push("inline <script>");
  }
  if (/<style\b/i.test(html)) found.push("<style> element");
  if (/<[^>]*\sstyle\s*=/i.test(html)) found.push("style= attribute");
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) found.push("on*= event handler");
  if (/javascript:/i.test(html)) found.push("javascript: URL");
  return found;
};

export const loadWebApp = (dir: string): WebApp => {
  if (!isAbsolute(dir)) throw new ConfigError("ROCKY_WEB_DIR must be an absolute path");
  const files = new Map<string, WebFile>();
  let total = 0;
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      throw new ConfigError("ROCKY_WEB_DIR is not a readable directory");
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new ConfigError("ROCKY_WEB_DIR must not contain symlinks");
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      const contentType = TYPES[extname(name).toLowerCase()];
      if (!stat.isFile() || contentType === undefined) continue;
      const url = `/${relative(dir, path).split(sep).join("/")}`;
      if (!SAFE_PATH.test(url)) continue;
      total += stat.size;
      if (files.size >= MAX_FILES || total > MAX_TOTAL_BYTES) {
        throw new ConfigError("ROCKY_WEB_DIR is too large for a web app build");
      }
      files.set(url, {
        body: readFileSync(path),
        contentType,
        cacheControl: url.startsWith("/assets/") ? IMMUTABLE : REVALIDATE,
      });
    }
  };
  walk(dir);
  const built = files.get("/index.html");
  if (built === undefined) throw new ConfigError("ROCKY_WEB_DIR has no index.html");
  const inline = findInlineContent(built.body.toString("utf8"));
  if (inline.length > 0) {
    throw new ConfigError(
      `ROCKY_WEB_DIR/index.html has content the CSP blocks: ${inline.join(", ")}`,
    );
  }
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
 * a GET for a path that is not an API, auth, webhook or file path gets `index.html`.
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
      !NOT_SPA.test(path.toLowerCase()) &&
      !last.includes(".") &&
      !path.includes("%") &&
      !path.includes("\\")
    ) {
      return sendFile(reply, web.index);
    }
    return reply.code(404).send(NOT_FOUND);
  });
};
