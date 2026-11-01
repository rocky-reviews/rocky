import { describe, expect, it } from "vitest";
import { mapModeFor, NO_FLOWS, NO_WALKTHROUGH } from "./map-mode.js";
import { pr847Graph } from "./test-graph.js";

describe("mapModeFor", () => {
  it("plays Live traffic by default, with no notice", () => {
    expect(mapModeFor("live", pr847Graph())).toEqual({ kind: "live", notice: undefined });
  });

  it("plays the walkthrough and the flows when the document has them", () => {
    const walk = mapModeFor("walkthrough", pr847Graph());
    expect(walk.kind).toBe("walkthrough");
    if (walk.kind === "walkthrough") expect(walk.stops).toHaveLength(3);
    const flows = mapModeFor("flows", pr847Graph());
    expect(flows.kind).toBe("flows");
    if (flows.kind === "flows") expect(flows.flows.map((f) => f.id)).toEqual(["accept-invite"]);
  });

  it("falls back to Live traffic with a notice when they are missing", () => {
    const graph = pr847Graph();
    graph.walkthrough = undefined;
    graph.flows = [];
    expect(mapModeFor("walkthrough", graph)).toEqual({ kind: "live", notice: NO_WALKTHROUGH });
    expect(mapModeFor("flows", graph)).toEqual({ kind: "live", notice: NO_FLOWS });
  });
});
