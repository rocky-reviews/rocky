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

/**
 * H4-7: a flow runs only between nodes the map declares and a step's focus names only its
 * nodes and edges; everything else is dropped and counted, the rest kept, and the issues of a
 * whole document are split by the call that can repair them.
 */
import type { FlowsAnswer, WalkthroughAnswer } from "./outputs.js";
import {
  graphIds,
  partitionIssues,
  rebaseFlowIssues,
  rebaseStepIssues,
  stripFlowRefs,
  stripWalkthroughRefs,
  toWalkthrough,
} from "./validate.js";

const ids = graphIds({
  lanes: [lane],
  nodes: [node("a"), node("b"), node("c")],
  edges: [edge("ab"), edge("bc")],
});
const message = (
  id: string,
  from: string,
  to: string,
  files: Ref[] = [],
): FlowsAnswer["flows"][number]["messages"][number] => ({
  id,
  from,
  to,
  label: id,
  kind: from === to ? "self" : "sync",
  delta: "added",
  animated: true,
  files,
});
const flowOf = (
  id: string,
  participants: string[],
  messages: FlowsAnswer["flows"][number]["messages"],
): FlowsAnswer["flows"][number] => ({
  id,
  title: id,
  delta: "modified",
  participants: participants.map((node) => ({ node })),
  messages,
});

describe("stripFlowRefs", () => {
  it("keeps an answer whose participants, messages and files are all declared, as is", () => {
    const answer: FlowsAnswer = {
      flows: [flowOf("f", ["a", "b"], [message("m1", "a", "b", [{ path: "src/a.ts" }])])],
    };
    const result = stripFlowRefs(answer, ids, mapped);
    expect(result).toEqual({
      answer,
      refs: 0,
      files: 0,
      ranges: 0,
      index: { flows: [{ flow: 0, participants: [0, 1], messages: [0] }] },
    });
    expect(result.answer).toBe(answer);
  });

  it("drops an unknown participant, then the messages it carried, then a flow left too small", () => {
    const answer: FlowsAnswer = {
      flows: [
        flowOf(
          "f",
          ["a", "ghost", "b"],
          [message("m1", "a", "ghost"), message("m2", "ghost", "ghost"), message("m3", "a", "b")],
        ),
        flowOf("g", ["a", "ghost"], [message("m1", "a", "ghost")]),
        flowOf("h", ["a", "b"], [message("m1", "a", "ghost")]),
      ],
    };
    const result = stripFlowRefs(answer, ids, mapped);
    expect(result.answer.flows.map((flow) => flow.id)).toEqual(["f"]);
    expect(result.answer.flows[0]?.participants).toEqual([{ node: "a" }, { node: "b" }]);
    expect(result.answer.flows[0]?.messages.map((m) => m.id)).toEqual(["m3"]);
    // f: ghost, m1, m2; g: ghost, m1, the flow; h: m1, the flow.
    expect(result.refs).toBe(8);
    // Where the kept elements sat in the answer, for repair paths (SF2).
    expect(result.index).toEqual({ flows: [{ flow: 0, participants: [0, 2], messages: [2] }] });
    expect(
      rebaseFlowIssues(
        [
          "flows[0].messages[0].id: DUPLICATE_ID",
          "flows[0].participants[1].node: DUPLICATE_ID",
          "flows[0].title: INVALID_SHAPE",
          "flows[0]: INVALID_SHAPE",
          "flows: too_small",
          "flows[9].messages[0].id: DUPLICATE_ID",
        ],
        result.index,
      ),
    ).toEqual([
      "flows[0].messages[2].id: DUPLICATE_ID",
      "flows[0].participants[2].node: DUPLICATE_ID",
      "flows[0].title: INVALID_SHAPE",
      "flows[0]: INVALID_SHAPE",
      "flows: too_small",
      "flows[9].messages[0].id: DUPLICATE_ID",
    ]);
    const second = stripFlowRefs(
      { flows: [flowOf("x", ["ghost"], [message("m", "ghost", "ghost")]), ...answer.flows] },
      ids,
      mapped,
    );
    expect(second.index.flows.map((entry) => entry.flow)).toEqual([1]);
    expect(rebaseFlowIssues(["flows[0].messages[0].kind: INVALID_SHAPE"], second.index)).toEqual([
      "flows[1].messages[2].kind: INVALID_SHAPE",
    ]);
  });

  it("strips a step's file references and ranges by the graph's rules, counting them apart", () => {
    const answer: FlowsAnswer = {
      flows: [
        flowOf(
          "f",
          ["a", "b"],
          [
            message("m1", "a", "b", [
              { path: "src/a.ts", range: { start: 10, end: 12 } },
              { path: "src/a.ts", range: { start: 1, end: 12 } },
              { path: "docs/x.md" },
            ]),
          ],
        ),
      ],
    };
    const result = stripFlowRefs(answer, ids, mapped);
    expect(result.answer.flows[0]?.messages[0]?.files).toEqual([
      { path: "src/a.ts", range: { start: 10, end: 12 } },
      { path: "src/a.ts" },
    ]);
    expect(result).toMatchObject({ refs: 0, files: 1, ranges: 1 });
  });

  it("is idempotent and may leave no flow at all", () => {
    const answer: FlowsAnswer = {
      flows: [flowOf("f", ["x", "y"], [message("m", "x", "y")])],
    };
    const once = stripFlowRefs(answer, ids, mapped);
    expect(once.answer.flows).toEqual([]);
    // x, y, the message between them, and the flow.
    expect(once.refs).toBe(4);
    expect(stripFlowRefs(once.answer, ids, mapped)).toEqual({
      answer: once.answer,
      refs: 0,
      files: 0,
      ranges: 0,
      index: { flows: [] },
    });
  });
});

