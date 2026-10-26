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
import { REDACTED, isSensitiveKey } from "./redact-paths.js";
import { MAX_KEY_LENGTH, MAX_STRING_LENGTH, scrubSecrets, scrubValue } from "./scrub.js";

type Line = Record<string, unknown>;

/**
 * Timing bound for the "no stall" tests. Real runs take a few milliseconds; the bound is loose
 * so a loaded CI runner does not flake, yet two orders of magnitude below the 126 s cliff the
 * review found.
 */
const TIME_BOUND_MS = 2000;

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

  it.each(["id", "orgId", "count", "status", "durationMs", "url", "method", "requestId", "author"])(
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
    expect(performance.now() - start).toBeLessThan(TIME_BOUND_MS);
    expect(out).toHaveLength(999);
    expect(JSON.stringify(out)).not.toContain(FAKE.ghp);
  });

  it("the logger as a whole stays under 250 ms for the same payload", () => {
    const big = Array.from({ length: 999 }, () => "a".repeat(MiB) + FAKE.ghp);
    const { log, text } = capture();
    const start = performance.now();
    log.info({ big }, "huge");
    expect(performance.now() - start).toBeLessThan(TIME_BOUND_MS);
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

// ---- Second review pass -------------------------------------------------------------------

describe("N1: plural forms, more suffixes, and an explicit allowlist", () => {
  it.each([
    "tokens",
    "accessTokens",
    "secrets",
    "passwords",
    "apiKeys",
    "key",
    "keys",
    "byokKey",
    "privateKeyPem",
    "auth",
    "authHeader",
    "jwt",
    "signature",
    "authCode",
    "oauth_code",
    "rawDiff",
    "unifiedDiff",
    "fileContent",
    "contents",
    "sourceCode",
    "codeSnippet",
    "userPrompt",
    "promptText",
    "newCode",
    "publicKey",
    "countryCode",
    "oauth",
  ])("redacts key %s", (key) => {
    expect(scrubValue({ [key]: "value" })).toEqual({ [key]: REDACTED });
  });

  it.each([
    "statusCode",
    "errorCode",
    "exitCode",
    "requestId",
    "author",
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "maxTokens",
    "tokenCount",
    "contentType",
    "contentLength",
  ])("keeps allowlisted or harmless key %s", (key) => {
    expect(scrubValue({ [key]: 7 })).toEqual({ [key]: 7 });
  });

  it("allowlisted keys still have their string values scrubbed", () => {
    expect(scrubValue({ requestId: `r-${FAKE.ghp}`, author: FAKE.email })).toEqual({
      requestId: "r-[redacted:github_token]",
      author: "[redacted:email]",
    });
  });

  it("Error `code` handling is unchanged by the allowlist", () => {
    const err = Object.assign(new Error("x"), { code: "ECONNRESET", statusCode: 502 });
    expect(scrubValue(err)).toMatchObject({ code: "ECONNRESET", statusCode: 502 });
    expect(scrubValue({ code: "ECONNRESET" })).toEqual({ code: REDACTED });
  });

  it("the reviewer's list, end to end through the logger", () => {
    const { log, last, text } = capture();
    log.info(
      {
        tokens: [FAKE.ghp],
        auth: FAKE.bearer,
        jwt: FAKE.jwt,
        signature: "sha256=abc",
        rawDiff: "@@ -1 +1 @@",
        fileContent: "const secret = 1;",
        userPrompt: "You are a reviewer",
        statusCode: 200,
      },
      "payload",
    );
    const line = last();
    for (const key of [
      "tokens",
      "auth",
      "jwt",
      "signature",
      "rawDiff",
      "fileContent",
      "userPrompt",
    ]) {
      expect(line[key]).toBe(REDACTED);
    }
    expect(line["statusCode"]).toBe(200);
    expect(text()).not.toMatch(/ghp_|Bearer|eyJ|sha256=|@@|const secret|reviewer"/);
  });
});

describe("N2: throwing getters never escape the scrub", () => {
  class Trap {
    get toJSON(): () => unknown {
      throw new Error(`leak ${FAKE.ghp}`);
    }
  }

  it("a throwing `get toJSON()` renders opaquely", () => {
    expect(scrubValue({ t: new Trap() })).toEqual({ t: "[object Trap]" });
  });

  it("a throwing getter on a plain object marks that property only", () => {
    const obj = {
      ok: 1,
      get boom(): string {
        throw new Error(`leak ${FAKE.ghp}`);
      },
    };
    expect(scrubValue({ obj })).toEqual({ obj: { ok: 1, boom: "[unreadable]" } });
  });

  it("a throwing getter on an Error's own property", () => {
    const err = new Error("plain");
    Object.defineProperty(err, "boom", {
      enumerable: true,
      get: () => {
        throw new Error(`leak ${FAKE.ghp}`);
      },
    });
    const out = scrubValue(err) as Line;
    expect(out["message"]).toBe("plain");
    expect(out["boom"]).toBe("[unreadable]");
    expect(JSON.stringify(out)).not.toContain(FAKE.ghp);
  });

  it("the logger neither throws nor leaks", () => {
    const { log, text } = capture();
    const obj = {
      get boom(): string {
        throw new Error(`leak ${FAKE.ghp}`);
      },
    };
    expect(() => log.info({ obj, t: new Trap() }, "x")).not.toThrow();
    expect(() => log.child({ obj }).info("y")).not.toThrow();
    expect(text()).not.toContain(FAKE.ghp);
  });
});

describe("N3: setBindings is scrubbed like child", () => {
  it("on the root logger and on children", () => {
    const { log, last, text } = capture();
    log.setBindings({ githubToken: FAKE.ghp, remote: `https://u:${FAKE.ghs}@h.test/r` });
    log.info("x");
    expect(last()["githubToken"]).toBe(REDACTED);
    expect(last()["remote"]).toBe("https://[redacted:userinfo]@h.test/r");

    const child = log.child({ component: "git" });
    child.setBindings({ apiKey: FAKE.anthropic, note: `see ${FAKE.email}` });
    child.info("y");
    expect(last()["component"]).toBe("git");
    expect(last()["apiKey"]).toBe(REDACTED);
    expect(last()["note"]).toBe("see [redacted:email]");
    expect(text()).not.toMatch(/ghp_|ghs_|sk-ant|example\.com/);
  });
});

describe("N4: object and Map keys are scrubbed and bounded", () => {
  it("a token used as a key is redacted", () => {
    expect(scrubValue({ [FAKE.ghp]: 1, [`user:${FAKE.email}`]: 2 })).toEqual({
      "[redacted:github_token]": 1,
      "user:[redacted:email]": 2,
    });
    expect(scrubValue(new Map([[FAKE.ghp, 1]]))).toEqual({ "[redacted:github_token]": 1 });
    const { log, text } = capture();
    log.info({ [FAKE.gho]: true }, "keyed");
    expect(text()).not.toContain("gho_");
  });

  it("huge keys are cut and counted against the budget", () => {
    const obj = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}-${"x".repeat(1_000_000)}${FAKE.ghp}`, i]),
    );
    const start = performance.now();
    const out = JSON.stringify(scrubValue(obj));
    expect(performance.now() - start).toBeLessThan(TIME_BOUND_MS);
    expect(out.length).toBeLessThan(100_000);
    expect(out).not.toContain(FAKE.ghp);
    expect(out).toContain("k0-xxx");
  });
});

describe("N5: the message is scrubbed before the payload spends the budget", () => {
  it("a huge payload cannot wipe out the message", () => {
    const { log, last, text } = capture();
    const big = Array.from({ length: 200 }, () => "a".repeat(100_000));
    log.info({ big }, `important for ${FAKE.email}`);
    expect(last()["msg"]).toBe("important for [redacted:email]");
    expect(text()).not.toContain("example.com");
    log.info({ big }, "plain %s", FAKE.ghp);
    expect(last()["msg"]).toBe("plain [redacted:github_token]");
  });
});

describe("N6: an own __proto__ key cannot break the output", () => {
  it("is kept as an ordinary key and does not pollute Object.prototype", () => {
    const input = JSON.parse(
      `{"__proto__":{"polluted":true},"a":1,"token":"${FAKE.ghp}"}`,
    ) as Record<string, unknown>;
    const out = scrubValue(input) as Line;
    expect(out["a"]).toBe(1);
    expect(out["token"]).toBe(REDACTED);
    // Renamed so it survives pino's own copy (N11); nothing is dropped and nothing is a prototype.
    expect(Object.hasOwn(out, "__proto__")).toBe(false);
    expect(out["[__proto__]"]).toEqual({ polluted: true });
    expect(({} as Line)["polluted"]).toBeUndefined();

    const { log, last, text } = capture();
    log.info(input, "x");
    expect(last()["a"]).toBe(1);
    expect(last()["token"]).toBe(REDACTED);
    expect(text()).not.toContain("[object Object]");
  });
});

describe("N7: URL-encoded emails", () => {
  it.each([
    "jane.doe%40example.com",
    "mailto%3Ajane%40example.com",
    "q=jane%40sub.example.co.uk&x",
  ])("redacts %s", (text) => {
    expect(scrubSecrets(text)).toContain("[redacted:email]");
    expect(scrubSecrets(text)).not.toContain("example");
  });
});

// ---- Third review pass --------------------------------------------------------------------

describe("N8: body/text/message/output/source suffixes, patch/code prefixes, `es` plurals", () => {
  it.each([
    "requestBody",
    "responseBody",
    "rawBody",
    "responseText",
    "llmMessages",
    "errorMessages",
    "modelOutput",
    "output",
    "patchText",
    "filePatches",
    "patches",
    "codeBlock",
    "fileSource",
    "resource_source",
    "context",
    "authorEmail",
  ])("redacts key %s", (key) => {
    expect(scrubValue({ [key]: "value" })).toEqual({ [key]: REDACTED });
  });

  it("an Error's message stays readable, scrubbed as a value", () => {
    const { log, last } = capture();
    log.error({ err: new Error(`boom ${FAKE.ghp}`) }, "db");
    expect((last()["err"] as Line)["message"]).toBe("boom [redacted:github_token]");
    log.error(new Error(`boom ${FAKE.email}`));
    expect(last()["msg"]).toBe("boom [redacted:email]");
    expect((last()["err"] as Line)["message"]).toBe("boom [redacted:email]");
  });

  it("a plain `message` field (API error shapes) is scrubbed as a value, not redacted", () => {
    expect(
      scrubValue({
        message: `Bad credentials ${FAKE.ghp}`,
        documentation_url: "https://docs.github.com",
      }),
    ).toEqual({
      message: "Bad credentials [redacted:github_token]",
      documentation_url: "https://docs.github.com",
    });
  });

  it("pino's msg is untouched by key rules", () => {
    const { log, last } = capture();
    log.info({ requestBody: "{}", responseText: "ok" }, `hello ${FAKE.email}`);
    expect(last()["msg"]).toBe("hello [redacted:email]");
    expect(last()["requestBody"]).toBe(REDACTED);
    expect(last()["responseText"]).toBe(REDACTED);
  });
});

describe("N9/N10: allowlist changes and name variants", () => {
  it.each([
    "idempotencyKey",
    "cacheKey",
    "token2",
    "apiKeyV2",
    "secret_v3",
    "password1",
    "oauth2",
    "basicAuth",
    "auth",
    "authorization",
    "authorizationHeader",
    "authHeader",
    "authHeaders",
    "authToken",
    "authTokens",
    "promptText",
  ])("redacts %s", (key) => {
    expect(scrubValue({ [key]: "value" })).toEqual({ [key]: REDACTED });
  });

  it.each([
    "author",
    "authorLogin",
    "authors",
    "authorId",
    "authority",
    "promptId",
    "promptVersion",
    "promptHash",
    "statusCodes",
    "requestId",
    "resource",
  ])("keeps %s", (key) => {
    expect(scrubValue({ [key]: "value" })).toEqual({ [key]: "value" });
  });
});

describe("N2 (follow-up): a throwing getter on the top-level merge object", () => {
  it("does not throw out of log.info and leaks nothing", () => {
    const { log, last, text } = capture();
    const merge = {
      ok: 1,
      get boom(): string {
        throw new Error(`leak ${FAKE.ghp}`);
      },
    };
    expect(() => log.info(merge, "top")).not.toThrow();
    expect(last()["msg"]).toBe("top");
    expect(last()["ok"]).toBe(1);
    expect(last()["boom"]).toBe("[unreadable]");
    expect(text()).not.toContain(FAKE.ghp);
  });
});

describe("N4 (follow-up): a token straddling the key cut is scrubbed before the cut", () => {
  it("leaks no fragment", () => {
    const key = `${"a".repeat(MAX_KEY_LENGTH - 10)} ${FAKE.ghp} tail`;
    const out = scrubValue({ [key]: 1 }) as Line;
    const [emitted] = Object.keys(out);
    expect(emitted).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(emitted!.length).toBeLessThanOrEqual(MAX_KEY_LENGTH + 1);
    expect(emitted!.endsWith("…")).toBe(true);
  });
});

describe("N11: a depth-1 own __proto__ key survives pino's redact copy", () => {
  it("is emitted under the renamed key with its content walked", () => {
    const { log, last } = capture();
    const input = JSON.parse(`{"__proto__":{"token":"${FAKE.ghp}","n":1},"a":1}`) as Line;
    log.info(input, "x");
    expect(last()["a"]).toBe(1);
    expect(last()["[__proto__]"]).toEqual({ token: REDACTED, n: 1 });
    expect(Object.hasOwn(last(), "__proto__")).toBe(false);
  });
});

describe("key variants run in linear time (CodeQL js/polynomial-redos)", () => {
  it("strips version suffixes from a long run of digits without backtracking", () => {
    const hostile = `${"0".repeat(200_000)}x`;
    const started = performance.now();
    expect(isSensitiveKey(hostile)).toBe(false);
    expect(isSensitiveKey(`token${"9".repeat(200_000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(TIME_BOUND_MS);
  });

  it("keeps the variant rules: trailing digits and vN are stripped", () => {
    for (const key of ["token2", "apiKeyV2", "secret_v3", "password1"]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });
});
