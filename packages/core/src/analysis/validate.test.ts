import { describe, expect, it } from "vitest";
import type { GraphAnswer } from "./outputs.js";
import { stripGraphRefs, type MappedFiles } from "./validate.js";

/**
 * H4-5: a card or an edge may only be backed by a file the graph call was given (the filtered
 * set), with a range inside that file's changed lines. The published schema allows any
 * well-formed path and range (context nodes, other producers); the pipeline is stricter: a
 * reference outside the set is dropped, a range outside the file's new-side hunks is dropped
 * (the reference stays), both are counted, and the map is kept (review round 1, S6).
 */

const lane = { id: "api", label: "API" };
type Ref = { path: string; range?: { start: number; end: number } };
const node = (id: string, files: Ref[] = []): GraphAnswer["nodes"][number] => ({
  id,
  label: id,
  kind: "module",
  delta: "added",
  lane: "api",
  files,
  badges: [],
});
const edge = (id: string, files: Ref[] = []): GraphAnswer["edges"][number] => ({
  id,
  from: "a",
  to: "b",
  kind: "call",
  delta: "added",
  emphasis: "normal",
  animated: false,
  files,
});
/** `src/a.ts` changed on lines 10–40 (two hunks: 10–14 and 30–40); `src/b.ts` has no new side. */
const mapped: MappedFiles = new Map([
  ["src/a.ts", { start: 10, end: 40 }],
  ["src/b.ts", undefined],
]);

describe("stripGraphRefs: files", () => {
  it("keeps an answer whose cards and edges are backed by allowed files, or by none, as is", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }]), node("b")],
      edges: [edge("e", [{ path: "src/b.ts" }, { path: "src/a.ts" }])],
    };
    const result = stripGraphRefs(answer, mapped);
    expect(result).toEqual({ answer, files: 0, ranges: 0 });
    expect(result.answer).toBe(answer);
  });

  it("drops every reference outside the set, counts them, and leaves the rest untouched", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }, { path: "README.md" }]), node("b", [{ path: "x" }])],
      edges: [edge("e", [{ path: "SRC/a.ts" }, { path: "src/b.ts" }])],
    };
    const result = stripGraphRefs(answer, mapped);
    expect(result.files).toBe(3);
    expect(result.ranges).toBe(0);
    expect(result.answer).toEqual({
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }]), node("b", [])],
      edges: [edge("e", [{ path: "src/b.ts" }])],
    });
    // The input is not mutated.
    expect(answer.nodes[0]?.files).toHaveLength(2);
  });

  it("matches exactly: no normalisation, prefix or case folding", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts/" }, { path: "./src/a.ts" }, { path: "src/a.TS" }])],
      edges: [],
    };
    const result = stripGraphRefs(answer, mapped);
    expect(result.files).toBe(3);
    expect(result.answer.nodes[0]?.files).toEqual([]);
  });

  it("with an empty set, every reference is dropped", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }])],
      edges: [],
    };
    expect(stripGraphRefs(answer, new Map())).toEqual({
      answer: { lanes: [lane], nodes: [node("a", [])], edges: [] },
      files: 1,
      ranges: 0,
    });
  });
});

describe("stripGraphRefs: ranges", () => {
  it("keeps a range inside the span of the file's new-side hunks, edges included", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts", range: { start: 10, end: 40 } }])],
      edges: [edge("e", [{ path: "src/a.ts", range: { start: 12, end: 12 } }])],
    };
    expect(stripGraphRefs(answer, mapped)).toEqual({ answer, files: 0, ranges: 0 });
  });

  it("drops a range that starts before, ends after, or lies outside the span; the reference stays", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [
        node("a", [
          { path: "src/a.ts", range: { start: 9, end: 12 } },
          { path: "src/a.ts", range: { start: 30, end: 41 } },
          { path: "src/a.ts", range: { start: 100, end: 120 } },
          { path: "src/a.ts", range: { start: 1, end: 1 } },
        ]),
      ],
      edges: [],
    };
    const result = stripGraphRefs(answer, mapped);
    expect(result.ranges).toBe(4);
    expect(result.files).toBe(0);
    expect(result.answer.nodes[0]?.files).toEqual([
      { path: "src/a.ts" },
      { path: "src/a.ts" },
      { path: "src/a.ts" },
      { path: "src/a.ts" },
    ]);
  });

  it("a file with no new-side lines keeps no range", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/b.ts", range: { start: 1, end: 3 } }])],
      edges: [],
    };
    const result = stripGraphRefs(answer, mapped);
    expect(result.ranges).toBe(1);
    expect(result.answer.nodes[0]?.files).toEqual([{ path: "src/b.ts" }]);
  });

  it("a stray file's range counts as a dropped file, not as a dropped range", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "docs/x.md", range: { start: 1, end: 3 } }])],
      edges: [],
    };
    expect(stripGraphRefs(answer, mapped)).toMatchObject({ files: 1, ranges: 0 });
  });

  it("is deterministic and idempotent", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [
        node("a", [
          { path: "src/a.ts", range: { start: 10, end: 99 } },
          { path: "docs/x.md" },
          { path: "src/a.ts", range: { start: 11, end: 11 } },
        ]),
      ],
      edges: [],
    };
    const once = stripGraphRefs(answer, mapped);
    expect(once).toMatchObject({ files: 1, ranges: 1 });
    const twice = stripGraphRefs(once.answer, mapped);
    expect(twice).toEqual({ answer: once.answer, files: 0, ranges: 0 });
    expect(stripGraphRefs(answer, mapped).answer).toEqual(once.answer);
  });
});
