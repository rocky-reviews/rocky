import { describe, expect, it } from "vitest";
import type { GraphAnswer } from "./outputs.js";
import { stripGraphFiles } from "./validate.js";

/**
 * H4-5: a card or an edge may only be backed by a file the graph call was given (the filtered
 * set). The published schema allows any well-formed path (context nodes, other producers); the
 * pipeline is stricter: a reference outside the set is dropped and counted, and the map is kept
 * (review round 1, S6).
 */

const lane = { id: "api", label: "API" };
const node = (id: string, files: { path: string }[] = []): GraphAnswer["nodes"][number] => ({
  id,
  label: id,
  kind: "module",
  delta: "added",
  lane: "api",
  files,
  badges: [],
});
const edge = (id: string, files: { path: string }[] = []): GraphAnswer["edges"][number] => ({
  id,
  from: "a",
  to: "b",
  kind: "call",
  delta: "added",
  emphasis: "normal",
  animated: false,
  files,
});
const allowed = new Set(["src/a.ts", "src/b.ts"]);

describe("stripGraphFiles", () => {
  it("keeps an answer whose cards and edges are backed by allowed files, or by none, as is", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }]), node("b")],
      edges: [edge("e", [{ path: "src/b.ts" }, { path: "src/a.ts" }])],
    };
    const result = stripGraphFiles(answer, allowed);
    expect(result.stripped).toBe(0);
    expect(result.answer).toBe(answer);
  });

  it("drops every reference outside the set, counts them, and leaves the rest untouched", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }, { path: "README.md" }]), node("b", [{ path: "x" }])],
      edges: [edge("e", [{ path: "SRC/a.ts" }, { path: "src/b.ts" }])],
    };
    const result = stripGraphFiles(answer, allowed);
    expect(result.stripped).toBe(3);
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
    const result = stripGraphFiles(answer, allowed);
    expect(result.stripped).toBe(3);
    expect(result.answer.nodes[0]?.files).toEqual([]);
  });

  it("is deterministic and idempotent: stripping a stripped answer changes nothing", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }, { path: "docs/x.md" }])],
      edges: [],
    };
    const once = stripGraphFiles(answer, allowed);
    const twice = stripGraphFiles(once.answer, allowed);
    expect(twice.stripped).toBe(0);
    expect(twice.answer).toBe(once.answer);
    expect(stripGraphFiles(answer, allowed).answer).toEqual(once.answer);
  });

  it("with an empty set, every reference is dropped", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }])],
      edges: [],
    };
    expect(stripGraphFiles(answer, new Set())).toEqual({
      answer: { lanes: [lane], nodes: [node("a", [])], edges: [] },
      stripped: 1,
    });
  });
});
