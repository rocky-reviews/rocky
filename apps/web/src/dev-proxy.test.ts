import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_SERVER_ENV, devProxy, devProxyTarget, DevProxyConfigError } from "./dev-proxy.js";

/**
 * H4-2: the Vite dev server proxies `/api` and `/auth` to the Rocky server so the browser sees
 * one origin (cookies, CSRF). Runs Vite with the app's own `vite.config.ts` in front of a stub
 * server that records what reached it: the browser's Host, Origin, Cookie and CSRF header arrive
 * unchanged with no `X-Forwarded-*`, and the server's `Set-Cookie` and redirects come back as
 * written. Other paths stay with Vite.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("devProxyTarget", () => {
  it("defaults to the local server, can be moved or turned off", () => {
    expect(devProxyTarget({})).toBe("http://127.0.0.1:4310");
    expect(devProxyTarget({ [DEV_SERVER_ENV]: "" })).toBe("http://127.0.0.1:4310");
    expect(devProxyTarget({ [DEV_SERVER_ENV]: "http://localhost:4400" })).toBe(
      "http://localhost:4400",
    );
    expect(devProxyTarget({ [DEV_SERVER_ENV]: "https://rocky.dev.example" })).toBe(
      "https://rocky.dev.example",
    );
    expect(devProxyTarget({ [DEV_SERVER_ENV]: "off" })).toBeNull();
    expect(devProxy(null)).toBeUndefined();
  });

  it("refuses plain http off loopback, a path, credentials or junk", () => {
    for (const bad of [
      "http://rocky.lan:4310",
      "http://127.0.0.1:4310/api",
      "https://user:pw@rocky.dev.example",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect(() => devProxyTarget({ [DEV_SERVER_ENV]: bad }), bad).toThrow(DevProxyConfigError);
    }
  });
});

describe("the dev server in front of the Rocky server", () => {
  let upstream: Server;
  let vite: ViteDevServer;
  let base: string;
  const seen: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      if (req.url?.startsWith("/auth/github/login")) {
        res.writeHead(302, {
          location: "https://github.com/login/oauth/authorize?client_id=x",
          "set-cookie": "rocky_login=abc; Path=/; HttpOnly; SameSite=Lax",
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "rocky_session=t0k; Path=/; HttpOnly; SameSite=Lax",
      });
      res.end(JSON.stringify({ upstream: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    const before = process.env[DEV_SERVER_ENV];
    process.env[DEV_SERVER_ENV] = `http://127.0.0.1:${port}`;
    try {
      vite = await createServer({
        root: ROOT,
        configFile: join(ROOT, "vite.config.ts"),
        logLevel: "silent",
        server: { port: 0, strictPort: false },
      });
      await vite.listen();
    } finally {
      if (before === undefined) delete process.env["ROCKY_DEV_SERVER_URL"];
      else process.env[DEV_SERVER_ENV] = before;
    }
    const address = vite.httpServer?.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await vite?.close();
    await new Promise((resolve) => upstream?.close(resolve));
  });

  it("passes an API request through with the browser's Host, Origin, cookie and CSRF header", async () => {
    const res = await fetch(`${base}/api/analyses/x/drafts/F1`, {
      method: "POST",
      headers: {
        origin: base,
        cookie: "rocky_session=t0k",
        "x-rocky-csrf": "csrf-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "accept" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upstream: true });
    expect(res.headers.get("set-cookie")).toBe("rocky_session=t0k; Path=/; HttpOnly; SameSite=Lax");
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: "POST", url: "/api/analyses/x/drafts/F1" });
    expect(last.headers).toMatchObject({
      host: new URL(base).host,
      origin: base,
      cookie: "rocky_session=t0k",
      "x-rocky-csrf": "csrf-token",
    });
    expect(Object.keys(last.headers).filter((h) => h.startsWith("x-forwarded"))).toEqual([]);
  });

  it("proxies `/api` itself and `/auth` with a query", async () => {
    await (await fetch(`${base}/api`)).text();
    expect(seen.at(-1)?.url).toBe("/api");
    await (await fetch(`${base}/auth?x=1`)).text();
    expect(seen.at(-1)?.url).toBe("/auth?x=1");
  });

  it("passes the login redirect and its cookie back untouched", async () => {
    const res = await fetch(`${base}/auth/github/login?returnTo=%2Finbox`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize?client_id=x",
    );
    expect(res.headers.get("set-cookie")).toContain("rocky_login=abc");
    expect(seen.at(-1)?.url).toBe("/auth/github/login?returnTo=%2Finbox");
  });

  it("keeps the app's own pages, webhooks and lookalike paths with Vite", async () => {
    const count = seen.length;
    for (const path of [
      "/acme/rocky-app/pull/847",
      "/inbox",
      "/webhooks/github",
      "/apis",
      "/authors/x/pull/1",
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      await res.text();
    }
    expect(seen.length).toBe(count);
  });
});
