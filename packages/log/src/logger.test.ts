import { describe, expect, it } from "vitest";
import { FAKE } from "./fixtures.js";
import { createLogger, newRequestId, withRequestId } from "./index.js";
import { REDACTED } from "./redact-paths.js";
import { MAX_STRING_LENGTH } from "./scrub.js";

type Line = Record<string, unknown>;

/** A logger writing JSON lines into an array, so tests can inspect exactly what would be emitted. */
const capture = () => {
  const lines: Line[] = [];
  const log = createLogger("test", {
    level: "trace",
    destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Line) },
  });
  return { log, lines, last: () => lines[lines.length - 1]! };
};

describe("createLogger", () => {
  it("emits JSON with name, level and message", () => {
    const { log, last } = capture();
    log.info({ orgId: "org-1" }, "hello");
    expect(last()).toMatchObject({ name: "test", level: 30, msg: "hello", orgId: "org-1" });
  });

  it("honours LOG_LEVEL by default and the explicit level option", () => {
    const { log } = capture();
    expect(log.level).toBe("trace");
    const previous = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "warn";
    try {
      expect(createLogger("env").level).toBe("warn");
    } finally {
      if (previous === undefined) delete process.env["LOG_LEVEL"];
      else process.env["LOG_LEVEL"] = previous;
    }
  });

  it("redacts sensitive fields at the top level and nested", () => {
    const { log, last } = capture();
    log.info(
      {
        token: FAKE.ghp,
        email: FAKE.email,
        user: { email: FAKE.email, settings: { apiKey: FAKE.anthropic } },
        req: { headers: { authorization: FAKE.bearer, cookie: "sid=abc", "x-api-key": "k" } },
      },
      "login",
    );
    const line = last();
    expect(line["token"]).toBe(REDACTED);
    expect(line["email"]).toBe(REDACTED);
    expect(line["user"]).toEqual({ email: REDACTED, settings: { apiKey: REDACTED } });
    expect(line["req"]).toEqual({
      headers: { authorization: REDACTED, cookie: REDACTED, "x-api-key": REDACTED },
    });
    expect(JSON.stringify(line)).not.toMatch(/ghp_|sk-ant|example\.com|sid=abc|Bearer/);
  });

  it("redacts code, diffs, patches and prompt bodies by key", () => {
    const { log, last } = capture();
    log.debug(
      {
        diff: "@@",
        patch: "p",
        code: "const a = 1;",
        prompt: "You are",
        messages: [{ role: "user", content: "hi" }],
        body: "PR text",
      },
      "analysis",
    );
    const line = last();
    for (const key of ["diff", "patch", "code", "prompt", "messages", "body"])
      expect(line[key]).toBe(REDACTED);
  });

  it("keeps error codes while redacting error messages and stacks", () => {
    const { log, last } = capture();
    const error = Object.assign(new Error(`connect failed using ${FAKE.ghp}`), {
      code: "ECONNRESET",
    });
    log.error({ err: error }, "db");
    const err = last()["err"] as Record<string, unknown>;
    expect(err["code"]).toBe("ECONNRESET");
    expect(err["message"]).toBe("connect failed using [redacted:github_token]");
    expect(String(err["stack"])).not.toContain(FAKE.ghp);
    expect(err["type"]).toBe("Error");
  });

  it("accepts an Error as the first argument", () => {
    const { log, last } = capture();
    log.error(new Error(`token ${FAKE.gho} rejected`));
    const line = last();
    expect(line["msg"]).toBe("token [redacted:github_token] rejected");
    expect((line["err"] as Record<string, unknown>)["message"]).toBe(
      "token [redacted:github_token] rejected",
    );
  });

  it("scrubs secrets from free-text messages and interpolation values", () => {
    const { log, last } = capture();
    log.warn(`refresh failed for ${FAKE.email} with ${FAKE.ghr}`);
    expect(last()["msg"]).toBe("refresh failed for [redacted:email] with [redacted:github_token]");
    log.warn("key %s rejected (%d)", FAKE.anthropic, 401);
    expect(last()["msg"]).toBe("key [redacted:anthropic_key] rejected (401)");
    log.warn({ a: 1 }, "jwt %s", FAKE.jwt);
    expect(last()["msg"]).toBe("jwt [redacted:jwt]");
  });

  it("scrubs secrets inside string values under harmless keys", () => {
    const { log, last } = capture();
    log.info({ note: `pem follows ${FAKE.pem}`, ids: [FAKE.awsAccessKey] }, "x");
    expect(last()["note"]).toBe("pem follows [redacted:private_key]");
    expect(last()["ids"]).toEqual(["[redacted:aws_access_key]"]);
  });

  it("truncates oversized strings so a diff pasted into a log line cannot be emitted whole", () => {
    const { log, last } = capture();
    log.info({ note: "d".repeat(MAX_STRING_LENGTH * 3) }, "m".repeat(MAX_STRING_LENGTH * 3));
    expect((last()["note"] as string).length).toBeLessThan(MAX_STRING_LENGTH + 64);
    expect((last()["msg"] as string).length).toBeLessThan(MAX_STRING_LENGTH + 64);
  });

  it("child loggers inherit redaction and scrubbing", () => {
    const { log, last } = capture();
    const child = log.child({ component: "worker" }).child({ job: "analyse" });
    child.info({ token: "t", nested: { email: FAKE.email } }, `msg ${FAKE.ghp}`);
    expect(last()).toMatchObject({
      component: "worker",
      job: "analyse",
      token: REDACTED,
      nested: { email: REDACTED },
    });
    expect(last()["msg"]).toBe("msg [redacted:github_token]");
  });

  it("never emits any fixture secret through any path", () => {
    const { log, lines } = capture();
    for (const secret of Object.values(FAKE)) {
      log.info(secret);
      log.info({ value: secret, list: [secret], deep: { deeper: { value: secret } } }, "v");
      log.info("value %s", secret);
      log.info(new Error(secret));
    }
    const everything = JSON.stringify(lines);
    for (const secret of Object.values(FAKE)) expect(everything).not.toContain(secret);
  });
});

describe("request ids", () => {
  it("newRequestId returns a UUID", () => {
    expect(newRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it("withRequestId binds the id to a child logger (generating one when absent)", () => {
    const { log, last } = capture();
    withRequestId(log, "req-1").info("a");
    expect(last()["requestId"]).toBe("req-1");
    withRequestId(log).info("b");
    expect(last()["requestId"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
