import { describe, expect, it } from "vitest";
import { FAKE, chars, type FakeSecretName } from "./fixtures.js";
import { REDACTED } from "./redact-paths.js";
import {
  MAX_DEPTH,
  MAX_NODES,
  MAX_SCAN_LENGTH,
  MAX_STRING_LENGTH,
  scrubSecrets,
  scrubValue,
} from "./scrub.js";

const KINDS: Record<FakeSecretName, string> = {
  ghp: "github_token",
  gho: "github_token",
  ghs: "github_token",
  ghu: "github_token",
  ghr: "github_token",
  githubPat: "github_token",
  anthropic: "anthropic_key",
  genericSk: "api_key",
  openaiProject: "api_key",
  jwt: "jwt",
  email: "email",
  pem: "private_key",
  awsAccessKey: "aws_access_key",
  awsSecretLine: "aws_secret_key",
  bearer: "bearer",
  basic: "basic_auth",
};

describe("scrubSecrets", () => {
  it.each(Object.keys(FAKE) as FakeSecretName[])("redacts a %s embedded in a message", (name) => {
    const secret = FAKE[name];
    const out = scrubSecrets(`request failed for ${secret} (retrying)`);
    expect(out).not.toContain(secret);
    expect(out).toContain(`[redacted:${KINDS[name]}]`);
    expect(out.startsWith("request failed for ")).toBe(true);
    expect(out.endsWith(" (retrying)")).toBe(true);
  });

  it("redacts several secrets of different kinds in one string", () => {
    const out = scrubSecrets(`${FAKE.ghp} ${FAKE.email} ${FAKE.jwt} ${FAKE.anthropic}`);
    expect(out).toBe(
      "[redacted:github_token] [redacted:email] [redacted:jwt] [redacted:anthropic_key]",
    );
  });

  it("redacts a token glued to punctuation and quotes", () => {
    expect(scrubSecrets(`token="${FAKE.ghp}",`)).toBe('token="[redacted:github_token]",');
    expect(scrubSecrets(`<${FAKE.email}>`)).toBe("<[redacted:email]>");
    expect(scrubSecrets(`Authorization: ${FAKE.bearer}`)).toBe("Authorization: [redacted:bearer]");
  });

  it("redacts a PEM block without an END marker up to the end of the text", () => {
    const [begin] = FAKE.pem.split("\n");
    const out = scrubSecrets(`key:\n${begin}\n${chars(64)}\n${chars(20)}`);
    expect(out).toBe("key:\n[redacted:private_key]");
  });

  it.each([
    "no secrets here",
    "sk-1234",
    "ghp_short",
    "see https://github.com/rocky-reviews/rocky/pull/847",
    "commit 3d02f0b2b766c4f952390dcf8985e1d2c3b4a5f6",
    'import { x } from "@rocky-reviews/log"',
    "Bearer scheme is required",
    "ERR_STREAM_PREMATURE_CLOSE",
    "AKIAXXXX",
  ])("leaves harmless text alone: %s", (text) => {
    expect(scrubSecrets(text)).toBe(text);
  });

  it("is bounded: pathological inputs finish quickly and huge strings are not scanned", () => {
    const pathological = [
      "sk-".repeat(50_000),
      "eyJ.".repeat(50_000),
      "a@".repeat(50_000),
      "-----BEGIN ".repeat(20_000),
    ];
    for (const input of pathological) {
      const start = performance.now();
      scrubSecrets(input);
      expect(performance.now() - start).toBeLessThan(250);
    }
    const huge = "x".repeat(MAX_SCAN_LENGTH + 1);
    expect(scrubSecrets(huge)).toBe(`[truncated: ${MAX_SCAN_LENGTH + 1} chars not scanned]`);
    expect(scrubSecrets("x".repeat(MAX_SCAN_LENGTH))).toHaveLength(MAX_SCAN_LENGTH);
  });
});