describe("stripWalkthroughRefs and toWalkthrough", () => {
  const step = (
    id: string,
    focus: { nodes?: string[]; edges?: string[] },
  ): WalkthroughAnswer["steps"][number] => ({
    id,
    heading: id,
    body: "One line.",
    focus: { nodes: focus.nodes ?? [], edges: focus.edges ?? [] },
  });

  it("keeps declared ids, drops unknown ones, drops a step emptied by that, keeps a step given no focus", () => {
    const answer: WalkthroughAnswer = {
      steps: [
        step("s1", { nodes: ["a", "ghost"], edges: ["ab", "zz"] }),
        step("s2", { nodes: ["ghost"] }),
        step("s3", {}),
        step("s4", { edges: ["bc"] }),
      ],
    };
    const result = stripWalkthroughRefs(answer, ids);
    expect(result.answer.steps.map((s) => s.id)).toEqual(["s1", "s3", "s4"]);
    expect(result.answer.steps[0]?.focus).toEqual({ nodes: ["a"], edges: ["ab"] });
    expect(result.answer.steps[2]).toBe(answer.steps[3]);
    expect(result.refs).toBe(4);
    expect(result.index).toEqual([0, 2, 3]);
    const clean = stripWalkthroughRefs(result.answer, ids);
    expect(clean.answer).toBe(result.answer);
    expect(clean.refs).toBe(0);
    expect(clean.index).toEqual([0, 1, 2]);
    // Repair paths under the model's own indices (SF2); a path past the list is left alone.
    expect(
      rebaseStepIssues(
        [
          "steps[1].id: DUPLICATE_ID",
          "steps[2].focus: INVALID_SHAPE",
          "steps: INVALID_SHAPE",
          "steps[7].id: X",
        ],
        result.index,
      ),
    ).toEqual([
      "steps[2].id: DUPLICATE_ID",
      "steps[3].focus: INVALID_SHAPE",
      "steps: INVALID_SHAPE",
      "steps[7].id: X",
    ]);
  });

  it("writes the document's focus shape: a selection, or the whole map for an empty focus", () => {
    expect(
      toWalkthrough({ steps: [step("s1", { nodes: ["a"], edges: ["ab"] }), step("s2", {})] }),
    ).toEqual({
      steps: [
        {
          id: "s1",
          heading: "s1",
          body: "One line.",
          focus: { kind: "selection", lanes: [], nodes: ["a"], edges: ["ab"], messages: [] },
        },
        { id: "s2", heading: "s2", body: "One line.", focus: { kind: "all" } },
      ],
    });
  });
});

describe("partitionIssues (H4-7 parts)", () => {
  const issue = (path: string) => ({ code: "INVALID_SHAPE" as const, path, message: "m" });
  it("routes graph.flows and graph.walkthrough issues to their own calls, rebased, and the rest as before", () => {
    const split = partitionIssues([
      issue("graph.flows[0].messages[1].id"),
      issue("graph.flows"),
      issue("graph.walkthrough.steps"),
      issue("graph.walkthrough.steps[2].focus.nodes[0]"),
      issue("graph.nodes[0].lane"),
      issue("graph"),
      issue("briefing.summary"),
      issue("briefing.memoryApplied"),
      issue("findings[0].path"),
    ]);
    expect(split.flows).toEqual(["flows[0].messages[1].id: INVALID_SHAPE", "flows: INVALID_SHAPE"]);
    expect(split.walkthrough).toEqual([
      "steps: INVALID_SHAPE",
      "steps[2].focus.nodes[0]: INVALID_SHAPE",
    ]);
    expect(split.graph).toEqual(["nodes[0].lane: INVALID_SHAPE", "(root): INVALID_SHAPE"]);
    expect(split.briefing).toEqual(["summary: INVALID_SHAPE"]);
    expect(split.other).toBe(2);
  });
});
