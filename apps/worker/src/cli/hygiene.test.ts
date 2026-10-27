import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P4-8 review round 1: no invisible format, bidi or separator characters in the docs or the CLI
 * source. Escapes (`\u202e`) are fine; the characters themselves can make text read differently
 * from what it is, in an editor, a diff or a terminal.
 */

const ROOT = new URL("../../../../", import.meta.url).pathname;
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]|(?![\n\t\r])\p{Cc}/u;

const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, ext);
    return ext.test(entry.name) ? [path] : [];
  });

describe("docs and CLI source", () => {
  it("contain no literal format, bidi or control characters", () => {
    const checked = [
      ...files(join(ROOT, "docs"), /\.md$/),
      ...files(join(ROOT, "apps/worker/src/cli"), /\.ts$/),
      join(ROOT, "apps/worker/src/rocky.ts"),
    ];
    expect(checked.length).toBeGreaterThan(10);
    const found = checked.flatMap((path) => {
      const lines = readFileSync(path, "utf8").split("\n");
      return lines.flatMap((line, index) =>
        INVISIBLE.test(line) ? [`${relative(ROOT, path)}:${index + 1}`] : [],
      );
    });
    expect(found).toEqual([]);
  });
});