describe("scrubValue", () => {
  it("redacts sensitive keys at any depth, in any casing or separator style", () => {
    const out = scrubValue({
      user: {
        profile: {
          Email: "a@b.co",
          access_token: "x",
          "api-key": "y",
          nested: { PRIVATE_KEY: "z" },
        },
      },
      list: [{ token: "t" }, { ok: 1 }],
    }) as Record<string, unknown>;
    expect(out).toEqual({
      user: {
        profile: {
          Email: REDACTED,
          access_token: REDACTED,
          "api-key": REDACTED,
          nested: { PRIVATE_KEY: REDACTED },
        },
      },
      list: [{ token: REDACTED }, { ok: 1 }],
    });
  });

  it("redacts PR content and prompt bodies by key", () => {
    const out = scrubValue({
      diff: "@@ -1 +1 @@",
      patch: "p",
      hunks: [],
      code: "const x = 1;",
      snippet: "s",
      source: "src",
      prompt: "You are",
      prompts: [],
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      content: "c",
      body: "b",
      text: "t",
      completion: "done",
      suggestion: "fix",
    });
    for (const value of Object.values(out as Record<string, unknown>)) expect(value).toBe(REDACTED);
  });

  it("keeps error-code identifiers under an Error's `code` but redacts anything else", () => {
    const codeOf = (code: unknown) =>
      (scrubValue(Object.assign(new Error("x"), { code })) as Record<string, unknown>)["code"];
    expect(codeOf("ECONNRESET")).toBe("ECONNRESET");
    expect(codeOf("ERR_STREAM_PREMATURE_CLOSE")).toBe("ERR_STREAM_PREMATURE_CLOSE");
    expect(codeOf("23505")).toBe("23505");
    expect(codeOf("P2002")).toBe("P2002");
    expect(codeOf("const x = 1;")).toBe(REDACTED);
    expect(codeOf("abc123def456abc123de")).toBe(REDACTED);
    expect(codeOf(FAKE.awsAccessKey)).toBe(REDACTED);
    expect(codeOf(42)).toBe(REDACTED);
    expect(scrubValue({ code: "ECONNRESET" })).toEqual({ code: REDACTED });
  });

  it("scrubs secrets inside string values of non-sensitive keys", () => {
    expect(scrubValue({ msg: `got ${FAKE.ghp}`, items: [`${FAKE.email}`] })).toEqual({
      msg: "got [redacted:github_token]",
      items: ["[redacted:email]"],
    });
  });

  it("truncates long strings after scrubbing", () => {
    const long = "y".repeat(MAX_STRING_LENGTH + 100) + FAKE.ghp;
    const out = scrubValue({ long }) as { long: string };
    expect(out.long).not.toContain(FAKE.ghp);
    expect(out.long.startsWith("y".repeat(MAX_STRING_LENGTH))).toBe(true);
    expect(out.long).toMatch(/…\[truncated \d+ chars\]$/);
  });

  it("serialises Error instances with scrubbed message and stack and keeps their code", () => {
    const error = Object.assign(new Error(`boom ${FAKE.ghp}`), { code: "ECONNRESET", token: "t" });
    const out = scrubValue(error) as Record<string, unknown>;
    expect(out["type"]).toBe("Error");
    expect(out["message"]).toBe("boom [redacted:github_token]");
    expect(String(out["stack"])).not.toContain(FAKE.ghp);
    expect(out["code"]).toBe("ECONNRESET");
    expect(out["token"]).toBe(REDACTED);
  });

  it("bounds depth, node count and cycles", () => {
    let deep: Record<string, unknown> = { leaf: FAKE.ghp };
    for (let i = 0; i < MAX_DEPTH + 2; i++) deep = { next: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain("[truncated]");
    expect(JSON.stringify(scrubValue(deep))).not.toContain(FAKE.ghp);

    const wide = Object.fromEntries(
      Array.from({ length: MAX_NODES + 50 }, (_, i) => [`k${i}`, FAKE.ghp]),
    );
    const text = JSON.stringify(scrubValue(wide));
    expect(text).toContain("[truncated]");
    expect(text).not.toContain(FAKE.ghp);

    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(scrubValue(cyclic)).toEqual({ name: "loop", self: "[circular]" });
  });

  it("passes primitives through and normalises non-plain objects", () => {
    class Thing {
      token = "never-passed-through";
    }
    const out = scrubValue({
      n: 1,
      b: true,
      nil: null,
      u: undefined,
      date: new Date(0),
      buffer: Buffer.from("x"),
      thing: new Thing(),
    }) as Record<string, unknown>;
    expect(out["n"]).toBe(1);
    expect(out["b"]).toBe(true);
    expect(out["nil"]).toBeNull();
    expect(out["u"]).toBeUndefined();
    expect(out["date"]).toBe("1970-01-01T00:00:00.000Z");
    expect(out["buffer"]).toBe("[object Buffer]");
    expect(out["thing"]).toBe("[object Thing]");
    expect(scrubValue(7)).toBe(7);
    expect(scrubValue(FAKE.ghp)).toBe("[redacted:github_token]");
  });
});
