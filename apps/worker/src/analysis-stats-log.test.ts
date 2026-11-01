import { createHash } from "node:crypto";
import { analyzePullRequest, type AnalysisStats } from "@rocky-reviews/core";
import { scriptedRoles } from "@rocky-reviews/core/testing";
import { createLogger, isSensitiveKey } from "@rocky-reviews/log";
import { describe, expect, it } from "vitest";

/**
 * H4-7 (review round 1, SF1): the worker spreads `AnalysisStats` into its "analysis ran" line.
 * Every key must survive the log redactor, so the per-stage token counts and the sections' fixed
 * codes are readable; the redactor itself is not weakened (it still catches `tokens`, `output`).
 */

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,1 @@",
  "+export const a = 1;",
].join("\n");

const triage = {
  score: 30,
  level: "normal",
  reviewMinutes: 1,
  reason: "Small.",
  whatChanged: "Adds a.",
  whyThisLevel: "Little risk.",
  flags: [],
};

const keysOf = (value: unknown, path = ""): string[] =>
  typeof value === "object" && value !== null
    ? Object.entries(value).flatMap(([key, child]) => [
        `${path}${key}`,
        ...keysOf(child, `${path}${key}.`),
      ])
    : [];

describe("analysis stats in the worker log", () => {
  it("every stats key survives the redactor, and the logged counts are numbers", async () => {
    const llm = scriptedRoles(
      (call) =>
        call.role === "triage"
          ? { value: triage }
          : call.role === "review"
            ? {
                value: {
                  summary: "Adds a.",
                  verdict: { level: "low", reason: "Small." },
                  reviewPath: [{ path: "src/a.ts", why: "Only file." }],
                  checkedOk: [],
                },
              }
            : { status: "refused" },
      {
        usage: () => ({
          inputTokens: 123,
          outputTokens: 45,
          cacheReadInputTokens: 6,
          cacheWrite5mInputTokens: 7,
          cacheWrite1hInputTokens: 8,
        }),
      },
    );
    const outcome = await analyzePullRequest(
      {
        repo: { owner: "acme", name: "api" },
        pullRequest: { number: 1, title: "T" },
        base: { sha: "a".repeat(40) },
        head: { sha: "b".repeat(40) },
        diff,
        diffTruncated: false,
      },
      {
        llm: llm.roles,
        clock: { now: () => new Date("2026-11-01T00:00:00Z") },
        sha256Hex: (text) => createHash("sha256").update(text).digest("hex"),
        generator: { name: "rocky" },
      },
    );
    expect(outcome.status).toBe("done");
    const stats: AnalysisStats = outcome.stats;
    expect(stats.usageByStage.graph).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      cacheRead: 6,
      cacheWrite: 15,
    });
    for (const key of keysOf(stats)) {
      const leaf = key.split(".").at(-1)!;
      expect(isSensitiveKey(leaf), key).toBe(false);
    }
    // The redactor is unchanged: the names H4-7 avoided are still caught.
    expect(isSensitiveKey("tokens")).toBe(true);
    expect(isSensitiveKey("output")).toBe(true);

    const lines: string[] = [];
    const log = createLogger("stats-test", {
      destination: { write: (line: string) => void lines.push(line) },
    });
    log.info({ analysisId: "x", ...stats }, "analysis ran");
    const ran = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(ran["usageByStage"]).toEqual(stats.usageByStage);
    expect(ran["calls"]).toEqual(stats.calls);
    expect(ran).toMatchObject({ graph: "unavailable", flows: "skipped", walkthrough: "skipped" });
    expect(lines[0]).not.toContain("redacted");
  });
});
