import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";
import {
  ANALYSIS_STAGES,
  CHARS_PER_TOKEN,
  DEFAULT_ANALYSIS_TOKEN_LIMIT,
  estimateAnalysisTokens,
  FILE_CALL_OVERHEAD_TOKENS,
  STAGE_OVERHEAD_TOKENS,
} from "./estimate.js";
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
  it("counts the patch of every file sent to a model, plus a fixed overhead per call and stage", () => {
    const diff = [fileOf("src/a.ts", 3_000), fileOf("src/b.ts", 6_000)].join("\n");
    const parsed = parseUnifiedDiff(diff);
    if (!parsed.ok) throw new Error("fixture");
    const chars = parsed.files.reduce((sum, file) => sum + file.patch.length, 0);
    const estimate = estimateAnalysisTokens(diff);
    expect(estimate).toEqual({
      tokens: Math.ceil(chars / CHARS_PER_TOKEN) + 2 * FILE_CALL_OVERHEAD_TOKENS + FIXED,
      files: 2,
      sent: 2,
      noise: 0,
      skipped: 0,
      reused: 0,
    });
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
    expect(pushed.tokens).toBe(estimateAnalysisTokens(b)!.tokens);
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
