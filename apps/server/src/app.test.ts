import { createLogger } from "@rocky-reviews/log";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /healthz", () => {
  it("returns 200 when the database answers", async () => {
    const app = buildApp({ checkDatabase: () => Promise.resolve(true) });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, database: true });
  });

  it("returns 503 when the database check fails", async () => {
    const app = buildApp({ checkDatabase: () => Promise.reject(new Error("down")) });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
  });

  it("logs each request with a server-generated request id and returns it (P2-4)", async () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger("server-test", {
      destination: {
        write: (c: string) => void lines.push(JSON.parse(c) as Record<string, unknown>),
      },
    });
    const app = buildApp({ checkDatabase: () => Promise.resolve(true), log });
    const res = await app.inject({
      method: "GET",
      url: "/nope?token=should-not-appear",
      headers: { "x-request-id": "client-chosen" },
    });
    expect(res.statusCode).toBe(404);
    const requestId = res.headers["x-request-id"];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line["requestId"]).toBe(requestId);
    expect(JSON.stringify(lines)).not.toMatch(/should-not-appear|client-chosen/);
  });

  it("does not log health probes at info level (review F10)", async () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger("server-test", {
      destination: {
        write: (c: string) => void lines.push(JSON.parse(c) as Record<string, unknown>),
      },
    });
    const app = buildApp({ checkDatabase: () => Promise.resolve(true), log });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines).toEqual([]);
  });
});
