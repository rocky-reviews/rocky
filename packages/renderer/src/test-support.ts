/** Shared by the test files; not part of the package's exports. */
import {
  Finding,
  Graph,
  parseAnalysisDocument,
  type AnalysisDocument,
  type FindingInput,
  type GraphInput,
} from "@rocky-reviews/schema";
import pr847Json from "../../schema/fixtures/pr-847.json" with { type: "json" };
import type { ChangeMapSource } from "./index.js";

/** The pr-847 fixture, through the real parser, so defaults are filled in as in production. */
export const pr847 = (): AnalysisDocument => {
  // A deep copy, so a test that edits the document cannot leak into the next one.
  const parsed = parseAnalysisDocument(structuredClone(pr847Json));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const finding = (input: Partial<FindingInput> & Pick<FindingInput, "id" | "path">): Finding =>
  Finding.parse({
    severity: "medium",
    confidence: 80,
    range: { start: 1, end: 1 },
    title: `Finding ${input.id}`,
    body: "Body.",
    agentPrompt: "Fix it.",
    ...input,
  });

const source = (graph: GraphInput, findings: Finding[] = []): ChangeMapSource => ({
  graph: Graph.parse(graph),
  findings,
  provenance: {},
});

const node = (id: string, lane: string, extra: Partial<GraphInput["nodes"][number]> = {}) => ({
  id,
  label: id,
  kind: "module" as const,
  delta: "added" as const,
  lane,
  files: [{ path: `src/${id}.ts` }],
  ...extra,
});

const edge = (
  from: string,
  to: string,
  extra: Partial<NonNullable<GraphInput["edges"]>[number]> = {},
) => ({
  id: `${from}-${to}`,
  from,
  to,
  kind: "call" as const,
  delta: "added" as const,
  ...extra,
});

/** One lane, one card, one finding on it. */
export const singleNode = (): ChangeMapSource =>
  source(
    {
      lanes: [{ id: "app", label: "APP" }],
      nodes: [node("only", "app", { label: "OnlyModule", subtitle: "src/only.ts" })],
    },
    [finding({ id: "F1", path: "src/only.ts", severity: "high" })],
  );

/** A hub calling ten cards in the next lane and two in a lane further on. */
export const wideFanOut = (): ChangeMapSource => {
  const leaves = Array.from({ length: 10 }, (_, index) => `leaf-${String(index).padStart(2, "0")}`);
  const far = ["far-a", "far-b"];
  return source(
    {
      lanes: [
        { id: "hub", label: "HUB", order: 0 },
        { id: "leaves", label: "LEAVES", order: 1 },
        { id: "middle", label: "MIDDLE", order: 2 },
        { id: "far", label: "FAR", order: 3 },
      ],
      nodes: [
        node("hub", "hub", { kind: "service", subtitle: "src/hub.ts" }),
        ...leaves.map((id, index) =>
          node(id, "leaves", { delta: index % 3 === 0 ? "modified" : "unchanged" }),
        ),
        node("middle", "middle", { delta: "unchanged", files: [] }),
        ...far.map((id) => node(id, "far")),
      ],
      edges: [
        ...leaves.map((id, index) =>
          edge(
            "hub",
            id,
            index === 0 ? { label: "dispatch", emphasis: "hero", animated: true } : {},
          ),
        ),
        ...far.map((id) => edge("hub", id, { kind: "queue", label: `enqueue ${id}` })),
      ],
    },
    [
      finding({ id: "F1", path: "src/hub.ts", severity: "critical" }),
      finding({ id: "F2", path: "src/hub.ts", severity: "low" }),
      finding({ id: "F3", path: "src/leaf-03.ts", severity: "medium" }),
      finding({ id: "F4", path: "src/far-b.ts", severity: "low" }),
    ],
  );
};

/** A chain eight deep in one lane, a cycle back to the top, and a hop that skips rows. */
export const deepNesting = (): ChangeMapSource => {
  const chain = Array.from({ length: 8 }, (_, index) => `step-${index + 1}`);
  return source({
    lanes: [
      { id: "pipeline", label: "PIPELINE" },
      { id: "store", label: "STORE" },
    ],
    nodes: [
      ...chain.map((id, index) => node(id, "pipeline", { subtitle: `depth ${index + 1}` })),
      node("db", "store", { kind: "datastore", delta: "unchanged", files: [] }),
    ],
    edges: [
      ...chain.slice(1).map((id, index) => edge(chain[index] ?? "", id)),
      edge("step-8", "step-1", { id: "retry", label: "retry", delta: "modified" }),
      edge("step-2", "step-6", { id: "shortcut", label: "short-circuit" }),
      edge("step-4", "db", { kind: "data", label: "write" }),
      edge("db", "step-7", { kind: "data", label: "read back" }),
    ],
  });
};

const LONG = "A".repeat(10) + " very long label that keeps going ".repeat(4);

/** Every text field at or near its limit, plus the deltas and emphases the others lack. */
export const longLabels = (): ChangeMapSource =>
  source(
    {
      lanes: [
        { id: "first", label: LONG.slice(0, 120), subtitle: "subtitle that also runs on" },
        { id: "second", label: "SECOND" },
      ],
      nodes: [
        node("long", "first", {
          label: LONG.slice(0, 120),
          subtitle: `src/${"deeply/nested/".repeat(6)}file.ts`.slice(0, 120),
          badges: ["hot path"],
        }),
        node("gone", "first", { label: "RemovedThing", delta: "removed", subtitle: "was here" }),
        node("changed", "second", { label: "ChangedThing", delta: "modified" }),
        node("ctx", "second", { label: "Context", delta: "unchanged", files: [] }),
      ],
      edges: [
        edge("long", "changed", { label: LONG.slice(0, 120), emphasis: "hero", animated: true }),
        edge("gone", "changed", { delta: "removed", label: "old call" }),
        edge("changed", "ctx", { emphasis: "muted", delta: "unchanged" }),
        edge("changed", "changed", { id: "loop", label: "retries" }),
      ],
    },
    Array.from({ length: 12 }, (_, index) =>
      finding({ id: `F${index + 1}`, path: "src/long.ts", severity: index === 0 ? "high" : "low" }),
    ),
  );

/** pr-847 with every label, subtitle and badge replaced by `text`. */
export const withLabels = (text: string): ChangeMapSource => {
  const doc = pr847();
  const graph = doc.graph;
  if (graph === undefined) throw new Error("pr-847 has a graph");
  return {
    ...doc,
    graph: {
      ...graph,
      lanes: graph.lanes.map((lane) => ({ ...lane, label: text, subtitle: text })),
      nodes: graph.nodes.map((node) => ({ ...node, label: text, subtitle: text, badges: [text] })),
      edges: graph.edges.map((edge) => ({ ...edge, label: text })),
    },
  };
};
