/**
 * Regression tests for the independent review of P2-4. Each `describe` is one finding; the
 * reviewer confirmed each leak by logging through `createLogger` and reading the JSON, so most
 * tests here do the same.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { addRequestIdHeader, fastifyLoggerOptions } from "./fastify.js";
import { FAKE, chars } from "./fixtures.js";
import { createLogger } from "./index.js";
import { REDACTED } from "./redact-paths.js";
import { MAX_STRING_LENGTH, scrubSecrets, scrubValue } from "./scrub.js";

type Line = Record<string, unknown>;

const capture = () => {
  const lines: Line[] = [];
  const log = createLogger("hardening", {
    level: "trace",
    destination: { write: (c: string) => void lines.push(JSON.parse(c) as Line) },
  });
  return { log, lines, last: () => lines[lines.length - 1]!, text: () => JSON.stringify(lines) };
};

/** Mimics axios: a class with `toJSON`, nested under `err.config.headers`. */
class AxiosHeaders {
  constructor(private readonly headers: Record<string, string>) {}
  toJSON(): Record<string, string> {
    return { ...this.headers };
  }
}

/** A class whose getters would throw or leak if anything touched them. */
class Vault {
  readonly #secret = FAKE.ghp;
  get secret(): string {
    throw new Error("getter touched");
  }
  get value(): string {
    return this.#secret;
  }
}

describe("F1: class instances are normalised, never passed through", () => {
  it("walks the toJSON output of class instances (axios-style headers)", () => {
    const err = Object.assign(new Error("request failed"), {
      config: {
        headers: new AxiosHeaders({ Authorization: FAKE.bearer, Accept: "application/json" }),
      },
      response: { status: 401, headers: new AxiosHeaders({ "set-cookie": "sid=secret-cookie" }) },
    });
    const { log, last, text } = capture();
    log.error({ err }, "axios");
    const logged = last()["err"] as { config: { headers: Line }; response: { headers: Line } };
    expect(logged.config.headers).toEqual({ Authorization: REDACTED, Accept: "application/json" });
    expect(logged.response.headers).toEqual({ "set-cookie": REDACTED });
    expect(text()).not.toMatch(/secret-cookie|Bearer/);
  });

  it("turns Map and Headers into plain, redacted objects", () => {
    const out = scrubValue({
      m: new Map<string, unknown>([
        ["authorization", FAKE.bearer],
        ["ok", 1],
      ]),
      h: new Headers({ cookie: "a=b", accept: "x" }),
      s: new Set([FAKE.email, "fine"]),
    });
    expect(out).toEqual({
      m: { authorization: REDACTED, ok: 1 },
      h: { cookie: REDACTED, accept: "x" },
      s: ["[redacted:email]", "fine"],
    });
  });

  it("turns URL into a sanitised string: no userinfo, no query, scrubbed path", () => {
    const url = new URL(`https://user:${FAKE.ghp}@example.com/repos/x?code=abc#frag`);
    expect(scrubValue({ url })).toEqual({ url: "https://example.com/repos/x" });
    expect(scrubValue({ url: new URL(`https://example.com/invite/${FAKE.ghp}`) })).toEqual({
      url: "https://example.com/invite/[redacted:github_token]",
    });
  });

  it("renders other class instances opaquely without touching their getters", () => {
    expect(scrubValue({ v: new Vault() })).toEqual({ v: "[object Vault]" });
  });

  it("treats binary data as opaque and dates through toJSON", () => {
    expect(scrubValue({ b: Buffer.from(FAKE.ghp), u: new Uint8Array(4) })).toEqual({
      b: "[object Buffer]",
      u: "[object Uint8Array]",
    });
    expect(scrubValue({ d: new Date(0) })).toEqual({ d: "1970-01-01T00:00:00.000Z" });
  });

  it("falls back to the opaque form when toJSON throws", () => {
    class Broken {
      toJSON(): never {
        throw new Error("nope");
      }
    }
    expect(scrubValue({ x: new Broken() })).toEqual({ x: "[object Broken]" });
  });
});

