import { describe, expect, it } from "vitest";
import type { GraphAnswer } from "./outputs.js";
import { checkGraphFiles } from "./validate.js";

/**
 * H4-5: a card or an edge may only be backed by a file the graph call was given (the filtered
 * set). The published schema allows any well-formed path (context nodes, other producers); the
 * pipeline is stricter, so a model cannot map a file it never saw, or one Rocky left out.
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

describe("checkGraphFiles", () => {
  it("accepts cards and edges backed by allowed files, or by none", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }]), node("b")],
      edges: [edge("e", [{ path: "src/b.ts" }, { path: "src/a.ts" }])],
    };
    expect(checkGraphFiles(answer, allowed)).toEqual([]);
  });

  it("names every reference outside the set, by its path in the answer, with no value", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }, { path: "README.md" }]), node("b", [{ path: "x" }])],
      edges: [edge("e", [{ path: "SRC/a.ts" }])],
    };
    const issues = checkGraphFiles(answer, allowed);
    expect(issues).toEqual([
      "nodes[0].files[1].path: UNKNOWN_FILE",
      "nodes[1].files[0].path: UNKNOWN_FILE",
      "edges[0].files[0].path: UNKNOWN_FILE",
    ]);
    expect(issues.join("\n")).not.toContain("README");
  });

  it("matches exactly: no normalisation, prefix or case folding", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts/" }, { path: "./src/a.ts" }, { path: "src/a.TS" }])],
      edges: [],
    };
    expect(checkGraphFiles(answer, allowed)).toHaveLength(3);
  });

  it("with an empty set, every reference is an issue", () => {
    const answer: GraphAnswer = {
      lanes: [lane],
      nodes: [node("a", [{ path: "src/a.ts" }])],
      edges: [],
    };
    expect(checkGraphFiles(answer, new Set())).toEqual(["nodes[0].files[0].path: UNKNOWN_FILE"]);
  });
});
