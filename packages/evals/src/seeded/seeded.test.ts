import { parseUnifiedDiff } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { SEEDED_PRS } from "./index.js";

describe("the seeded PRs (P4-7)", () => {
  it("are 4 to 6 PRs with at least 20 seeded findings, unique ids and a provenance note", () => {
    expect(SEEDED_PRS.length).toBeGreaterThanOrEqual(4);
    expect(SEEDED_PRS.length).toBeLessThanOrEqual(6);
    expect(SEEDED_PRS.map((pr) => pr.id)).toContain("pr-847");
    expect(SEEDED_PRS.map((pr) => pr.id)).toContain("pr-912");
    expect(SEEDED_PRS.reduce((n, pr) => n + pr.expected.length, 0)).toBeGreaterThanOrEqual(20);
    expect(new Set(SEEDED_PRS.map((pr) => pr.id)).size).toBe(SEEDED_PRS.length);
    for (const pr of SEEDED_PRS) {
      expect(pr.id).toBe(`pr-${pr.number}`);
      expect(pr.provenance).toMatch(/^Synthetic, written for Rocky/);
      const ids = [...pr.expected, ...pr.tolerated].map((f) => f.id);
      expect(new Set(ids).size, pr.id).toBe(ids.length);
    }
  });

  describe.each(SEEDED_PRS)("$id", (pr) => {
    it("parses, and every seeded finding sits inside a hunk of a file in the diff", () => {
      const parsed = parseUnifiedDiff(pr.diff());
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const files = new Map(parsed.files.map((file) => [file.path, file.hunks] as const));
      for (const finding of [...pr.expected, ...pr.tolerated]) {
        const hunks = files.get(finding.path);
        expect(hunks, `${pr.id} ${finding.id}`).toBeDefined();
        expect(
          hunks!.some(
            (h) =>
              finding.range.start >= h.newStart && finding.range.end <= h.newStart + h.newLines - 1,
          ),
          `${pr.id} ${finding.id}`,
        ).toBe(true);
      }
    });

    it("every seeded finding names its issue with keywords", () => {
      for (const finding of pr.expected) {
        expect(finding.keywords?.length, `${pr.id} ${finding.id}`).toBeGreaterThan(0);
        // The seeded title itself names the issue, so the keyword rule is satisfiable.
        const title = finding.title.toLowerCase();
        expect(
          finding.keywords!.some((k) => title.includes(k.toLowerCase())),
          `${pr.id} ${finding.id}`,
        ).toBe(true);
      }
    });
  });
});
