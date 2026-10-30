import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { ConfigError } from "./config.js";
import { APP_CSP } from "./security/headers.js";
import { findInlineContent, loadWebApp } from "./web-app.js";

/** P7-3 (ADR 0025): the server hosts the built SPA with the same headers as everything else. */

const INDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rocky</title><script src="/theme-init.js"></script><script type="module" crossorigin src="/assets/index-abc123.js"></script><link rel="stylesheet" crossorigin href="/assets/index-abc123.css"></head><body><div id="app"></div></body></html>`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const webDir = (files: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-web-"));
  dirs.push(root);
  const all: Record<string, string> = {
    "index.html": INDEX,
    "theme-init.js": "document.documentElement.dataset.mode='light';",
    "assets/index-abc123.js": "console.log(1)",
    "assets/index-abc123.css": "body{margin:0}",
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const appWith = (root: string) =>
  buildApp({ checkDatabase: () => Promise.resolve(true), web: loadWebApp(root) });

describe("serving the built web app", () => {
  it("serves index.html at / with the app CSP and no-store", async () => {
    const app = appWith(webDir());
    const res = await app.inject({ url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe(APP_CSP);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.body).toBe(INDEX);
  });

  it("hashed assets are immutable; other files revalidate; types come from an allow-list", async () => {
    const app = appWith(webDir());
    const js = await app.inject({ url: "/assets/index-abc123.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
    const css = await app.inject({ url: "/assets/index-abc123.css" });
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    const theme = await app.inject({ url: "/theme-init.js" });
    expect(theme.headers["cache-control"]).toBe("no-cache");
    const head = await app.inject({ method: "HEAD", url: "/theme-init.js" });
    expect(head.statusCode).toBe(200);
  });

  it("client-side routes get index.html; API, auth, webhook and file-like paths do not", async () => {
    const app = appWith(webDir());
    for (const url of ["/inbox", "/acme/api/pull/12", "/settings/members?tab=1"]) {
      const res = await app.inject({ url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toBe(INDEX);
    }
    for (const url of [
      "/api/nope",
      "/auth/nope",
      "/webhooks/nope",
      "/assets/missing.js",
      "/favicon.ico",
      "/robots.txt",
      // Review round 1: odd spellings of API paths are not the SPA either.
      "//api/session",
      "//auth/github/login",
      "/api;x",
      "/api;/session",
      "/inbox;x",
      "/./api/session",
      "/a/../api",
      "/inbox//x",
      "/%2Fapi",
    ]) {
      const res = await app.inject({ url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
    expect((await app.inject({ method: "POST", url: "/inbox" })).statusCode).not.toBe(200);
  });

  it("only files enumerated at boot are served: no traversal, no dotfiles, no unknown types", async () => {
    const root = webDir({ ".env": "SECRET=1", "notes.md": "# x", "assets/x.php": "<?php" });
    writeFileSync(join(root, "..", `outside-${dirs.length}.txt`), "outside");
    const app = appWith(root);
    for (const url of [
      "/.env",
      "/notes.md",
      "/assets/x.php",
      "/../outside.txt",
      "/%2e%2e/outside.txt",
      "/assets/..%2f..%2fetc/passwd",
      "/assets/%2e%2e/%2e%2e/etc/passwd",
      "//etc/passwd",
      "/assets/index-abc123.js%00.html",
    ]) {
      const res = await app.inject({ url });
      expect(res.body, url).not.toMatch(/SECRET|outside|<\?php|root:/);
      expect(res.body === INDEX || res.statusCode === 404, url).toBe(true);
    }
  });

  it("refuses at boot: no index.html, a symlink, or inline script/style in index.html", () => {
    const noIndex = mkdtempSync(join(tmpdir(), "rocky-web-"));
    dirs.push(noIndex);
    expect(() => loadWebApp(noIndex)).toThrow(ConfigError);
    expect(() => loadWebApp(join(noIndex, "missing"))).toThrow(ConfigError);
    expect(() => loadWebApp("relative/dir")).toThrow(ConfigError);

    const linked = webDir();
    symlinkSync("/etc/hosts", join(linked, "assets", "hosts.js"));
    expect(() => loadWebApp(linked)).toThrow("must not contain symlinks");
    // A symlinked directory is refused too: the open itself refuses to follow (O_NOFOLLOW).
    const linkedDir = webDir();
    symlinkSync(webDir(), join(linkedDir, "vendor"));
    expect(() => loadWebApp(linkedDir)).toThrow("must not contain symlinks");

    for (const bad of [
      INDEX.replace("</head>", "<script>alert(1)</script></head>"),
      INDEX.replace("</head>", "<style>body{}</style></head>"),
      INDEX.replace('<div id="app">', '<div id="app" style="color:red">'),
      INDEX.replace('<div id="app">', '<div id="app" onclick="x()">'),
    ]) {
      expect(() => loadWebApp(webDir({ "index.html": bad }))).toThrow(ConfigError);
    }
  });
});

describe("findInlineContent", () => {
  it("passes the real shape of the Vite build (external scripts and styles only)", () => {
    expect(findInlineContent(INDEX)).toEqual([]);
  });

  it("a FIFO or other special file never blocks boot and is not served", () => {
    const root = webDir();
    execFileSync("mkfifo", [join(root, "assets", "pipe.js")]);
    const web = loadWebApp(root);
    expect(web.files.has("/assets/pipe.js")).toBe(false);
    expect(web.files.has("/assets/index-abc123.js")).toBe(true);
  });

  it("finds what a tag regexp misses: odd end tags, cases, svg, template, noscript, entities", () => {
    for (const [html, name] of [
      ["<script>x</script\t\n bar>", "inline <script>"],
      ['<script src="/a.js"></script><script>y</script\n>', "inline <script>"],
      ['<script src="">x</script>', "inline <script>"],
      ['<script src=" "></script>', "inline <script>"],
      ['<script type="importmap">{}</script>', "inline <script>"],
      ["<svg><script>x</script></svg>", "inline <script>"],
      ["<template><script>x</script></template>", "inline <script>"],
      ["<noscript><style>a{}</style></noscript>", "<style> element"],
      ["<svg><style>a{}</style></svg>", "<style> element"],
      ['<p STYLE="x">', "style= attribute"],
      ['<svg><rect ONCLICK="x"/></svg>', "on*= event handler"],
      ['<a href="  JAVA\nSCRIPT:alert(1)">', "javascript: URL"],
      ['<a href="&#106;avascript:alert(1)">', "javascript: URL"],
      ['<form action="\tjavascript:x">', "javascript: URL"],
      ['<svg><a xlink:href="javascript:x"><text>t</text></a></svg>', "javascript: URL"],
    ] as const) {
      expect(findInlineContent(html), JSON.stringify(html)).toContain(name);
    }
  });

  it("does not flag external scripts with whitespace bodies, data attributes or paths that contain the word", () => {
    expect(
      findInlineContent(
        '<script src="/a.js">\n</script><p data-style="1"></p><a href="/javascript:not-a-scheme">x</a>',
      ),
    ).toEqual([]);
  });

  it("finds inline scripts, style elements and attributes, event handlers and javascript: URLs", () => {
    expect(findInlineContent("<script>x</script>")).toEqual(["inline <script>"]);
    expect(findInlineContent("<SCRIPT type=module>x</SCRIPT>")).toEqual(["inline <script>"]);
    expect(findInlineContent("<style>a{}</style>")).toEqual(["<style> element"]);
    expect(findInlineContent('<p style="x">')).toEqual(["style= attribute"]);
    expect(findInlineContent("<p STYLE=x>")).toEqual(["style= attribute"]);
    expect(findInlineContent('<img src=x onerror="a()">')).toEqual(["on*= event handler"]);
    expect(findInlineContent('<a href="javascript:alert(1)">')).toEqual(["javascript: URL"]);
  });
});