describe("F2: child bindings are redacted and scrubbed", () => {
  it("scrubs URLs with userinfo and redacts sensitive keys in bindings", () => {
    const { log, last, text } = capture();
    log
      .child({
        remote: `https://x-access-token:${FAKE.ghs}@github.com/o/r.git`,
        githubToken: FAKE.ghp,
        nested: { email: FAKE.email, note: `see ${FAKE.jwt}` },
      })
      .info("clone");
    expect(last()["remote"]).toBe("https://[redacted:userinfo]@github.com/o/r.git");
    expect(last()["githubToken"]).toBe(REDACTED);
    expect(last()["nested"]).toEqual({ email: REDACTED, note: "see [redacted:jwt]" });
    expect(text()).not.toMatch(/ghs_|ghp_|example\.com|eyJ/);
  });

  it("applies to grandchildren and to bindings holding class instances", () => {
    const { log, last, text } = capture();
    log
      .child({ component: "git" })
      .child({ target: new URL(`https://u:${FAKE.gho}@h.test/a?b=1`), v: new Vault() })
      .info("x");
    expect(last()["component"]).toBe("git");
    expect(last()["target"]).toBe("https://h.test/a");
    expect(last()["v"]).toBe("[object Vault]");
    expect(text()).not.toContain("gho_");
  });
});

