/**
 * Where every lane and card goes.
 *
 * Lane ordering and the partner-barycentre tie-break are adapted from PR Lens
 * (https://github.com/coldteadotai/pr-lens, packages/renderer/src/layout/architecture.ts and
 * seating.ts at 918ffe82cb1dd71d20ce70b27917aeb80a7a4b49), MIT License, Copyright (c) 2026
 * Coldtea AI. See NOTICE. Changes: the POC's compact grid (one card per row, rows counted per
 * lane) instead of PR Lens's shared row grid and paired cards; removed cards sink to the bottom
 * of their lane instead of a dead band; corridor widening only for label room.
 */
import type { Graph, GraphNode, Lane } from "@rocky-reviews/schema";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CONTENT_TOP,
  LANE_BOTTOM,
  LANE_GAP,
  LANE_WIDTH,
  MARGIN,
  ROW_INSET,
  ROW_PITCH,
} from "../design.js";
import type { Box } from "../geometry.js";
import { rankNodes } from "./rank.js";

/** A card's seat: which lane, which row of it. Geometry comes later. */
export type Seat = { node: GraphNode; lane: number; row: number };

export type Grid = { lanes: Lane[]; seats: Seat[]; bySeat: Map<string, Seat>; rows: number };

export type PlacedLane = { lane: Lane; index: number; box: Box };

export type PlacedNode = Seat & { box: Box };

export type Placement = {
  width: number;
  height: number;
  rows: number;
  lanes: PlacedLane[];
  /** Lane by lane, top to bottom: the order cards are painted in. */
  nodes: PlacedNode[];
  byId: Map<string, PlacedNode>;
};

/**
 * Declared `order` first, then the order the lanes were written in: `order` may be absent and
 * two lanes may share one, so the array index is the tie-break that keeps this stable.
 */
export const orderLanes = (lanes: readonly Lane[]): Lane[] =>
  lanes
    .map((lane, index) => ({ lane, index }))
    .sort(
      (a, b) =>
        (a.lane.order ?? Number.MAX_SAFE_INTEGER) - (b.lane.order ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ lane }) => lane);

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Cards are ranked over the whole graph (longest path from a source, removed connections left
 * out so a retired pathway cannot push a living card down), then stacked in their lane by rank.
 * Ties go to the card whose partners sit higher, then to document order. A lane never holds an
 * empty row: the POC's compact grid, where cross-lane arrows run sideways. Lanes with no card
 * are not drawn.
 */
export const seatGraph = (graph: Graph): Grid => {
  const lanes = orderLanes(graph.lanes).filter((lane) =>
    graph.nodes.some((node) => node.lane === lane.id),
  );
  const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
  const nodes = graph.nodes.filter((node) => laneIndex.has(node.lane));
  const docIndex = new Map(nodes.map((node, index) => [node.id, index]));

  const ranks = rankNodes(
    nodes,
    graph.edges.filter((edge) => edge.delta !== "removed"),
  );
  const rank = (node: GraphNode) => ranks.get(node.id) ?? 0;

  const partners = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.from === edge.to || !partners.has(edge.from) || !partners.has(edge.to)) continue;
    partners.get(edge.from)?.push(edge.to);
    partners.get(edge.to)?.push(edge.from);
  }
  const fall = new Map(
    nodes.map((node) => [
      node.id,
      mean((partners.get(node.id) ?? []).map((id) => ranks.get(id) ?? 0)) ?? rank(node),
    ]),
  );

  const seats: Seat[] = [];
  let rows = 0;
  lanes.forEach((lane, index) => {
    const members = nodes
      .filter((node) => node.lane === lane.id)
      .sort(
        (a, b) =>
          Number(a.delta === "removed") - Number(b.delta === "removed") ||
          rank(a) - rank(b) ||
          (fall.get(a.id) ?? 0) - (fall.get(b.id) ?? 0) ||
          (docIndex.get(a.id) ?? 0) - (docIndex.get(b.id) ?? 0),
      );
    members.forEach((node, row) => seats.push({ node, lane: index, row }));
    rows = Math.max(rows, members.length);
  });

  return { lanes, seats, bySeat: new Map(seats.map((seat) => [seat.node.id, seat])), rows };
};

/**
 * Geometry for a seated grid. `widen` gives extra room to corridor `c` (the gap left of lane
 * `c`; `c = lanes` is right of the last): every lane after it moves right by that much, nothing
 * re-seats. Only label room widens a corridor, so a map without labels is the POC's grid.
 */
export const placeGrid = (grid: Grid, widen: ReadonlyMap<number, number>): Placement => {
  const extra = (corridor: number) => widen.get(corridor) ?? 0;
  const xs: number[] = [];
  let x = MARGIN;
  for (let index = 0; index < grid.lanes.length; index += 1) {
    x += extra(index);
    xs.push(x);
    x += LANE_WIDTH + LANE_GAP;
  }
  const width = x - LANE_GAP + MARGIN + extra(grid.lanes.length);
  const height = CONTENT_TOP + grid.rows * ROW_PITCH + LANE_BOTTOM;

  const lanes = grid.lanes.map((lane, index) => ({
    lane,
    index,
    box: { x: xs[index] ?? MARGIN, y: 0, width: LANE_WIDTH, height },
  }));
  const nodes = grid.seats.map((seat) => ({
    ...seat,
    box: {
      x: (xs[seat.lane] ?? MARGIN) + (LANE_WIDTH - CARD_WIDTH) / 2,
      y: CONTENT_TOP + seat.row * ROW_PITCH + ROW_INSET,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    },
  }));

  return {
    width,
    height,
    rows: grid.rows,
    lanes,
    nodes,
    byId: new Map(nodes.map((placed) => [placed.node.id, placed])),
  };
};
