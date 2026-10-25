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
});
