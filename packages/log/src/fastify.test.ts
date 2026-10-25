import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { addRequestIdHeader, fastifyLoggerOptions } from "./fastify.js";
import { FAKE } from "./fixtures.js";
import { createLogger } from "./index.js";

type Line = Record<string, unknown>;

const build = () => {
  const lines: Line[] = [];
  const log = createLogger("server", {
    destination: { write: (c: string) => void lines.push(JSON.parse(c) as Line) },
  });
  const app = Fastify(fastifyLoggerOptions(log));
  addRequestIdHeader(app);
  app.get("/ok", async (req) => {
    req.log.info({ token: FAKE.ghp }, `handler saw ${FAKE.email}`);
    return { ok: true };
  });
  app.get("/boom", async () => {
    throw Object.assign(new Error(`upstream rejected ${FAKE.gho}`), { code: "EUPSTREAM" });
  });
  return { app, lines, log };
};

describe("fastifyLoggerOptions", () => {
  let app: ReturnType<typeof build>["app"] | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("logs requests with a generated request id and a path without query string or headers", async () => {
    const built = build();
    app = built.app;
    const res = await app.inject({
      method: "GET",
      url: `/ok?code=oauth-code-123&state=s`,
      headers: { authorization: FAKE.bearer, cookie: "sid=1", "x-request-id": "attacker-chosen" },
    });
    expect(res.statusCode).toBe(200);

    const incoming = built.lines.find((l) => l["msg"] === "incoming request")!;
    const requestId = incoming["requestId"] as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId).not.toBe("attacker-chosen");
    expect(res.headers["x-request-id"]).toBe(requestId);
    expect(incoming["req"]).toEqual({ method: "GET", url: "/ok" });

    const handler = built.lines.find((l) => l["msg"] === "handler saw [redacted:email]")!;
    expect(handler["requestId"]).toBe(requestId);
    expect(handler["token"]).toBe("[redacted]");

    const completed = built.lines.find((l) => l["msg"] === "request completed")!;
    expect(completed["requestId"]).toBe(requestId);
    expect(completed["res"]).toEqual({ statusCode: 200 });
    expect(typeof completed["responseTime"]).toBe("number");

    const everything = JSON.stringify(built.lines);
    expect(everything).not.toMatch(
      /oauth-code-123|sid=1|Bearer|ghp_|example\.com|remoteAddress|"host"/,
    );
  });

  it("logs handler errors with the code kept and the message scrubbed", async () => {
    const built = build();
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/boom?token=abc" });
    expect(res.statusCode).toBe(500);
    const errored = built.lines.find((l) => typeof l["err"] === "object" && l["err"] !== null)!;
    const err = errored["err"] as Line;
    expect(err["code"]).toBe("EUPSTREAM");
    expect(err["message"]).toBe("upstream rejected [redacted:github_token]");
    expect(JSON.stringify(built.lines)).not.toMatch(/gho_|token=abc/);
  });

  it("logs a 404 without the query string", async () => {
    const built = build();
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/missing?secret=1" });
    expect(res.statusCode).toBe(404);
    const notFound = built.lines.find((l) => l["msg"] === "route not found")!;
    expect(notFound).toMatchObject({ method: "GET", url: "/missing" });
    expect(JSON.stringify(built.lines)).not.toContain("secret=1");
  });
});
