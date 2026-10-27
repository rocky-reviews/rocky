import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_FILE_PATCH_LINES, parseUnifiedDiff } from "./diff.js";

/**
 * P4-3: the revision's diff is the source of the known facts (paths, statuses, line counts, hunk
 * ranges; ADR 0004 §3). It is untrusted PR content, so the parser must never throw, never guess
 * and never let content inside a hunk pass for a header.
 */

const added = (path: string, lines: readonly string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");

const ok = (text: string) => {
  const result = parseUnifiedDiff(text);
  if (!result.ok) throw new Error(`expected a parse, got ${result.code}`);
  return result.files;
};

describe("parseUnifiedDiff", () => {
  it("reads an added file: status, counts, one hunk, full new-side content", () => {
    const [file] = ok(added("src/a.ts", ["one", "two", ""]));
    expect(file).toMatchObject({
      path: "src/a.ts",
      status: "added",
      additions: 3,
      deletions: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }],
      binary: false,
      newFileLines: ["one", "two", ""],
    });
    expect(file!.patch.startsWith("diff --git a/src/a.ts b/src/a.ts")).toBe(true);
  });

  it("reads a modified file with two hunks and no full content", () => {
    const text = [
      "diff --git a/src/api/index.ts b/src/api/index.ts",
      "index 2222222..3333333 100644",
      "--- a/src/api/index.ts",
      "+++ b/src/api/index.ts",
      "@@ -3,3 +3,4 @@ import",
      " a",
      "+b",
      " c",
      " d",
      "@@ -18,4 +19,5 @@",
      " e",
      "-f",
      "+g",
      "+h",
      " i",
      "\\ No newline at end of file",
      " j",
    ].join("\n");
    const [file] = ok(text);
    expect(file).toMatchObject({
      path: "src/api/index.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      hunks: [
        { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4 },
        { oldStart: 18, oldLines: 4, newStart: 19, newLines: 5 },
      ],
    });
    expect(file!.newFileLines).toBeUndefined();
  });

  it("reads removed, renamed (with and without content), binary and mode-only files", () => {
    const text = [
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-x",
      "-y",
      "diff --git a/from.ts b/to.ts",
      "similarity index 100%",
      "rename from from.ts",
      "rename to to.ts",
      "diff --git a/a b.ts b/c d.ts",
      "similarity index 90%",
      "rename from a b.ts",
      "rename to c d.ts",
      "index 1..2 100644",
      "--- a/a b.ts",
      "+++ b/c d.ts",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..1234567",
      "Binary files /dev/null and b/logo.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const files = ok(text);
    expect(files.map((f) => [f.path, f.status, f.previousPath, f.binary, f.hunks.length])).toEqual([
      ["old.ts", "removed", undefined, false, 1],
      ["to.ts", "renamed", "from.ts", false, 0],
      ["c d.ts", "renamed", "a b.ts", false, 1],
      ["logo.png", "added", undefined, true, 0],
      ["run.sh", "modified", undefined, false, 0],
    ]);
    expect(files[0]!.hunks[0]).toEqual({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
    expect(files[2]!.hunks[0]).toEqual({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });

  it("decodes git's quoted paths", () => {
    const text = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/caf\\303\\251.ts"',
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n");
    expect(ok(text)[0]!.path).toBe("café.ts");
  });

  it("unquotes git's C-quoted rename and copy paths (review round 1, Fix C)", () => {
    const rename = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251 v2.ts"',
      "similarity index 100%",
      'rename from "caf\\303\\251.ts"',
      'rename to "caf\\303\\251 v2.ts"',
    ].join("\n");
    expect(ok(rename).map((f) => [f.path, f.previousPath, f.status])).toEqual([
      ["café v2.ts", "café.ts", "renamed"],
    ]);
    const copy = [
      'diff --git "a/caf\\303\\251.ts" "b/t\\303\\251.ts"',
      "similarity index 100%",
      'copy from "caf\\303\\251.ts"',
      'copy to "t\\303\\251.ts"',
    ].join("\n");
    expect(ok(copy).map((f) => [f.path, f.status])).toEqual([["té.ts", "added"]]);
  });

  it("an empty diff has no files", () => {
    expect(ok("")).toEqual([]);
  });

  it("content that looks like a header inside a hunk stays content", () => {
    const lines = ["diff --git a/evil.ts b/evil.ts", "+++ b/evil.ts", "@@ -0,0 +1,99 @@"];
    const files = ok(added("src/a.ts", lines));
    expect(files).toHaveLength(1);
    expect(files[0]!.newFileLines).toEqual(lines);
  });

  it("CRLF line endings are kept as content, not stripped", () => {
    const [file] = ok(added("a.txt", ["one\r", "two\r"]));
    expect(file!.newFileLines).toEqual(["one\r", "two\r"]);
  });

  describe("fails closed", () => {
    const cases: [string, string, string][] = [
      ["text before the first header", "hello\n" + added("a.ts", ["x"]), "diff_unparseable"],
      [
        "a hunk shorter than its header",
        added("a.ts", ["x"]).replace("+1,1", "+1,2"),
        "diff_unparseable",
      ],
      [
        "a hunk longer than its header",
        added("a.ts", ["x", "y"]).replace("+1,2", "+1,1"),
        "diff_unparseable",
      ],
      [
        "a malformed hunk header",
        added("a.ts", ["x"]).replace("@@ -0,0", "@@ -z"),
        "diff_unparseable",
      ],
      ["a path the document cannot hold", added("a/../b.ts", ["x"]), "diff_unsupported_path"],
      ["a .git path", added(".git/config", ["x"]), "diff_unsupported_path"],
      [
        "the same path twice",
        added("a.ts", ["x"]) + "\n" + added("a.ts", ["y"]),
        "diff_unparseable",
      ],
      [
        "hunks out of order",
        [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -10 +10 @@",
          "-a",
          "+b",
          "@@ -1 +1 @@",
          "-c",
          "+d",
        ].join("\n"),
        "diff_unparseable",
      ],
      [
        "a line number past the document's limit",
        added("a.ts", ["x"]).replace("+1,1", "+99999999,1"),
        "diff_unparseable",
      ],
      [
        "a bad quoted path",
        'diff --git "a/x\\q" "b/x\\q"\n--- /dev/null\n+++ "b/x\\q"\n@@ -0,0 +1 @@\n+x',
        "diff_unsupported_path",
      ],
      ["a header with no paths", "diff --git\n", "diff_unparseable"],
      // Review round 1, Fix D: the header, ---/+++ and rename/copy paths must agree.
      [
        "a +++ path that disagrees with the header",
        [
          "diff --git a/src/auth/x.ts b/src/auth/x.ts",
          "--- a/src/auth/x.ts",
          "+++ b/docs/readme.md",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
        "diff_unparseable",
      ],
      [
        "a --- path that disagrees with the header",
        [
          "diff --git a/src/auth/x.ts b/src/auth/x.ts",
          "--- a/docs/readme.md",
          "+++ b/src/auth/x.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
        "diff_unparseable",
      ],
      [
        "a rename that disagrees with the header",
        ["diff --git a/a.ts b/b.ts", "rename from a.ts", "rename to c.ts"].join("\n"),
        "diff_unparseable",
      ],
      [
        "a rename that disagrees with +++",
        [
          "diff --git a/a b.ts b/c d.ts",
          "rename from a b.ts",
          "rename to c d.ts",
          "--- a/a b.ts",
          "+++ b/elsewhere.ts",
          "@@ -1 +1 @@",
          "-1",
          "+2",
        ].join("\n"),
        "diff_unparseable",
      ],
      [
        "a --- line with no +++ line",
        ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
        "diff_unparseable",
      ],
      [
        "a new file whose --- side is not /dev/null",
        [
          "diff --git a/a.ts b/a.ts",
          "new file mode 100644",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -0,0 +1 @@",
          "+x",
        ].join("\n"),
        "diff_unparseable",
      ],
      // Review round 2, N1: the remaining guards.
      [
        "a new file that is also renamed",
        [
          "diff --git a/a.ts b/b.ts",
          "new file mode 100644",
          "rename from a.ts",
          "rename to b.ts",
        ].join("\n"),
        "diff_unparseable",
      ],
      [
        "a second --- line",
        [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
        "diff_unparseable",
      ],
      [
        "a second +++ line",
        [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
        "diff_unparseable",
      ],
      [
        "a deleted file whose +++ side is not /dev/null",
        [
          "diff --git a/a.ts b/a.ts",
          "deleted file mode 100644",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +0,0 @@",
          "-x",
        ].join("\n"),
        "diff_unparseable",
      ],
    ];
    it.each(cases)("%s", (_name, text, code) => {
      const result = parseUnifiedDiff(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(code);
    });

    it("too many files", () => {
      const text = Array.from({ length: 1001 }, (_, i) => added(`f${i}.ts`, ["x"])).join("\n");
      const result = parseUnifiedDiff(text);
      expect(result).toEqual({ ok: false, code: "too_many_files" });
    });

    it("a file whose patch is larger than the cap is flagged, not dropped", () => {
      const lines = Array.from({ length: MAX_FILE_PATCH_LINES + 1 }, () => "x");
      const [file] = ok(added("big.ts", lines));
      expect(file!.tooLarge).toBe(true);
      expect(file!.additions).toBe(MAX_FILE_PATCH_LINES + 1);
    });
  });

  it("never throws on arbitrary input (fuzz)", () => {
    const pieces = fc.constantFrom(
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "--- /dev/null",
      "+++ /dev/null",
      "new file mode 100644",
      "deleted file mode 100644",
      "rename from x",
      "rename to y",
      "@@ -1,2 +1,3 @@",
      "@@ -0,0 +1 @@",
      "+x",
      "-y",
      " z",
      "\\ No newline at end of file",
      "Binary files a and b differ",
      "",
    );
    fc.assert(
      fc.property(fc.array(fc.oneof(pieces, fc.string()), { maxLength: 40 }), (lines) => {
        const result = parseUnifiedDiff(lines.join("\n"));
        expect(typeof result.ok).toBe("boolean");
      }),
      { numRuns: 500, seed: 4243 },
    );
  });
});
