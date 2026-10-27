import { describe, expect, it } from "vitest";
import {
  findingMatches,
  KEYWORD_BODY_CHARS,
  LINE_SLACK,
  MAX_EXTRA_SPAN,
  scoreFindings,
  severityCompatible,
  type ScoredFinding,
  type SeededFinding,
} from "./score.js";

const seeded = (over: Partial<SeededFinding> = {}): SeededFinding => ({
  id: "S1",
  path: "src/a.ts",
  severity: "high",
  range: { start: 10, end: 12 },
  title: "SQL injection in the sort column",
  keywords: ["sql", "injection"],
  ...over,
});

const produced = (over: Partial<ScoredFinding> = {}): ScoredFinding => ({
  id: "p",
  path: "src/a.ts",
  severity: "high",
  range: { start: 11, end: 11 },
  title: "User input reaches the SQL string",
  body: "",
  ...over,
});

describe("matching rules (README: Matching rules)", () => {
  it("rule 1: the file must be the same", () => {
    expect(findingMatches(seeded(), produced())).toBe(true);
    expect(findingMatches(seeded(), produced({ path: "src/b.ts" }))).toBe(false);
  });

  it(`rule 2: lines overlap the seeded range widened by ${LINE_SLACK} lines`, () => {
    expect(LINE_SLACK).toBe(2);
    expect(findingMatches(seeded(), produced({ range: { start: 8, end: 8 } }))).toBe(true);
    expect(findingMatches(seeded(), produced({ range: { start: 14, end: 16 } }))).toBe(true);
    expect(findingMatches(seeded(), produced({ range: { start: 7, end: 7 } }))).toBe(false);
    expect(findingMatches(seeded(), produced({ range: { start: 15, end: 15 } }))).toBe(false);
  });

  it(`rule 2: a produced span wider than the seeded span plus ${2 * LINE_SLACK} lines never matches`, () => {
    // The seeded range 10–12 spans 3 lines; at most 3 + 4 = 7 lines may match.
    expect(MAX_EXTRA_SPAN).toBe(2 * LINE_SLACK);
    expect(findingMatches(seeded(), produced({ range: { start: 8, end: 14 } }))).toBe(true);
    expect(findingMatches(seeded(), produced({ range: { start: 8, end: 15 } }))).toBe(false);
    expect(findingMatches(seeded(), produced({ range: { start: 1, end: 40 } }))).toBe(false);
  });

  it("rule 3: severities at most one step apart are compatible", () => {
    expect(severityCompatible("critical", "high")).toBe(true);
    expect(severityCompatible("high", "medium")).toBe(true);
    expect(severityCompatible("medium", "low")).toBe(true);
    expect(severityCompatible("critical", "medium")).toBe(false);
    expect(severityCompatible("high", "low")).toBe(false);
    expect(findingMatches(seeded(), produced({ severity: "critical" }))).toBe(true);
    expect(findingMatches(seeded(), produced({ severity: "low" }))).toBe(false);
  });

  it(`rule 4: keywords count in the title and the first ${KEYWORD_BODY_CHARS} characters of the body only`, () => {
    expect(KEYWORD_BODY_CHARS).toBe(200);
    const late = `${"x".repeat(KEYWORD_BODY_CHARS)} sql injection`;
    expect(findingMatches(seeded(), produced({ title: "Unclear code", body: late }))).toBe(false);
    const early = `${"x".repeat(KEYWORD_BODY_CHARS - 4)} sql`;
    expect(findingMatches(seeded(), produced({ title: "Unclear code", body: early }))).toBe(true);
  });

  it("rule 4: with keywords, the title or body must name the issue (case-insensitive)", () => {
    expect(findingMatches(seeded(), produced({ title: "Missing type", body: "" }))).toBe(false);
    expect(findingMatches(seeded(), produced({ title: "x", body: "Classic INJECTION." }))).toBe(
      true,
    );
    expect(findingMatches(seeded({ keywords: [] }), produced({ title: "anything" }))).toBe(true);
    const plain: ScoredFinding = {
      id: "S1",
      path: "src/a.ts",
      severity: "high",
      range: { start: 10, end: 12 },
    };
    expect(findingMatches(plain, produced({ title: "anything" }))).toBe(true);
  });
});

