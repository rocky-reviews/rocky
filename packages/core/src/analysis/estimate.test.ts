import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";
import {
  ANALYSIS_STAGES,
  CHARS_PER_TOKEN,
  DEFAULT_ANALYSIS_TOKEN_LIMIT,
  estimateAnalysisTokens,
  FILE_CALL_OVERHEAD_TOKENS,
  GRAPH_ROLE_CALLS,
  MAP_STAGES,
  patchTokens,
  STAGE_OVERHEAD_TOKENS,
  UNIT_STAGES,
} from "./estimate.js";
import { GRAPH_MAX_INPUT_CHARS } from "./map-scope.js";
import { unitKey, type PreviousAnalysis } from "./units.js";

/** P4-6: the per-PR token estimate made before any model call (ADR 0017 §5). */

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

const addedFile = (path: string, lines: readonly string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");

/** A text file of about `chars` characters of patch, in lines of 80. */
const fileOf = (path: string, chars: number): string =>
  addedFile(
    path,
    Array.from({ length: Math.ceil(chars / 80) }, (_, i) => `const v${i} = ${"x".repeat(60)};`),
  );

const FIXED = ANALYSIS_STAGES * STAGE_OVERHEAD_TOKENS;

describe("estimateAnalysisTokens (P4-6)", () => {
  it("counts the patch of every file sent to a model, the mapped diffs once per graph-role call, plus a fixed overhead per call and stage", () => {
    const diff = [fileOf("src/a.ts", 3_000), fileOf("src/b.ts", 6_000)].join("\n");
    const parsed = parseUnifiedDiff(diff);
    if (!parsed.ok) throw new Error("fixture");
    const patch = parsed.files.reduce((sum, file) => sum + patchTokens(file.patch), 0);
    expect(patch).toBe(
      Math.ceil(parsed.files.reduce((sum, file) => sum + file.patch.length, 0) / CHARS_PER_TOKEN),
    );
    const estimate = estimateAnalysisTokens(diff);
    expect(ANALYSIS_STAGES).toBe(UNIT_STAGES + MAP_STAGES);
    expect(GRAPH_ROLE_CALLS).toBe(3);
    expect(estimate).toEqual({
      // Both files are logic: triage reads them once, the three graph-role calls again (H4-7).
      tokens: patch * (1 + GRAPH_ROLE_CALLS) + 2 * FILE_CALL_OVERHEAD_TOKENS + FIXED,
      files: 2,
      sent: 2,
      noise: 0,
      skipped: 0,
      reused: 0,
      mapped: 2,
    });
  });

  it("H4-7: a PR with nothing to map has no re-reads and no map stages; one over the map's budget has no re-reads either", () => {
    const docs = fileOf("docs/guide.md", 3_000);
    const parsed = parseUnifiedDiff(docs);
    if (!parsed.ok) throw new Error("fixture");
    expect(estimateAnalysisTokens(docs)).toEqual({
      tokens:
        patchTokens(parsed.files[0]!.patch) +
        FILE_CALL_OVERHEAD_TOKENS +
        UNIT_STAGES * STAGE_OVERHEAD_TOKENS,
      files: 1,
      sent: 1,
      noise: 0,
      skipped: 0,
      reused: 0,
      mapped: 0,
    });
    // Three logic files, each under the per-file cap, together over the map's input budget: the
    // graph role gets nothing, so nothing is read again and the map's stages are not charged.
    const big = ["a", "b", "c"].map((n) => fileOf(`src/${n}.ts`, 150_000)).join("\n");
    const over = parseUnifiedDiff(big);
    if (!over.ok) throw new Error("fixture");
    expect(over.files.reduce((sum, f) => sum + f.patch.length, 0)).toBeGreaterThan(
      GRAPH_MAX_INPUT_CHARS,
    );
    const estimate = estimateAnalysisTokens(big)!;
    expect(estimate.mapped).toBe(0);
    expect(estimate.tokens).toBe(
      over.files.reduce((sum, f) => sum + patchTokens(f.patch), 0) +
        3 * FILE_CALL_OVERHEAD_TOKENS +
        UNIT_STAGES * STAGE_OVERHEAD_TOKENS,
    );
    // A test-only PR is mapped from its tests, like the pipeline does.
    expect(estimateAnalysisTokens(fileOf("src/a.test.ts", 1_000))!.mapped).toBe(1);
  });

  it("is deterministic and leaves out noise (rules pre-triage), binary and too-large files", () => {
    const binary = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "Binary files /dev/null and b/logo.png differ",
    ].join("\n");
    const huge = fileOf("src/huge.ts", 260_000);
    const lock = fileOf("pnpm-lock.yaml", 90_000);
    const small = fileOf("src/small.ts", 800);
    const diff = [small, lock, binary, huge].join("\n");
    const only = estimateAnalysisTokens(small);
    const estimate = estimateAnalysisTokens(diff);
    expect(estimate).toEqual({ ...only, files: 4, noise: 1, skipped: 2 });
    expect(estimateAnalysisTokens(diff)).toEqual(estimate);
  });

  it("a 200k-token pull request is over the default limit", () => {
    const diff = Array.from({ length: 4 }, (_, i) => fileOf(`src/part${i}.ts`, 150_000)).join("\n");
    const estimate = estimateAnalysisTokens(diff);
    expect(estimate?.tokens).toBeGreaterThanOrEqual(200_000);
    expect(estimate!.tokens).toBeGreaterThan(DEFAULT_ANALYSIS_TOKEN_LIMIT);
    // A small pull request is far below it.
    expect(estimateAnalysisTokens(fileOf("src/a.ts", 2_000))!.tokens).toBeLessThan(
      DEFAULT_ANALYSIS_TOKEN_LIMIT / 5,
    );
  });

  it("review round 1, SF2: non-ASCII text counts one token per UTF-8 byte (CJK, emoji)", () => {
    const line = (text: string) => addedFile("src/t.ts", [text]);
    const base = estimateAnalysisTokens(line(""))!.tokens;
    // The file is logic, so its patch is read by triage and by the three graph-role calls.
    const reads = 1 + GRAPH_ROLE_CALLS;
    // 300 CJK characters: 3 UTF-8 bytes each, so 900 tokens on top of the ASCII part.
    expect(estimateAnalysisTokens(line("漢".repeat(300)))!.tokens).toBe(base + 900 * reads);
    // 100 emoji: 4 UTF-8 bytes each (a surrogate pair is one character, not two halves).
    expect(estimateAnalysisTokens(line("😀".repeat(100)))!.tokens).toBe(base + 400 * reads);
    // Accented Latin: 2 bytes each.
    expect(estimateAnalysisTokens(line("é".repeat(30)))!.tokens).toBe(base + 60 * reads);
  });

  it("review round 1, SF2: a 1 MiB CJK diff is far over the default limit", () => {
    // About 1 MiB of UTF-8 over 6 files, each under the per-file caps.
    const diff = Array.from({ length: 6 }, (_, f) =>
      addedFile(
        `src/i18n/part${f}.ts`,
        Array.from({ length: 1_000 }, () => `"${"漢字".repeat(29)}",`),
      ),
    ).join("\n");
    expect(new TextEncoder().encode(diff).byteLength).toBeGreaterThan(1_000_000);
    const estimate = estimateAnalysisTokens(diff)!;
    expect(estimate.sent).toBe(6);
    expect(estimate.tokens).toBeGreaterThan(DEFAULT_ANALYSIS_TOKEN_LIMIT * 5);
  });

  it("files the previous analysis will be reused for are not counted again (a push re-estimates)", () => {
    const a = fileOf("src/a.ts", 30_000);
    const b = fileOf("src/b.ts", 30_000);
    const parsed = parseUnifiedDiff([a, b].join("\n"));
    if (!parsed.ok) throw new Error("fixture");
    const salt = "salt";
    const previous = {
      document: {} as PreviousAnalysis["document"],
      units: [
        { path: "src/a.ts", key: unitKey(sha256Hex, salt, parsed.files[0]!), reviewMinutes: 1 },
      ],
    } satisfies PreviousAnalysis;
    const fresh = estimateAnalysisTokens([a, b].join("\n"))!;
    const pushed = estimateAnalysisTokens([a, b].join("\n"), {
      previous,
      sha256Hex,
      unitKeySalt: salt,
    })!;
    expect(pushed.reused).toBe(1);
    expect(pushed.sent).toBe(1);
    // The reused unit is not triaged again, but the map's calls still read it (H4-7).
    expect(pushed.mapped).toBe(2);
    expect(pushed.tokens).toBe(
      estimateAnalysisTokens(b)!.tokens + GRAPH_ROLE_CALLS * patchTokens(parsed.files[0]!.patch),
    );
    expect(pushed.tokens).toBeLessThan(fresh.tokens);
    // Another salt (a model change) reuses nothing.
    expect(
      estimateAnalysisTokens([a, b].join("\n"), { previous, sha256Hex, unitKeySalt: "other" })!
        .reused,
    ).toBe(0);
  });

  it("returns undefined for a diff the pipeline will refuse without a model call", () => {
    expect(estimateAnalysisTokens("not a diff")).toBeUndefined();
    expect(estimateAnalysisTokens("")).toBeUndefined();
  });
});
