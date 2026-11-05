/**
 * H4-6 (ADR 0035): the animated map styles. `motion` adds the travelling-dot paths and the
 * classes the stylesheet animates; `focus` lights a walkthrough step's part of the map and dims
 * the rest. Both are off by default, so the static map (and its goldens) is unchanged.
 */
import { describe, expect, it } from "vitest";
import { renderChangeMap } from "./index.js";
import { inspectSvg } from "./inspect.js";
import { pr847 } from "./test-support.js";

const openTag = (svg: string, name: string, value: string): string =>
  new RegExp(`<[a-z]+ [^>]*${name}="${value}"[^>]*>`).exec(svg)?.[0] ?? "";

const pulses = (svg: string): string[] => svg.match(/<path class="cm-pulse"[^>]*\/>/g) ?? [];

describe("renderChangeMap motion", () => {
  it("is off by default: no pulse paths, no motion classes", () => {
    const { svg } = renderChangeMap(pr847());
    expect(svg).not.toMatch(/cm-(?:motion|pulse|traffic|wave|focus|dim)/);
  });

  it("puts a dot path on every hero edge, with the edge's own route", () => {
    const map = renderChangeMap(pr847(), { motion: true });
    expect(map.svg).toMatch(/^<svg [^>]*class="cm cm-motion"/);
    const dots = pulses(map.svg);
    // pr-847 marks route-auth and auth-mem as hero.
    expect(dots).toHaveLength(2);
    for (const id of ["route-auth", "auth-mem"]) {
      const edge = openTag(map.svg, "data-edge", id);
      expect(edge).toMatch(/class="cm-edge cm-added cm-hero cm-animated cm-traffic"/);
      const d = /d="([^"]+)"/.exec(edge)?.[1];
      expect(dots.some((dot) => dot.includes(`d="${d}"`))).toBe(true);
    }
    for (const dot of dots) expect(dot).toMatch(/pathLength="100" aria-hidden="true"/);
    expect(() => inspectSvg(map.svg)).not.toThrow();
  });

  it("marks the cards a dot arrives at, and staggers cards lane by lane", () => {
    const { svg } = renderChangeMap(pr847(), { motion: true });
    expect(openTag(svg, "data-node", "auth")).toMatch(
      /class="cm-node cm-added cm-wave-1 cm-traffic-end"/,
    );
    expect(openTag(svg, "data-node", "mem")).toMatch(
      /class="cm-node cm-unchanged cm-wave-2 cm-traffic-end"/,
    );
    expect(openTag(svg, "data-node", "page")).toMatch(/class="cm-node cm-added cm-wave-0"/);
    expect(openTag(svg, "data-node", "job")).toMatch(/class="cm-node cm-added cm-wave-3"/);
  });

  it("caps the stagger, so a map with many lanes still settles quickly", () => {
    const doc = pr847();
    const graph = doc.graph;
    if (graph === undefined) throw new Error("fixture has a graph");
    const lanes = Array.from({ length: 9 }, (_, index) => ({
      id: `l${index}`,
      label: `L${index}`,
    }));
    doc.graph = {
      ...graph,
      lanes,
      nodes: lanes.map((lane, index) => ({ ...graph.nodes[0]!, id: `n${index}`, lane: lane.id })),
      edges: [],
      flows: [],
      views: [],
      walkthrough: undefined,
    };
    const { svg } = renderChangeMap(doc, { motion: true });
    expect(openTag(svg, "data-node", "n8")).toMatch(/cm-wave-5"/);
    expect(() => inspectSvg(svg)).not.toThrow();
  });

  it("falls back to edges marked animated when nothing is marked hero", () => {
    const doc = pr847();
    if (doc.graph === undefined) throw new Error("fixture has a graph");
    doc.graph.edges = doc.graph.edges.map((edge) => ({
      ...edge,
      emphasis: "normal",
      animated: edge.id === "job-mail",
    }));
    const { svg } = renderChangeMap(doc, { motion: true });
    expect(pulses(svg)).toHaveLength(1);
    expect(openTag(svg, "data-edge", "job-mail")).toMatch(/cm-traffic"/);
    expect(openTag(svg, "data-node", "mail")).toMatch(/cm-traffic-end"/);
  });

  it("draws no dots when nothing is hero or animated, and the pulses group stays", () => {
    const doc = pr847();
    if (doc.graph === undefined) throw new Error("fixture has a graph");
    doc.graph.edges = doc.graph.edges.map((edge) => ({
      ...edge,
      emphasis: "normal",
      animated: false,
    }));
    const { svg } = renderChangeMap(doc, { motion: true });
    expect(pulses(svg)).toHaveLength(0);
    expect(svg).toContain('<g class="cm-pulses">');
  });

  it("keeps the layout: the same coordinates with and without motion", () => {
    const still = renderChangeMap(pr847());
    const moving = renderChangeMap(pr847(), { motion: true });
    expect(moving.width).toBe(still.width);
    expect(moving.height).toBe(still.height);
    const coords = (svg: string) => svg.match(/ (?:x|y|d)="[^"]+"/g);
    expect(coords(moving.svg)?.filter((_, i, all) => all.indexOf(_) === i)).toEqual(
      coords(still.svg)?.filter((_, i, all) => all.indexOf(_) === i),
    );
  });
});

describe("renderChangeMap focus", () => {
  const focus = { lanes: [], nodes: ["page", "route"], edges: ["page-route"] };

  it("lights the focused cards and edges and dims the rest", () => {
    const map = renderChangeMap(pr847(), { focus });
    const { svg } = map;
    expect(openTag(svg, "data-node", "page")).toMatch(/cm-focus"/);
    expect(openTag(svg, "data-node", "auth")).toMatch(/cm-dim"/);
    expect(openTag(svg, "data-findings", "F1 F3 F8")).toMatch(
      /class="cm-badge cm-critical cm-dim"/,
    );
    expect(openTag(svg, "data-edge", "page-route")).toMatch(/class="cm-edge cm-added cm-focus"/);
    expect(openTag(svg, "data-edge", "route-auth")).toMatch(/cm-dim"/);
    expect(svg).toMatch(/<g class="cm-lane cm-dim">/);
    expect(() => inspectSvg(svg)).not.toThrow();
  });

  it("returns the box the focus covers, inside the map", () => {
    const map = renderChangeMap(pr847(), { focus });
    if (map.status !== "rendered") throw new Error("rendered");
    const box = map.focusBox;
    expect(box).toBeDefined();
    if (box === undefined) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(map.width);
    expect(box.y + box.height).toBeLessThanOrEqual(map.height);
    // Two cards in two lanes: wider than one card.
    expect(box.width).toBeGreaterThan(200);
  });

  it("lights a whole lane and the cards in it", () => {
    const map = renderChangeMap(pr847(), { focus: { lanes: ["workers"], nodes: [], edges: [] } });
    expect(map.svg).toMatch(/<g class="cm-lane cm-focus">/);
    expect(openTag(map.svg, "data-node", "job")).toMatch(/cm-focus"/);
    expect(openTag(map.svg, "data-node", "mail")).toMatch(/cm-focus"/);
    expect(openTag(map.svg, "data-node", "page")).toMatch(/cm-dim"/);
  });

  it("puts dots on the focused edges only, when motion is on", () => {
    const { svg } = renderChangeMap(pr847(), { motion: true, focus });
    const dots = pulses(svg);
    expect(dots).toHaveLength(1);
    const d = /d="([^"]+)"/.exec(openTag(svg, "data-edge", "page-route"))?.[1];
    expect(dots[0]).toContain(`d="${d}"`);
    expect(openTag(svg, "data-node", "route")).toMatch(/cm-traffic-end cm-focus"/);
    expect(openTag(svg, "data-node", "auth")).not.toMatch(/cm-traffic-end/);
  });

  it("ignores ids the graph does not have, and gives no box for an empty focus", () => {
    const map = renderChangeMap(pr847(), {
      focus: { lanes: ["x"], nodes: ["__proto__"], edges: [] },
    });
    if (map.status !== "rendered") throw new Error("rendered");
    expect(map.focusBox).toBeUndefined();
    expect(map.svg).not.toMatch(/cm-(?:focus|dim)/);
  });
});
