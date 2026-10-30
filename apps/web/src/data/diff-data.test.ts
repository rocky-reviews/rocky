import { describe, expect, it } from "vitest";
import { DiffDataError, MAX_DIFF_CHARS, parseDiffData } from "./diff-data.js";
import {
  createFixtureDiffSource,
  NEWER_PUSH_SHA,
  newerPushFromSearch,
} from "./diff-fixture-source.js";
import { DEFAULT_PULL } from "./fixture-source.js";
import { LARGE_DIFF_LINES, LARGE_PULL } from "./large-fixture.js";

const SHA = "9b4e1d7a3c5f2e8b6d0a4c7e1f3b5d9a2c6e8f4b";
const ONE_FILE = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("parseDiffData", () => {
  it("accepts a head sha and a unified diff, keyed by path", () => {
    const data = parseDiffData({ headSha: SHA, diff: ONE_FILE });
    expect(data.headSha).toBe(SHA);
    expect([...data.files.keys()]).toEqual(["a.ts"]);
    expect(data.files.get("a.ts")?.additions).toBe(1);
  });

  it("refuses a missing or malformed head sha", () => {
    for (const headSha of [undefined, null, "", "xyz", SHA.toUpperCase(), `${SHA}0`, 42]) {
      expect(() => parseDiffData({ headSha, diff: ONE_FILE })).toThrow(DiffDataError);
    }
  });

  it("refuses a diff that is not a string or is too large", () => {
    for (const diff of [undefined, null, 1, ["x"], { a: 1 }]) {
      expect(() => parseDiffData({ headSha: SHA, diff })).toThrow("invalid diff");
    }
    expect(() => parseDiffData({ headSha: SHA, diff: "x".repeat(MAX_DIFF_CHARS + 1) })).toThrow(
      "diff too large",
    );
  });

  it("refuses a diff the strict reader refuses, naming only the code", () => {
    const hostile = "diff --git a/<script> b/<script>\n@@ garbage @@\n+<img onerror=x>\n";
    try {
      parseDiffData({ headSha: SHA, diff: hostile });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DiffDataError);
      expect((error as Error).message).toMatch(/^unreadable diff: diff_[a-z_]+$/);
      expect((error as Error).message).not.toContain("<");
    }
  });

  it("accepts an empty diff (a PR with no file changes)", () => {
    expect(parseDiffData({ headSha: SHA, diff: "" }).files.size).toBe(0);
  });
});

describe("fixture diff source", () => {
  it("serves pr-847 at the analysis's head", async () => {
    const data = parseDiffData(await createFixtureDiffSource().load(DEFAULT_PULL));
    expect(data.headSha).toBe(SHA);
    expect(data.files.size).toBe(9);
    expect(data.files.get("src/auth/invitations.ts")?.additions).toBe(33);
  });

  it("serves pr-847 as a later push with ?diff=newer-push (P6-5)", async () => {
    expect(newerPushFromSearch("?diff=newer-push")).toBe(true);
    expect(newerPushFromSearch("?pr=847")).toBe(false);
    const data = parseDiffData(
      await createFixtureDiffSource({ newerPush: true }).load(DEFAULT_PULL),
    );
    expect(data.headSha).toBe(NEWER_PUSH_SHA);
    expect(data.files.size).toBe(9);
  });

  it("serves the generated large diff: one file with 5,000 diff lines", async () => {
    const data = parseDiffData(await createFixtureDiffSource().load(LARGE_PULL));
    const [file] = [...data.files.values()];
    expect(data.files.size).toBe(1);
    const body = file!.patch
      .split("\n")
      .filter((l) => /^[ +-]/.test(l) && !/^(---|\+\+\+) /.test(l));
    expect(body).toHaveLength(LARGE_DIFF_LINES);
    expect(LARGE_DIFF_LINES).toBe(5000);
  });

  it("refuses an unknown pull request", async () => {
    await expect(
      createFixtureDiffSource().load({ owner: "acme", repo: "nope", number: 1 }),
    ).rejects.toThrow(DiffDataError);
  });
});
