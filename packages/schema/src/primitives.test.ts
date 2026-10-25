import { describe, expect, it } from "vitest";
import { MAX_ID_LENGTH, MAX_PATH_LENGTH, MAX_RANGE_LINES } from "./limits.js";
import { codeLine, Id, line, LineRange, prose, RepositoryPath } from "./primitives.js";

describe("Id", () => {
  it.each(["a", "F1", "node-1", "a.b:c/d_e", "0abc"])("accepts %j", (id) => {
    expect(Id.safeParse(id).success).toBe(true);
  });

  it.each(["", "-a", ".a", "/a", "a b", "a\n", "ä", "a\u0000", "<svg>", "a#b", "a?b"])(
    "rejects %j",
    (id) => {
      expect(Id.safeParse(id).success).toBe(false);
    },
  );

  it("caps the length", () => {
    expect(Id.safeParse("a".repeat(MAX_ID_LENGTH)).success).toBe(true);
    expect(Id.safeParse("a".repeat(MAX_ID_LENGTH + 1)).success).toBe(false);
  });
});

describe("RepositoryPath", () => {
  it.each([
    "README.md",
    "src/auth/invitations.ts",
    ".github/workflows/ci.yml",
    "a/.hidden",
    "a/..b/c",
    "a/b..",
    "with space/ok.txt",
    "ünïcode/ok.ts",
  ])("accepts %j", (path) => {
    expect(RepositoryPath.safeParse(path).success).toBe(true);
  });

  it.each([
    "",
    "/etc/passwd",
    "//server/share",
    "C:/x",
    "c:x",
    "a\\b",
    "..",
    "../a",
    "a/../b",
    "a/..",
    ".",
    "./a",
    "a/./b",
    "a/.",
    "a//b",
    "a/",
    "a\u0000b",
    "a\nb",
    "a\tb",
    "a\u007fb",
  ])("rejects %j", (path) => {
    expect(RepositoryPath.safeParse(path).success).toBe(false);
  });

  it("caps the length", () => {
    expect(RepositoryPath.safeParse("a".repeat(MAX_PATH_LENGTH)).success).toBe(true);
    expect(RepositoryPath.safeParse("a".repeat(MAX_PATH_LENGTH + 1)).success).toBe(false);
  });
});

describe("text fields", () => {
  const Line = line(10);
  const Prose = prose(10);
  const Code = codeLine(10);

  it("single-line text rejects every control character", () => {
    expect(Line.safeParse("hello").success).toBe(true);
    for (const bad of ["a\nb", "a\tb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb", ""])
      expect(Line.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("prose allows newline and tab only", () => {
    expect(Prose.safeParse("a\nb\tc").success).toBe(true);
    for (const bad of ["a\rb", "a\u0000b", "a\u000bb", "a\u000cb", "a\u001bb", "a\u007fb", ""])
      expect(Prose.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("code lines may be empty and contain tabs but never newlines", () => {
    expect(Code.safeParse("").success).toBe(true);
    expect(Code.safeParse("\tx = 1;").success).toBe(true);
    for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\u007fb"])
      expect(Code.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("enforces the maximum length", () => {
    expect(Line.safeParse("a".repeat(11)).success).toBe(false);
    expect(Prose.safeParse("a".repeat(11)).success).toBe(false);
    expect(Code.safeParse("a".repeat(11)).success).toBe(false);
  });
});

describe("LineRange", () => {
  it("accepts a single line and an ordered range", () => {
    expect(LineRange.safeParse({ start: 1, end: 1 }).success).toBe(true);
    expect(LineRange.safeParse({ start: 3, end: 3 + MAX_RANGE_LINES - 1 }).success).toBe(true);
  });

  it("rejects reversed, zero, fractional, oversized and extended ranges", () => {
    expect(LineRange.safeParse({ start: 5, end: 4 }).success).toBe(false);
    expect(LineRange.safeParse({ start: 0, end: 1 }).success).toBe(false);
    expect(LineRange.safeParse({ start: 1.5, end: 2 }).success).toBe(false);
    expect(LineRange.safeParse({ start: 1, end: 1 + MAX_RANGE_LINES }).success).toBe(false);
    expect(LineRange.safeParse({ start: 1, end: 1, side: "old" }).success).toBe(false);
  });
});
