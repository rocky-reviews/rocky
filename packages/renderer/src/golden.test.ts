import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderChangeMap, type ChangeMapSource } from "./index.js";
import { deepNesting, longLabels, pr847, singleNode, wideFanOut } from "./test-support.js";

/**
 * Golden SVGs: a change to one is a change to what a reviewer sees, so it is read by a person
 * before it is committed. Record with `UPDATE_GOLDENS=1 pnpm vitest run packages/renderer`.
 */
const GOLDENS = new URL("./__goldens__/", import.meta.url);
const UPDATE = process.env["UPDATE_GOLDENS"] === "1";

const CASES: Record<string, () => ChangeMapSource> = {
  "pr-847": pr847,
  "single-node": singleNode,
  "wide-fan-out": wideFanOut,
  "deep-nesting": deepNesting,
  "long-labels": longLabels,
  "graph-unavailable": () => ({
    findings: [],
    provenance: { graphUnavailable: { reason: "timeout" } },
  }),
  "graph-missing": () => ({ findings: [], provenance: {} }),
  "graph-empty": () => ({
    graph: { lanes: [], nodes: [], edges: [], flows: [], views: [] },
    findings: [],
    provenance: {},
  }),
};

describe("golden SVGs", () => {
  if (UPDATE) mkdirSync(GOLDENS, { recursive: true });

  for (const [name, build] of Object.entries(CASES))
    it(name, () => {
      const { svg } = renderChangeMap(build());
      const file = new URL(`${name}.svg`, GOLDENS);
      if (UPDATE) writeFileSync(file, svg);
      expect(svg).toBe(readFileSync(file, "utf8"));
    });
});
