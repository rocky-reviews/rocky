/**
 * Finding scores (P4-3; P4-7 grows this into the eval suite). A produced finding matches a seeded
 * one when it names the same file, has the same severity and its range overlaps; each seeded
 * finding matches at most once. Unmatched produced findings are false positives.
 */
import type { Finding } from "@rocky-reviews/schema";

export type ScoredFinding = Pick<Finding, "id" | "path" | "severity" | "range">;

export interface FindingScore {
  readonly expected: number;
  readonly matched: number;
  readonly recall: number;
  /** Ids of seeded findings nothing matched. */
  readonly missed: readonly string[];
  readonly falsePositives: readonly ScoredFinding[];
  readonly criticalFalsePositives: number;
}

const overlaps = (a: ScoredFinding["range"], b: ScoredFinding["range"]): boolean =>
  a.start <= b.end && b.start <= a.end;

export const scoreFindings = (
  expected: readonly ScoredFinding[],
  actual: readonly ScoredFinding[],
): FindingScore => {
  const used = new Set<number>();
  const missed: string[] = [];
  for (const seeded of expected) {
    const index = actual.findIndex(
      (finding, i) =>
        !used.has(i) &&
        finding.path === seeded.path &&
        finding.severity === seeded.severity &&
        overlaps(finding.range, seeded.range),
    );
    if (index === -1) missed.push(seeded.id);
    else used.add(index);
  }
  const falsePositives = actual.filter((_, i) => !used.has(i));
  return {
    expected: expected.length,
    matched: used.size,
    recall: expected.length === 0 ? 1 : used.size / expected.length,
    missed,
    falsePositives,
    criticalFalsePositives: falsePositives.filter((f) => f.severity === "critical").length,
  };
};
