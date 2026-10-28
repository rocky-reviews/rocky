import { describe, expect, it } from "vitest";
import { languageFor, MAX_HIGHLIGHT_CHARS, type Token, tokenize } from "./tokenize.js";

const kinds = (tokens: readonly Token[]) => tokens.map((t) => [t.kind, t.text]);
const joined = (tokens: readonly Token[]) => tokens.map((t) => t.text).join("");

describe("languageFor", () => {
  it("maps file extensions to the tokenizer's languages", () => {
    expect(languageFor("src/auth/invitations.ts")).toBe("js");
    expect(languageFor("web/src/pages/InvitePage.tsx")).toBe("js");
    expect(languageFor("scripts/a.mjs")).toBe("js");
    expect(languageFor("package.json")).toBe("js");
    expect(languageFor("db/migrations/20261020_add_invitations.sql")).toBe("sql");
    expect(languageFor("pnpm-lock.yaml")).toBe("hash");
    expect(languageFor("deploy.sh")).toBe("hash");
    expect(languageFor("README.md")).toBe("plain");
    expect(languageFor("Makefile")).toBe("plain");
  });

  it("ignores case and only looks at the last extension", () => {
    expect(languageFor("A.SQL")).toBe("sql");
    expect(languageFor("x.ts.md")).toBe("plain");
    expect(languageFor(".ts")).toBe("js");
  });
});

describe("tokenize (js)", () => {
  it("finds keywords, strings, numbers and comments like the POC", () => {
    expect(kinds(tokenize('import { db } from "../db";', "js"))).toEqual([
      ["kw", "import"],
      ["plain", " { db } "],
      ["kw", "from"],
      ["plain", " "],
      ["str", '"../db"'],
      ["plain", ";"],
    ]);
    expect(kinds(tokenize("const TTL = 7 * 24; // a week", "js"))).toEqual([
      ["kw", "const"],
      ["plain", " TTL = "],
      ["num", "7"],
      ["plain", " * "],
      ["num", "24"],
      ["plain", "; "],
      ["com", "// a week"],
    ]);
  });

  it("does not split identifiers that contain keywords or digits", () => {
    expect(kinds(tokenize("constant module2 imports", "js"))).toEqual([
      ["plain", "constant module2 imports"],
    ]);
  });

  it("reads escapes inside strings and all three quote kinds", () => {
    expect(kinds(tokenize(String.raw`a = 'it\'s' + "\"q\"" + ` + "`t ${x}`", "js"))).toEqual([
      ["plain", "a = "],
      ["str", String.raw`'it\'s'`],
      ["plain", " + "],
      ["str", String.raw`"\"q\""`],
      ["plain", " + "],
      ["str", "`t ${x}`"],
    ]);
  });

  it("runs an unterminated string or block comment to the end of the line", () => {
    expect(kinds(tokenize('x = "open', "js"))).toEqual([
      ["plain", "x = "],
      ["str", '"open'],
    ]);
    expect(kinds(tokenize("a /* b */ c /* d", "js"))).toEqual([
      ["plain", "a "],
      ["com", "/* b */"],
      ["plain", " c "],
      ["com", "/* d"],
    ]);
  });

  it("reads decimal, hex and separated numbers", () => {
    expect(kinds(tokenize("f(1_000, 0xff, 3.5)", "js"))).toEqual([
      ["plain", "f("],
      ["num", "1_000"],
      ["plain", ", "],
      ["num", "0xff"],
      ["plain", ", "],
      ["num", "3.5"],
      ["plain", ")"],
    ]);
  });

  it("keeps markup in code as plain text tokens", () => {
    const line = '<img src=x onerror="alert(1)"> </script>';
    expect(joined(tokenize(line, "js"))).toBe(line);
  });
});

describe("tokenize (sql and hash)", () => {
  it("reads SQL keywords in any case, -- comments and '' escapes", () => {
    expect(kinds(tokenize("create TABLE t (n int default 'it''s'); -- note", "sql"))).toEqual([
      ["kw", "create"],
      ["plain", " "],
      ["kw", "TABLE"],
      ["plain", " t (n "],
      ["kw", "int"],
      ["plain", " "],
      ["kw", "default"],
      ["plain", " "],
      ["str", "'it''s'"],
      ["plain", "); "],
      ["com", "-- note"],
    ]);
  });

  it("reads # comments in hash languages, but not inside strings", () => {
    expect(kinds(tokenize('key: "a # b" # real', "hash"))).toEqual([
      ["plain", "key: "],
      ["str", '"a # b"'],
      ["plain", " "],
      ["com", "# real"],
    ]);
  });

  it("returns plain text for unknown languages", () => {
    expect(kinds(tokenize('const "x" 1', "plain"))).toEqual([["plain", 'const "x" 1']]);
  });
});

describe("tokenize invariants", () => {
  const samples = [
    "",
    " ",
    '"',
    "'",
    "`",
    "/",
    "/*",
    "*/",
    "--",
    "#",
    "\\",
    '"\\',
    "0x",
    "1.",
    ".5",
    "a.b.c",
    "‮evil‬",
    "é 日本 🎉",
    'x = "a" /* b */ // c',
  ];

  it("never loses or reorders text, in every language", () => {
    for (const language of ["js", "sql", "hash", "plain"] as const) {
      for (const sample of samples) {
        const tokens = tokenize(sample, language);
        expect(joined(tokens), `${language}: ${JSON.stringify(sample)}`).toBe(sample);
        expect(tokens.every((t) => t.text.length > 0)).toBe(true);
      }
    }
  });

  it("merges neighbouring plain text into one token", () => {
    const tokens = tokenize("a + b - c", "js");
    expect(tokens).toHaveLength(1);
  });

  it("stops highlighting very long lines but keeps all of their text", () => {
    const long = `const a = "${"x".repeat(MAX_HIGHLIGHT_CHARS)}"; const b = 1;`;
    const tokens = tokenize(long, "js");
    expect(joined(tokens)).toBe(long);
    expect(tokens.at(-1)?.kind).toBe("plain");
    expect(tokens.at(-1)?.text).toContain("const b = 1;");
  });

  it("is linear on hostile input", () => {
    const hostile = '"\\'.repeat(50_000) + "/*".repeat(50_000);
    const start = performance.now();
    tokenize(hostile, "js");
    expect(performance.now() - start).toBeLessThan(500);
  });
});