describe("F3: sensitive keys match by suffix and substring, URL userinfo is scrubbed", () => {
  it.each([
    "githubToken",
    "authToken",
    "apiToken",
    "x-access-token",
    "csrf_token",
    "TOKEN",
    "clientSecret",
    "webhook_secret",
    "SharedSecret",
    "dbPassword",
    "user_password",
    "passwd",
    "pass",
    "pwd",
    "dbPwd",
    "dsn",
    "credentials",
    "awsCredential",
    "x-api-key",
    "apikey",
    "XApiKey",
    "setCookie",
    "cookies",
    "diff_hunk",
    "diffHunk",
    "hunk",
    "diff",
    "diffs",
    "diffText",
    "patch",
    "suggestionPatch",
    "privateKey",
    "authorization",
    "email",
  ])("redacts key %s", (key) => {
    expect(scrubValue({ [key]: "value" })).toEqual({ [key]: REDACTED });
  });

  it.each(["id", "orgId", "count", "status", "tokens", "durationMs", "url", "method", "requestId"])(
    "keeps harmless key %s",
    (key) => {
      expect(scrubValue({ [key]: "value" })).toEqual({ [key]: "value" });
    },
  );

  it("redacts the whole credentials object", () => {
    expect(scrubValue({ credentials: { user: "u", pass: "p" } })).toEqual({
      credentials: REDACTED,
    });
  });

  it("scrubs userinfo from URL-like strings anywhere", () => {
    expect(scrubSecrets("postgres://rocky:s3cret@db:5432/rocky")).toBe(
      "postgres://[redacted:userinfo]@db:5432/rocky",
    );
    expect(scrubValue({ databaseUrl: "postgres://rocky:s3cret@db:5432/rocky" })).toEqual({
      databaseUrl: "postgres://[redacted:userinfo]@db:5432/rocky",
    });
    expect(scrubSecrets(`https://x-access-token:${FAKE.ghs}@github.com/o/r`)).toBe(
      "https://[redacted:userinfo]@github.com/o/r",
    );
    expect(scrubSecrets("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("the reviewer's leaks, end to end", () => {
    const { log, last, text } = capture();
    log.info(
      {
        githubToken: FAKE.ghp,
        authToken: FAKE.gho,
        apiToken: FAKE.ghu,
        credentials: { pass: "hunter2" },
        databaseUrl: "postgres://rocky:hunter2@db/rocky",
        headers: { "x-access-token": FAKE.ghs },
        comment: { diff_hunk: "@@ -1 +1 @@\n-const a\n+const b" },
      },
      "leaks",
    );
    const line = last();
    expect(line["githubToken"]).toBe(REDACTED);
    expect(line["authToken"]).toBe(REDACTED);
    expect(line["apiToken"]).toBe(REDACTED);
    expect(line["credentials"]).toBe(REDACTED);
    expect(line["databaseUrl"]).toBe("postgres://[redacted:userinfo]@db/rocky");
    expect(line["headers"]).toEqual({ "x-access-token": REDACTED });
    expect(line["comment"]).toEqual({ diff_hunk: REDACTED });
    expect(text()).not.toMatch(/gh[opsu]_|hunter2|const a/);
  });
});

describe("F4: work per call is bounded", () => {
  const MiB = 1_048_576;

  it("scrubs 999 strings of 1 MiB in well under 250 ms and leaks nothing", () => {
    const big = Array.from({ length: 999 }, (_, i) => "a".repeat(MiB) + FAKE.ghp + String(i));
    const start = performance.now();
    const out = scrubValue(big) as string[];
    expect(performance.now() - start).toBeLessThan(250);
    expect(out).toHaveLength(999);
    expect(JSON.stringify(out)).not.toContain(FAKE.ghp);
  });

  it("the logger as a whole stays under 250 ms for the same payload", () => {
    const big = Array.from({ length: 999 }, () => "a".repeat(MiB) + FAKE.ghp);
    const { log, text } = capture();
    const start = performance.now();
    log.info({ big }, "huge");
    expect(performance.now() - start).toBeLessThan(250);
    expect(text()).not.toContain(FAKE.ghp);
  });

  it("a secret straddling the cut is still removed", () => {
    const note = `${"a".repeat(MAX_STRING_LENGTH - 10)} ${FAKE.ghp} tail`;
    const out = scrubValue({ note }) as { note: string };
    expect(out.note).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(out.note).toMatch(/…\[truncated \d+ chars\]$/);
  });

  it("a per-call budget caps total string work and marks what was dropped", () => {
    const many = Array.from({ length: 200 }, () => "b".repeat(MAX_STRING_LENGTH));
    const out = scrubValue(many) as string[];
    expect(out[0]).toBe("b".repeat(MAX_STRING_LENGTH));
    expect(out.some((s) => s.startsWith("[truncated"))).toBe(true);
  });
});

describe("F5: logging a URL or a class with private getters neither throws nor leaks", () => {
  it("URL and private-field classes", () => {
    const { log, last, text } = capture();
    expect(() =>
      log.info({ target: new URL(`https://u:${FAKE.gho}@example.com/x?y=1`), v: new Vault() }, "x"),
    ).not.toThrow();
    expect(last()["target"]).toBe("https://example.com/x");
    expect(last()["v"]).toBe("[object Vault]");
    expect(text()).not.toMatch(/gho_|y=1/);
  });
});

describe("F6: the `code` exception is narrow and only applies to errors", () => {
  const codeOf = (code: unknown): unknown =>
    (scrubValue(Object.assign(new Error("x"), { code })) as Line)["code"];

  it.each(["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "23505", "42P01", "P2002"])(
    "keeps %s on an Error",
    (code) => expect(codeOf(code)).toBe(code),
  );

  it.each([
    "482913",
    "E1",
    "e-conn",
    "ERR_x",
    "P20022",
    "ABCDEF",
    "const x = 1;",
    FAKE.awsAccessKey,
    42,
  ])("redacts %s on an Error", (code) => expect(codeOf(code)).toBe(REDACTED));

  it("never keeps code on plain objects", () => {
    expect(scrubValue({ code: "ECONNRESET" })).toEqual({ code: REDACTED });
    const { log, last } = capture();
    log.info({ code: "482913" }, "x");
    expect(last()["code"]).toBe(REDACTED);
  });
});

describe("F7: Bearer is case-insensitive and GitHub's `token` scheme is covered", () => {
  it.each([
    `bearer ${chars(40)}`,
    `BEARER ${chars(40)}`,
    `Authorization: token ${chars(40)}`,
    `authorization=token ${chars(40)}`,
    `token ${"0123456789abcdef".repeat(2)}01234567`,
  ])("redacts %s", (text) => {
    const out = scrubSecrets(`header ${text} end`);
    expect(out).not.toContain(chars(40));
    expect(out).not.toContain("0123456789abcdef");
    expect(out).toMatch(/\[redacted:(bearer|token)\]/);
  });

  it("does not eat prose that merely mentions a token", () => {
    expect(scrubSecrets("token expired for installation-12345678")).toBe(
      "token expired for installation-12345678",
    );
  });
});

describe("F8: the email pattern requires an alphabetic TLD", () => {
  it.each([
    "pkg@1.2.3",
    "vite@8.3.4",
    "node_modules/.pnpm/pino@10.4.0/node_modules/pino",
    "@rocky-reviews/log@0.0.0",
    "user@localhost",
  ])("leaves %s alone", (text) => expect(scrubSecrets(text)).toBe(text));

  it.each(["a@b.co", "first.last@sub.example.co.uk", "x+y@example.io", "Jane@EXAMPLE.ORG"])(
    "still redacts %s",
    (email) => expect(scrubSecrets(`<${email}>`)).toBe("<[redacted:email]>"),
  );
});

describe("F9: secrets in request paths are scrubbed by the Fastify serializer", () => {
  it("logs /invite/<token> without the token", async () => {
    const { log, lines, text } = capture();
    const app = Fastify(fastifyLoggerOptions(log));
    addRequestIdHeader(app);
    app.get("/invite/:token", async () => ({ ok: true }));
    try {
      const res = await app.inject({ method: "GET", url: `/invite/${FAKE.ghp}?x=1` });
      expect(res.statusCode).toBe(200);
      const incoming = lines.find((l) => l["msg"] === "incoming request")!;
      expect(incoming["req"]).toEqual({ method: "GET", url: "/invite/[redacted:github_token]" });
      expect(text()).not.toMatch(/ghp_|x=1/);
    } finally {
      await app.close();
    }
  });
});
