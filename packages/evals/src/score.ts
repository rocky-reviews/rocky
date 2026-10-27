/**
 * Finding scores (P4-3; grown into the eval suite's scoring by P4-7). The matching rules are
 * documented in the package README ("Matching rules") and tested in `score.test.ts`:
 *
 * 1. **Same file:** the paths are equal.
 * 2. **Overlapping lines:** the produced range overlaps the seeded range widened by `LINE_SLACK`
 *    lines on each side (a model often points one line above or below the bug).
 * 3. **Compatible severity:** at most one step apart on critical > high > medium > low.
 * 4. **Same issue:** when the seeded finding lists `keywords`, the produced title or body
 *    contains at least one of them (case-insensitive substring). Without keywords, rule 4 holds.
 *
 * Each seeded finding matches at most one produced finding and the reverse; the matched count
 * is the size of a maximum matching, so the order findings come in cannot lower it. Produced
 * findings that match no seeded one may match a `tolerated` entry (a known, harmless remark on
 * the seeded PR): those count neither for nor against. Every other produced finding is a false
 * positive; a critical false positive is a critical finding that matches no seeded bug.
 */
import type { Finding } from "@rocky-reviews/schema";

export type Severity = Finding["severity"];

export interface ScoredFinding {
  readonly id: string;
  readonly path: string;
  readonly severity: Severity;
  readonly range: Finding["range"];
  readonly title?: string;
  readonly body?: string;
}

/** A known bug in a seeded PR. `keywords` name the issue in words a review would use. */
export interface SeededFinding extends ScoredFinding {
  readonly title: string;
  readonly keywords?: readonly string[];
}

export interface FindingScore {
  readonly expected: number;
  /** Produced findings that count: every one except those that matched a tolerated entry. */
  readonly produced: number;
  readonly matched: number;
  readonly tolerated: number;
  /** matched / expected (1 when nothing is seeded). */
  readonly recall: number;
  /** matched / produced (1 when nothing counted was produced). */
  readonly precision: number;
  /** Ids of seeded findings nothing matched. */
  readonly missed: readonly string[];
  /** Seeded id → index of the produced finding it matched. */
  readonly pairs: readonly { readonly seeded: string; readonly produced: number }[];
  readonly falsePositives: readonly ScoredFinding[];
  readonly criticalProduced: number;
  readonly criticalFalsePositives: number;
  /** criticalFalsePositives / criticalProduced (0 when no critical finding counted). */
  readonly criticalFalsePositiveRate: number;
}

export const LINE_SLACK = 2;

const RANK: Readonly<Record<Severity, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

export const severityCompatible = (a: Severity, b: Severity): boolean =>
  Math.abs(RANK[a] - RANK[b]) <= 1;

const lineDistance = (seeded: ScoredFinding["range"], produced: ScoredFinding["range"]): number =>
  Math.max(0, seeded.start - produced.end, produced.start - seeded.end);

const keywordHits = (seeded: SeededFinding | ScoredFinding, produced: ScoredFinding): number => {
  const keywords = "keywords" in seeded ? (seeded.keywords ?? []) : [];
  const text = `${produced.title ?? ""}\n${produced.body ?? ""}`.toLowerCase();
  return keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
};

/** Rules 1–4 for one pair. */
export const findingMatches = (
  seeded: SeededFinding | ScoredFinding,
  produced: ScoredFinding,
): boolean => {
  const keywords = "keywords" in seeded ? (seeded.keywords ?? []) : [];
  return (
    produced.path === seeded.path &&
    lineDistance(seeded.range, produced.range) <= LINE_SLACK &&
    severityCompatible(seeded.severity, produced.severity) &&
    (keywords.length === 0 || keywordHits(seeded, produced) > 0)
  );
};

/**
 * A maximum bipartite matching (augmenting paths; the sets are small). Each seeded finding tries
 * its candidates best first: most keyword hits, then closest lines, then closest severity.
 */
const maximumMatching = (
  seeded: readonly (SeededFinding | ScoredFinding)[],
  produced: readonly ScoredFinding[],
  eligible: (index: number) => boolean,
): Map<number, number> => {
  const candidates = seeded.map((s) =>
    produced
      .map((p, index) => ({ p, index }))
      .filter(({ p, index }) => eligible(index) && findingMatches(s, p))
      .sort(
        (a, b) =>
          keywordHits(s, b.p) - keywordHits(s, a.p) ||
          lineDistance(s.range, a.p.range) - lineDistance(s.range, b.p.range) ||
          Math.abs(RANK[s.severity] - RANK[a.p.severity]) -
            Math.abs(RANK[s.severity] - RANK[b.p.severity]) ||
          a.index - b.index,
      )
      .map(({ index }) => index),
  );
  /** produced index → seeded index */
  const owner = new Map<number, number>();
  const augment = (s: number, seen: Set<number>): boolean => {
    for (const p of candidates[s] ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      const current = owner.get(p);
      if (current === undefined || augment(current, seen)) {
        owner.set(p, s);
        return true;
      }
    }
    return false;
  };
  seeded.forEach((_, s) => augment(s, new Set()));
  return owner;
};

export const scoreFindings = (
  expected: readonly (SeededFinding | ScoredFinding)[],
  actual: readonly ScoredFinding[],
  tolerated: readonly (SeededFinding | ScoredFinding)[] = [],
): FindingScore => {
  const owner = maximumMatching(expected, actual, () => true);
  const toleratedOwner = maximumMatching(tolerated, actual, (index) => !owner.has(index));
  const pairs = expected.flatMap((finding, s) =>
    [...owner]
      .filter(([, owned]) => owned === s)
      .map(([produced]) => ({ seeded: finding.id, produced })),
  );
  const matchedSeeded = new Set(owner.values());
  const missed = expected.filter((_, i) => !matchedSeeded.has(i)).map((finding) => finding.id);
  const counted = actual.filter((_, i) => !toleratedOwner.has(i));
  const falsePositives = actual.filter((_, i) => !owner.has(i) && !toleratedOwner.has(i));
  const criticalProduced = counted.filter((f) => f.severity === "critical").length;
  const criticalFalsePositives = falsePositives.filter((f) => f.severity === "critical").length;
  return {
    expected: expected.length,
    produced: counted.length,
    matched: owner.size,
    tolerated: toleratedOwner.size,
    recall: expected.length === 0 ? 1 : owner.size / expected.length,
    precision: counted.length === 0 ? 1 : owner.size / counted.length,
    missed,
    pairs,
    falsePositives,
    criticalProduced,
    criticalFalsePositives,
    criticalFalsePositiveRate:
      criticalProduced === 0 ? 0 : criticalFalsePositives / criticalProduced,
  };
};