describe("scoreFindings", () => {
  it("counts recall, precision and critical false positives", () => {
    const score = scoreFindings(
      [seeded(), seeded({ id: "S2", path: "src/b.ts", severity: "critical", keywords: [] })],
      [
        produced(),
        produced({ id: "fp1", path: "src/c.ts", severity: "critical" }),
        produced({ id: "fp2", path: "src/c.ts", severity: "low" }),
      ],
    );
    expect(score).toMatchObject({
      expected: 2,
      produced: 3,
      matched: 1,
      recall: 0.5,
      precision: 1 / 3,
      missed: ["S2"],
      pairs: [{ seeded: "S1", produced: 0 }],
      criticalProduced: 1,
      criticalFalsePositives: 1,
      criticalFalsePositiveRate: 1,
    });
    expect(score.falsePositives.map((f) => f.id)).toEqual(["fp1", "fp2"]);
  });

  it("a critical finding that matches a seeded bug is not a critical false positive", () => {
    const score = scoreFindings(
      [seeded()],
      [produced({ severity: "critical" }), produced({ id: "x", severity: "low", path: "z" })],
    );
    expect(score.criticalProduced).toBe(1);
    expect(score.criticalFalsePositives).toBe(0);
    expect(score.criticalFalsePositiveRate).toBe(0);
  });

  it("each seeded finding matches at most once, and each produced one at most once", () => {
    const score = scoreFindings([seeded()], [produced(), produced({ id: "dup" })]);
    expect(score.matched).toBe(1);
    expect(score.falsePositives.map((f) => f.id)).toEqual(["dup"]);
    const two = scoreFindings([seeded(), seeded({ id: "S2" })], [produced()]);
    expect(two.matched).toBe(1);
    expect(two.missed).toEqual(["S2"]);
  });

  it("finds the maximum matching whatever the order (no greedy loss)", () => {
    // S1 accepts p0 and p1; S2 accepts only p0. Greedy S1→p0 would leave S2 unmatched.
    const s1 = seeded({ keywords: [] });
    const s2 = seeded({ id: "S2", range: { start: 16, end: 16 }, keywords: [] });
    const p0 = produced({ id: "p0", range: { start: 14, end: 14 } });
    const p1 = produced({ id: "p1", range: { start: 10, end: 10 } });
    const score = scoreFindings([s1, s2], [p0, p1]);
    expect(score.matched).toBe(2);
    expect(score.pairs).toEqual([
      { seeded: "S1", produced: 1 },
      { seeded: "S2", produced: 0 },
    ]);
  });

  it("prefers the candidate that names the issue over a closer one", () => {
    const score = scoreFindings(
      [seeded({ keywords: ["sql", "order by"] })],
      [
        produced({ id: "near", range: { start: 10, end: 10 }, title: "sql" }),
        produced({ id: "named", range: { start: 13, end: 13 }, title: "sql in ORDER BY" }),
      ],
    );
    expect(score.pairs).toEqual([{ seeded: "S1", produced: 1 }]);
  });

  it("tolerated remarks count neither for nor against", () => {
    const tolerated = [seeded({ id: "T1", path: "src/t.ts", severity: "low", keywords: ["test"] })];
    const score = scoreFindings(
      [seeded()],
      [produced(), produced({ id: "t", path: "src/t.ts", severity: "low", title: "Add a test" })],
      tolerated,
    );
    expect(score).toMatchObject({ produced: 1, matched: 1, tolerated: 1, precision: 1 });
    expect(score.falsePositives).toEqual([]);
  });

  it("gaming: many wide, keyword-stuffed findings do not raise recall (review round 1)", () => {
    const expected = Array.from({ length: 12 }, (_, i) =>
      seeded({
        id: `S${i}`,
        path: `src/f${i % 3}.ts`,
        range: { start: 10 + 20 * i, end: 10 + 20 * i },
      }),
    );
    const stuffing = expected.flatMap((s) => s.keywords ?? []).join(" ");
    const gamed = ["src/f0.ts", "src/f1.ts", "src/f2.ts"].flatMap((path) =>
      (["critical", "high", "medium", "low"] as const).map((severity, k) => ({
        id: `${path}-${k}`,
        path,
        severity,
        range: { start: 1, end: 400 },
        title: "Several issues in this file",
        body: `${"Please review this file carefully. ".repeat(8)}${stuffing}`,
      })),
    );
    const honest = scoreFindings(expected, []);
    const score = scoreFindings(expected, gamed);
    expect(score.matched).toBe(honest.matched);
    expect(score.recall).toBe(0);
    expect(score.precision).toBe(0);
  });

  it("nothing seeded and nothing produced scores 1 recall, 1 precision and 0 critical rate", () => {
    expect(scoreFindings([], [])).toMatchObject({
      recall: 1,
      precision: 1,
      criticalFalsePositiveRate: 0,
    });
  });
});
