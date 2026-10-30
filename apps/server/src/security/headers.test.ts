import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { requires, SESSION_ROUTE } from "../auth/policy.js";
import {
  APP_CSP,
  BASELINE_HEADERS,
  HSTS,
  NON_DOCUMENT_CSP,
  pageCsp,
  registerSecurityHeaders,
} from "./headers.js";

/**
 * P7-3 (ADR 0025): one module sets the security headers on every response; a route that needs a
 * stricter policy (the auth and setup pages) sets its own value once and the hook keeps it.
 */

const bare = (hsts = false): FastifyInstance => {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app, { hsts });
  app.get("/page", async (_req, reply) => reply.type("text/html; charset=utf-8").send("<p>x</p>"));
  app.get("/json", async () => ({ ok: true }));
  app.get("/strict", async (_req, reply) =>
    reply
      .header("content-security-policy", pageCsp({ style: "a{}" }))
      .header("referrer-policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .send("<p>strict</p>"),
  );
  app.get("/cached", async (_req, reply) =>
    reply.header("cache-control", "public, max-age=60").send("x"),
  );
  app.get("/boom", async () => {
    throw new Error("secret detail");
  });
  return app;
};

/** Every header name appears once (no duplicates from a route plus the hook). */
const singleValued = (res: LightMyRequestResponse) => {
  for (const [name, value] of Object.entries(res.headers)) {
    if (name === "set-cookie") continue;
    expect(Array.isArray(value), name).toBe(false);
  }
};

const expectBaseline = (res: LightMyRequestResponse) => {
  for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
    expect(res.headers[name], name).toBe(value);
  }
  expect(res.headers["x-powered-by"]).toBeUndefined();
  expect(res.headers["server"]).toBeUndefined();
  singleValued(res);
};

describe("security headers on every response (P7-3)", () => {
  it("documents get the app CSP; everything else a policy that allows nothing", async () => {
    const app = bare();
    const page = await app.inject({ url: "/page" });
    expectBaseline(page);
    expect(page.headers["content-security-policy"]).toBe(APP_CSP);
    const json = await app.inject({ url: "/json" });
    expectBaseline(json);
    expect(json.headers["content-security-policy"]).toBe(NON_DOCUMENT_CSP);
  });

  it("the app CSP allows no inline script or style, no plugins, no framing, no base or foreign forms", () => {
    const directives = new Map(
      APP_CSP.split(";").map((d) => {
        const [name = "", ...values] = d.trim().split(/\s+/);
        return [name, values.join(" ")] as const;
      }),
    );
    expect(directives.get("default-src")).toBe("'self'");
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("style-src")).toBe("'self'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'none'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(directives.get("form-action")).toBe("'self'");
    expect(APP_CSP).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|data:|blob:|\*|https?:/);
  });

  it("no-store unless the route chose a cache policy (static assets)", async () => {
    const app = bare();
    for (const url of ["/page", "/json", "/strict", "/boom", "/missing"]) {
      const res = await app.inject({ url });
      expect(res.headers["cache-control"], url).toBe("no-store");
    }
    const cached = await app.inject({ url: "/cached" });
    expect(cached.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("errors and 404s carry the headers too", async () => {
    const app = bare();
    for (const url of ["/boom", "/missing"]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBeGreaterThanOrEqual(404);
      expectBaseline(res);
      expect(res.headers["content-security-policy"]).toBe(NON_DOCUMENT_CSP);
    }
  });

  it("keeps a route's stricter policy and sends it once (one source of truth)", async () => {
    const app = bare();
    const res = await app.inject({ url: "/strict" });
    singleValued(res);
    expect(res.headers["content-security-policy"]).toBe(pageCsp({ style: "a{}" }));
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("pageCsp: only the page's own style by hash, no forms unless named", () => {
    const csp = pageCsp({ style: "a{}" });
    expect(csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]+=*'; /);
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(pageCsp({ style: "a{}", formAction: "https://github.com" })).toContain(
      "form-action https://github.com",
    );
  });

  it("HSTS only when asked (production), always the fixed value", async () => {
    expect((await bare(false).inject({ url: "/json" })).headers["strict-transport-security"]).toBe(
      undefined,
    );
    const res = await bare(true).inject({ url: "/json" });
    expect(res.headers["strict-transport-security"]).toBe(HSTS);
    expect(HSTS).toMatch(/^max-age=\d{8,}$/);
  });

  it("removes X-Powered-By and Server if anything set them", async () => {
    const app = bare();
    app.get("/leaky", async (_req, reply) =>
      reply.header("x-powered-by", "Express").header("server", "nginx").send("x"),
    );
    const res = await app.inject({ url: "/leaky" });
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["server"]).toBeUndefined();
  });
});

describe("buildApp applies the headers everywhere (P7-3)", () => {
  it("on health, 404 and a refused state change", async () => {
    const app = buildApp({ checkDatabase: () => Promise.resolve(true) });
    for (const [method, url] of [
      ["GET", "/healthz"],
      ["GET", "/no/such/route?x=<script>"],
      ["POST", "/api/anything"],
    ] as const) {
      const res = await app.inject({ method, url });
      expectBaseline(res);
      expect(res.headers["cache-control"], url).toBe("no-store");
      expect(res.headers["strict-transport-security"]).toBeUndefined();
    }
  });

  it("the 404 body is fixed: it never echoes the URL", async () => {
    const app = buildApp({ checkDatabase: () => Promise.resolve(true) });
    const res = await app.inject({ url: "/no/such/route?x=%3Cscript%3E" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("on the access policy's denials (P7-2 hook answers before any handler)", async () => {
    const app = buildApp({ checkDatabase: () => Promise.resolve(true), hsts: true });
    app.get("/api/private", { config: { policy: SESSION_ROUTE } }, async () => ({ leak: 1 }));
    app.get("/api/admin", { config: { policy: requires("members.read") } }, async () => ({
      leak: 1,
    }));
    for (const url of ["/api/private", "/api/admin"]) {
      const res = await app.inject({ url, headers: { cookie: "__Host-rocky_session=forged" } });
      expect(res.statusCode, url).toBe(401);
      expect(res.body).not.toContain("leak");
      expectBaseline(res);
      expect(res.headers["content-security-policy"]).toBe(NON_DOCUMENT_CSP);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["strict-transport-security"]).toBe(HSTS);
    }
  });

  it("sends HSTS when built for production", async () => {
    const app = buildApp({ checkDatabase: () => Promise.resolve(true), hsts: true });
    const res = await app.inject({ url: "/healthz" });
    expect(res.headers["strict-transport-security"]).toBe(HSTS);
  });
});
