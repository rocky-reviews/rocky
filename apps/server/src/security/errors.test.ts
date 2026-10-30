import { createLogger } from "@rocky-reviews/log";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { publicRoute } from "../auth/policy.js";
import { errorBody } from "./errors.js";
import { HSTS, NON_DOCUMENT_CSP } from "./headers.js";

/**
 * P7-3 (ADR 0025), review round 1: errors answer with fixed bodies and the security headers,
 * including the malformed URLs Fastify refuses before routing (where no hook runs).
 */

const capture = () => {
  const lines: string[] = [];
  const log = createLogger("errors-test", {
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  return { log, lines };
};

const TEST_ROUTE = { config: { policy: publicRoute("test route") } };

const app = (hsts = false) => {
  const { log, lines } = capture();
  const built = buildApp({ checkDatabase: () => Promise.resolve(true), log, hsts });
  return { app: built, lines };
};

describe("malformed URLs (frameworkErrors)", () => {
  for (const url of ["/%", "/api/%zz", "/auth/%E0%A4%A"]) {
    it(`${url}: 400, fixed body that does not echo the URL, every security header`, async () => {
      const { app: a } = app(true);
      const res = await a.inject({ url });
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe('{"error":"bad_request"}');
      expect(res.body).not.toContain("%");
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.headers["content-security-policy"]).toBe(NON_DOCUMENT_CSP);
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["strict-transport-security"]).toBe(HSTS);
    });
  }
});

describe("root error handler", () => {
  it("a thrown error never returns or logs its message", async () => {
    const { app: a, lines } = app();
    a.get("/boom", TEST_ROUTE, async () => {
      throw new Error("secret detail from a driver");
    });
    a.get("/teapot", TEST_ROUTE, async () => {
      throw Object.assign(new Error("echoes /teapot?token=abc"), { statusCode: 418 });
    });
    const boom = await a.inject({ url: "/boom" });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: "internal" });
    expect(boom.headers["x-content-type-options"]).toBe("nosniff");
    expect(boom.headers["cache-control"]).toBe("no-store");
    const teapot = await a.inject({ url: "/teapot" });
    expect(teapot.statusCode).toBe(418);
    expect(teapot.json()).toEqual({ error: "bad_request" });
    const text = lines.join("\n");
    expect(text).not.toContain("secret detail");
    expect(text).not.toContain("token=abc");
    expect(text).toContain('"requestError":{"status":500}');
  });

  it("a body Fastify refuses to parse gets a fixed body, not the parser's message", async () => {
    const { app: a } = app();
    a.post(
      "/json",
      { config: { csrfExempt: "hmac_signature", policy: publicRoute("test route") } },
      async () => ({ ok: true }),
    );
    const res = await a.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: '{"secret":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request" });
  });

  it("errorBody maps known statuses and falls back by class", () => {
    expect(errorBody(413)).toEqual({ error: "payload_too_large" });
    expect(errorBody(422)).toEqual({ error: "bad_request" });
    expect(errorBody(503)).toEqual({ error: "internal" });
  });
});
