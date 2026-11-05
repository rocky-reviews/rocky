import { describe, expect, it } from "vitest";
import { pr847Graph } from "./test-graph.js";
import {
  clampStop,
  fitTransform,
  MAX_ZOOM,
  MIN_FOCUS_ZOOM,
  STAGE_MAX_HEIGHT,
  STAGE_MIN_HEIGHT,
  stageFor,
  tourStops,
} from "./walkthrough.js";

describe("tourStops", () => {
  it("turns each walkthrough step into a stop, in order", () => {
    const stops = tourStops(pr847Graph());
    expect(stops.map((stop) => stop.id)).toEqual(["s1", "s2", "s3"]);
    expect(stops[0]).toMatchObject({
      heading: "A new way in",
      focus: { lanes: [], nodes: ["page", "route"], edges: ["page-route"] },
    });
  });

  it("lights the graph edges a flow step's messages run along", () => {
    // s2 plays over the accept-invite flow and names m4 (auth → mem).
    const s2 = tourStops(pr847Graph())[1];
    expect(s2?.focus).toEqual({ lanes: [], nodes: ["auth", "mem"], edges: ["auth-mem"] });
  });

  it("keeps a lane focus for the renderer to expand", () => {
    expect(tourStops(pr847Graph())[2]?.focus).toEqual({ lanes: ["workers"], nodes: [], edges: [] });
  });

  it("shows a flow's participants for a whole-flow step, and a view's selection for a view step", () => {
    const graph = pr847Graph();
    graph.walkthrough = {
      steps: [
        {
          id: "a",
          heading: "Flow",
          body: "b",
          stage: { kind: "flow", flow: "accept-invite" },
          focus: { kind: "all" },
        },
        {
          id: "b",
          heading: "View",
          body: "b",
          stage: { kind: "view", view: "auth-path" },
          focus: { kind: "all" },
        },
        { id: "c", heading: "All", body: "b", focus: { kind: "all" } },
      ],
    };
    const [flow, view, all] = tourStops(graph);
    expect(flow?.focus?.nodes).toEqual(["page", "route", "auth", "inv", "mem"]);
    expect(flow?.focus?.edges).toEqual(["page-route", "route-auth", "auth-inv", "auth-mem"]);
    expect(view?.focus).toEqual({
      lanes: [],
      nodes: ["route", "auth", "inv", "mem"],
      edges: ["route-auth", "auth-inv", "auth-mem"],
    });
    expect(all?.focus).toBeUndefined();
  });

  it("is empty without a walkthrough", () => {
    const graph = pr847Graph();
    graph.walkthrough = undefined;
    expect(tourStops(graph)).toEqual([]);
  });
});

describe("clampStop", () => {
  it("keeps the index inside the tour", () => {
    expect(clampStop(-1, 3)).toBe(0);
    expect(clampStop(1, 3)).toBe(1);
    expect(clampStop(3, 3)).toBe(2);
  });
});

describe("pan and zoom", () => {
  const map = { width: 1000, height: 500 };

  it("fits the whole map in the stage, never enlarged", () => {
    expect(stageFor(500, map)).toEqual({ width: 500, height: 250, base: 0.5 });
    expect(stageFor(300, map)).toEqual({ width: 300, height: STAGE_MIN_HEIGHT, base: 0.3 });
    expect(stageFor(2000, { width: 400, height: 300 })).toEqual({
      width: 2000,
      height: 300,
      base: 1,
    });
    expect(stageFor(1000, { width: 1000, height: 2000 }).height).toBe(STAGE_MAX_HEIGHT);
  });

  it("centres the overview", () => {
    const stage = stageFor(300, map);
    const t = fitTransform(stage, map, undefined);
    expect(t.scale).toBe(0.3);
    expect(t.x).toBe(0);
    expect(t.y).toBe((STAGE_MIN_HEIGHT - 150) / 2);
  });

  it("zooms to a focus, centred on it, no further than MAX_ZOOM", () => {
    const stage = stageFor(800, map);
    const small = { x: 600, y: 300, width: 40, height: 20 };
    const t = fitTransform(stage, map, small);
    expect(t.scale).toBe(MAX_ZOOM);
    // The map covers the stage: it never slides to show empty space past its edges.
    expect(t.x).toBeLessThanOrEqual(0);
    expect(t.x).toBeGreaterThanOrEqual(stage.width - map.width * t.scale);
    expect(t.y).toBeGreaterThanOrEqual(stage.height - map.height * t.scale);
    // The focus is in view.
    expect(small.x * t.scale + t.x).toBeGreaterThanOrEqual(0);
    expect((small.x + small.width) * t.scale + t.x).toBeLessThanOrEqual(stage.width);
  });

  it("never draws a focus smaller than the map's own size, even on a phone", () => {
    const stage = stageFor(340, map);
    const focus = { x: 300, y: 100, width: 460, height: 120 };
    const t = fitTransform(stage, map, focus);
    expect(t.scale).toBe(MIN_FOCUS_ZOOM);
    // Centred on the focus, which runs past both edges of the stage.
    expect((focus.x + focus.width / 2) * t.scale + t.x).toBeCloseTo(stage.width / 2);
  });
});
