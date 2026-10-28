import { parseUnifiedDiff } from "@rocky-reviews/core/diff";
import { pr847Diff } from "@rocky-reviews/evals/pr-847/diff";
import { describe, expect, it } from "vitest";
import { type DiffRow, diffItems, fileRows } from "./diff-model.js";

const MODIFIED = [
  "diff --git a/src/api/index.ts b/src/api/index.ts",
  "index 1111111..2222222 100644",
  "--- a/src/api/index.ts",
  "+++ b/src/api/index.ts",
  '@@ -3,3 +3,4 @@ import express from "express";',
  ' import { orgs } from "./routes/orgs";',
  '+import { invitations } from "./routes/invitations";',
  ' import { health } from "./routes/health";',
  "-import { users } from './routes/users';",
  '+import { users } from "./routes/users";',
  "@@ -18,2 +19,2 @@",
  " app.use(health);",
  "-export { app };",
  "+export { app, invitations };",
  "\\ No newline at end of file",
].join("\n");

const patchOf = (diff: string, path: string): string => {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) throw new Error(parsed.code);
  const file = parsed.files.find((f) => f.path === path);
  if (!file) throw new Error(`no ${path}`);
  return file.patch;
};

const lines = (rows: readonly DiffRow[]) =>
  rows.flatMap((r) => (r.kind === "line" ? [[r.type, r.oldNo, r.newNo, r.text]] : []));

describe("fileRows (the hunk model)", () => {
  const rows = fileRows(patchOf(MODIFIED + "\n", "src/api/index.ts"));

  it("starts each hunk with its header, section heading included", () => {
    const headers = rows.filter((r) => r.kind === "hunk");
    expect(headers).toEqual([
      { kind: "hunk", header: '@@ -3,3 +3,4 @@ import express from "express";' },
      { kind: "hunk", header: "@@ -18,2 +19,2 @@" },
    ]);
    expect(rows[0]?.kind).toBe("hunk");
  });

  it("numbers old and new lines from the hunk header", () => {
    expect(lines(rows)).toEqual([
      ["ctx", 3, 3, 'import { orgs } from "./routes/orgs";'],
      ["add", null, 4, 'import { invitations } from "./routes/invitations";'],
      ["ctx", 4, 5, 'import { health } from "./routes/health";'],
      ["del", 5, null, "import { users } from './routes/users';"],
      ["add", null, 6, 'import { users } from "./routes/users";'],
      ["ctx", 18, 19, "app.use(health);"],
      ["del", 19, null, "export { app };"],
      ["add", null, 20, "export { app, invitations };"],
    ]);
  });

  it("keeps git's no-newline marker as a note", () => {
    expect(rows.at(-1)).toEqual({ kind: "note", text: "No newline at end of file" });
  });

  it("reads the pr-847 diff: an added file is one hunk of added lines", () => {
    const auth = fileRows(patchOf(pr847Diff(), "src/auth/invitations.ts"));
    expect(auth[0]).toEqual({ kind: "hunk", header: "@@ -0,0 +1,33 @@" });
    const body = lines(auth);
    expect(body).toHaveLength(33);
    expect(body.every(([type, oldNo]) => type === "add" && oldNo === null)).toBe(true);
    expect(body[9]).toEqual(["add", null, 10, '  const token = randomBytes(32).toString("hex");']);
  });

  it("treats an empty line inside a hunk as an empty context line", () => {
    const patch = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", "", "-x", "+y"];
    expect(lines(fileRows(patch.join("\n")))).toEqual([
      ["ctx", 1, 1, ""],
      ["del", 2, null, "x"],
      ["add", null, 2, "y"],
    ]);
  });

  it("has no rows for a file without hunks (binary, mode change)", () => {
    expect(fileRows("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ")).toEqual(
      [],
    );
  });
});

describe("diffItems", () => {
  const rows = fileRows(patchOf(MODIFIED + "\n", "src/api/index.ts"));
  const none = { hot: new Map(), flags: new Map() };

  it("gives every row a stable key and no inline blocks when there is nothing to show", () => {
    const items = diffItems(rows, none, [], null);
    expect(items).toHaveLength(rows.length);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(items.every((i) => i.kind !== "inline")).toBe(true);
  });

  it("puts flags, own comments and the composer in one block under their new line", () => {
    const flag = { range: { start: 4, end: 4 }, kind: "look" as const, text: "here" };
    const annotations = { hot: new Map([[4, "look" as const]]), flags: new Map([[4, [flag]]]) };
    const comment = { id: "c1", path: "src/api/index.ts", line: 6, body: "mine" };
    const items = diffItems(rows, annotations, [comment], 20);
    const inline = items.filter((i) => i.kind === "inline");
    expect(inline.map((i) => [i.line, i.flags.length, i.comments.length, i.composing])).toEqual([
      [4, 1, 0, false],
      [6, 0, 1, false],
      [20, 0, 0, true],
    ]);
    // Each block follows the line it belongs to.
    const at = (key: string) => items.findIndex((i) => i.key === key);
    for (const block of inline) {
      const line = items[at(block.key) - 1];
      expect(line?.kind === "line" && line.row.newNo).toBe(block.line);
    }
    const hot = items.find((i) => i.kind === "line" && i.row.newNo === 4);
    expect(hot?.kind === "line" && hot.hot).toBe("look");
  });

  it("keeps line keys when a block is inserted, so measured heights stay with their rows", () => {
    const before = diffItems(rows, none, [], null).map((i) => i.key);
    const after = diffItems(rows, none, [], 4).map((i) => i.key);
    expect(after.filter((k) => !k.startsWith("i"))).toEqual(before);
  });
});
