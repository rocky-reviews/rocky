/**
 * How every edge travels between its cards.
 *
 * The POC's shapes (a straight drop inside a lane, a horizontal-tangent curve to the next lane)
 * plus routes through the grid's gaps for the cases the POC never had: an arrow that skips a
 * lane runs through the corridors beside the lanes and the band between two rows, an arrow
 * that skips rows in its own lane runs down the corridor on its right, so no line crosses a
 * card. Routing in the gaps of the grid, ports spread along a card face and parallel tracks in
 * one gap follow PR Lens's edge router (https://github.com/coldteadotai/pr-lens,
 * packages/renderer/src/layout/edges.ts at 918ffe82cb1dd71d20ce70b27917aeb80a7a4b49), MIT
 * License, Copyright (c) 2026 Coldtea AI. See NOTICE.
 */
import type { GraphEdge } from "@rocky-reviews/schema";
import {
  BADGE_INSET,
  BADGE_SIZE,
  BEND_RADIUS,
  CARD_HEIGHT,
  CARD_WIDTH,
  CONTENT_TOP,
  LANE_WIDTH,
  LOOP_REACH,
  PILL_CARD_CLEARANCE,
  ROW_INSET,
  ROW_PITCH,
  TRACK_PITCH,
} from "../design.js";
import { coord, type Point } from "../geometry.js";
import type { Grid, Placement, Seat } from "./place.js";

/**
 * - `drop`: same lane, next row up or down: a straight line between the facing edges.
 * - `curve`: the next lane over: the POC's curve, side to side.
 * - `lane-skip`: two or more lanes over: corridor, band, corridor.
 * - `row-skip`: same lane, rows apart: out to the right-hand corridor and back in.
 * - `loop`: an edge from a card to itself.
 */
export type RouteKind = "drop" | "curve" | "lane-skip" | "row-skip" | "loop";

export type Plan = {
  edge: GraphEdge;
  from: Seat;
  to: Seat;
  kind: RouteKind;
  /** The corridor the label sits in, when it sits in one; it is widened to fit. */
  labelCorridor: number | undefined;
  /** The corridors whose vertical runs this route uses, in travel order. */
  corridors: number[];
  /** The band between rows the route crosses in, for `lane-skip`. */
  band: number | undefined;
};

export type Route = {
  plan: Plan;
  /** SVG path data, every number rounded. */
  d: string;
  /** The stretch of the route a label may sit on, as a polyline. */
  labelRun: Point[];
  /** `start`: the label's left end sits on the run (a loop's label hangs off its card). */
  labelAlign: "centre" | "start";
  /** Where the route starts, turns and ends: another route's label keeps off these. */
  joints: Point[];
};

type Side = "top" | "right" | "bottom" | "left";

/** Bands sit between rows: band `b` is under row `b - 1`, so band 0 (the header) is never used. */
const bandCentre = (band: number): number => CONTENT_TOP + band * ROW_PITCH - 8;

const chooseBand = (grid: Grid, from: Seat, to: Seat): number => {
  const centre = (seat: Seat) => CONTENT_TOP + seat.row * ROW_PITCH + ROW_INSET + CARD_HEIGHT / 2;
  let best = 1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let band = 1; band <= grid.rows; band += 1) {
    const y = bandCentre(band);
    const cost = Math.abs(y - centre(from)) + Math.abs(y - centre(to));
    if (cost < bestCost) {
      best = band;
      bestCost = cost;
    }
  }
  return best;
};

/** Which route each edge takes. Reads lanes and rows only, so it runs before any geometry. */
export const planRoutes = (grid: Grid, edges: readonly GraphEdge[]): Plan[] =>
  edges.flatMap((edge): Plan[] => {
    const from = grid.bySeat.get(edge.from);
    const to = grid.bySeat.get(edge.to);
    if (from === undefined || to === undefined) return [];

    const base = { edge, from, to, labelCorridor: undefined, corridors: [], band: undefined };
    if (from.node.id === to.node.id)
      return [{ ...base, kind: "loop", labelCorridor: from.lane + 1 }];
    if (from.lane === to.lane) {
      if (Math.abs(from.row - to.row) === 1) return [{ ...base, kind: "drop" }];
      return [
        { ...base, kind: "row-skip", labelCorridor: from.lane + 1, corridors: [from.lane + 1] },
      ];
    }
    const forward = to.lane > from.lane;
    if (Math.abs(to.lane - from.lane) === 1)
      return [{ ...base, kind: "curve", labelCorridor: forward ? to.lane : from.lane }];
    return [
      {
        ...base,
        kind: "lane-skip",
        corridors: forward ? [from.lane + 1, to.lane] : [from.lane, to.lane + 1],
        band: chooseBand(grid, from, to),
      },
    ];
  });

/** Free width of corridor `c` between the cards (or the canvas edge) on either side of it. */
const corridorSpan = (placement: Placement, corridor: number): { left: number; right: number } => {
  const inset = (LANE_WIDTH - CARD_WIDTH) / 2;
  const before = placement.lanes[corridor - 1];
  const after = placement.lanes[corridor];
  return {
    left: before === undefined ? 0 : before.box.x + inset + CARD_WIDTH,
    right: after === undefined ? placement.width : after.box.x + inset,
  };
};

/** What the badge on a card's corner takes out of the corridor to its right. */
const BADGE_OVERHANG = BADGE_SIZE / 2 - BADGE_INSET;

/** How much wider corridor `c` must be for a pill of `width` to sit in it clear of cards. */
export const corridorShortfall = (
  corridor: number,
  lanes: number,
  width: number,
  kind?: RouteKind,
): number => {
  const inset = (LANE_WIDTH - CARD_WIDTH) / 2;
  const free = corridor === 0 || corridor === lanes ? inset + 8 : inset * 2 + 12;
  const reach = kind === "loop" ? LOOP_REACH : 0;
  return Math.max(0, width + reach + PILL_CARD_CLEARANCE * 2 + BADGE_OVERHANG - free);
};

const offsets = (count: number, room: number, most = TRACK_PITCH): number[] => {
  if (count <= 1) return [0];
  const pitch = Math.min(most, room / (count - 1));
  return Array.from({ length: count }, (_, index) => (index - (count - 1) / 2) * pitch);
};

const point = ({ x, y }: Point): string => `${coord(x)},${coord(y)}`;

/** A polyline with its corners rounded. Consecutive duplicate points are dropped. */
const roundedPath = (raw: readonly Point[]): string => {
  const points = raw.filter(
    (p, index) => index === 0 || p.x !== raw[index - 1]?.x || p.y !== raw[index - 1]?.y,
  );
  const first = points[0];
  if (first === undefined) return "";
  let d = `M${point(first)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1] as Point;
    const corner = points[index] as Point;
    const next = points[index + 1] as Point;
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(BEND_RADIUS, inLength / 2, outLength / 2);
    const entry = {
      x: corner.x - ((corner.x - previous.x) / inLength) * radius,
      y: corner.y - ((corner.y - previous.y) / inLength) * radius,
    };
    const exit = {
      x: corner.x + ((next.x - corner.x) / outLength) * radius,
      y: corner.y + ((next.y - corner.y) / outLength) * radius,
    };
    d += ` L${point(entry)} Q${point(corner)} ${point(exit)}`;
  }
  const last = points[points.length - 1] as Point;
  if (points.length > 1) d += ` L${point(last)}`;
  return d;
};

const cubicAt = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y,
  };
};

const CURVE_SAMPLES = 16;

/** Ends sharing a card face sit this far apart at most. */
const PORT_PITCH = 9;
/** How far below the card's top a badge reaches, past its centre line's room. */
const BADGE_CLEAR = BADGE_SIZE / 2 + BADGE_INSET + 2;

type Attachment = { plan: number; end: "from" | "to"; key: number };

/**
 * Lays every planned route onto the placed cards. Ends that share a card face are spread along
 * it in the order of where they are heading, so arrows into one card do not stack; vertical
 * runs sharing a corridor and horizontal runs sharing a band get parallel tracks, in edge order.
 */
export const routeEdges = (
  plans: readonly Plan[],
  placement: Placement,
  /** Cards with a finding badge: their right face keeps its ports below the badge. */
  badged: ReadonlySet<string> = new Set(),
): Route[] => {
  const box = (seat: Seat) =>
    placement.byId.get(seat.node.id)?.box ?? { x: 0, y: 0, width: 0, height: 0 };
  const centre = (seat: Seat): Point => {
    const b = box(seat);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  // Tracks per corridor and per band, in plan order.
  const corridorUsers = new Map<number, number[]>();
  const bandUsers = new Map<number, number[]>();
  plans.forEach((plan, index) => {
    for (const corridor of plan.corridors)
      corridorUsers.set(corridor, [...(corridorUsers.get(corridor) ?? []), index]);
    if (plan.band !== undefined)
      bandUsers.set(plan.band, [...(bandUsers.get(plan.band) ?? []), index]);
  });
  const corridorX = (corridor: number, plan: number): number => {
    const { left, right } = corridorSpan(placement, corridor);
    const users = corridorUsers.get(corridor) ?? [plan];
    const shift = offsets(users.length, Math.max(0, right - left - 16))[users.indexOf(plan)] ?? 0;
    return (left + right) / 2 + shift;
  };
  const bandY = (band: number, plan: number): number => {
    const users = bandUsers.get(band) ?? [plan];
    return bandCentre(band) + (offsets(users.length, 16)[users.indexOf(plan)] ?? 0);
  };

  const sides = plans.map((plan): { from: Side; to: Side } => {
    switch (plan.kind) {
      case "drop":
        return plan.to.row > plan.from.row
          ? { from: "bottom", to: "top" }
          : { from: "top", to: "bottom" };
      case "row-skip":
      case "loop":
        return { from: "right", to: "right" };
      case "curve":
      case "lane-skip":
        return plan.to.lane > plan.from.lane
          ? { from: "right", to: "left" }
          : { from: "left", to: "right" };
    }
  });

  // Where each end is heading, along the face it leaves by: decides its place on that face.
  const heading = (index: number, end: "from" | "to"): number => {
    const plan = plans[index] as Plan;
    const other = end === "from" ? plan.to : plan.from;
    const side = (sides[index] as { from: Side; to: Side })[end];
    if (side === "top" || side === "bottom") return centre(other).x;
    if (plan.band !== undefined) return bandCentre(plan.band);
    return centre(other).y;
  };

  const faces = new Map<string, Attachment[]>();
  plans.forEach((plan, index) => {
    if (plan.kind === "loop") return;
    for (const end of ["from", "to"] as const) {
      const seat = plan[end];
      const key = `${seat.node.id}\u0000${(sides[index] as { from: Side; to: Side })[end]}`;
      faces.set(key, [...(faces.get(key) ?? []), { plan: index, end, key: heading(index, end) }]);
    }
  });
  const ports = new Map<string, Point>();
  for (const [key, attachments] of faces) {
    const [nodeId, side] = key.split("\u0000") as [string, Side];
    const placed = placement.byId.get(nodeId);
    if (placed === undefined) continue;
    const b = placed.box;
    const sorted = [...attachments].sort(
      (a, c) =>
        a.key - c.key || a.plan - c.plan || (a.end === c.end ? 0 : a.end === "from" ? -1 : 1),
    );
    const vertical = side === "left" || side === "right";
    // The badge rides the top-right corner: ports on that face start below it.
    const underBadge = side === "right" && badged.has(nodeId) ? BADGE_CLEAR : 0;
    const spread = vertical
      ? offsets(sorted.length, CARD_HEIGHT - 16 - underBadge, PORT_PITCH)
      : offsets(sorted.length, CARD_WIDTH - 40, PORT_PITCH * 1.5);
    sorted.forEach((attachment, index) => {
      const shift = (spread[index] ?? 0) + underBadge / 2;
      const at: Point =
        side === "left"
          ? { x: b.x, y: b.y + b.height / 2 + shift }
          : side === "right"
            ? { x: b.x + b.width, y: b.y + b.height / 2 + shift }
            : side === "top"
              ? { x: b.x + b.width / 2 + shift, y: b.y }
              : { x: b.x + b.width / 2 + shift, y: b.y + b.height };
      ports.set(`${attachment.plan}:${attachment.end}`, at);
    });
  }

  return plans.map((plan, index): Route => {
    const start = ports.get(`${index}:from`) ?? centre(plan.from);
    const end = ports.get(`${index}:to`) ?? centre(plan.to);

    switch (plan.kind) {
      case "drop":
        return {
          plan,
          d: `M${point(start)} L${point(end)}`,
          labelRun: [start, end],
          labelAlign: "centre",
          joints: [start, end],
        };
      case "curve": {
        const mid = (start.x + end.x) / 2;
        const first = { x: mid, y: start.y };
        const second = { x: mid, y: end.y };
        const samples = Array.from({ length: CURVE_SAMPLES + 1 }, (_, step) =>
          cubicAt(start, first, second, end, step / CURVE_SAMPLES),
        );
        return {
          plan,
          d: `M${point(start)} C${point(first)} ${point(second)} ${point(end)}`,
          labelRun: samples,
          labelAlign: "centre",
          joints: [start, end],
        };
      }
      case "row-skip": {
        const x = corridorX(plan.corridors[0] ?? plan.from.lane + 1, index);
        const run = [
          { x, y: start.y },
          { x, y: end.y },
        ];
        return {
          plan,
          d: roundedPath([start, ...run, end]),
          labelRun: run,
          labelAlign: "centre",
          joints: [start, ...run, end],
        };
      }
      case "lane-skip": {
        const [first = 0, second = 0] = plan.corridors;
        const y = bandY(plan.band ?? 1, index);
        const out = corridorX(first, index);
        const back = corridorX(second, index);
        const run = [
          { x: out, y },
          { x: back, y },
        ];
        const joints = [start, { x: out, y: start.y }, ...run, { x: back, y: end.y }, end];
        return { plan, d: roundedPath(joints), labelRun: run, labelAlign: "centre", joints };
      }
      case "loop": {
        const b = box(plan.from);
        const x = b.x + b.width;
        const y = b.y + b.height / 2;
        const d =
          `M${point({ x, y: y - 8 })} C${point({ x: x + LOOP_REACH, y: y - 20 })} ` +
          `${point({ x: x + LOOP_REACH, y: y + 20 })} ${point({ x, y: y + 8 })}`;
        return {
          plan,
          d,
          labelRun: [{ x: x + LOOP_REACH + PILL_CARD_CLEARANCE, y }],
          labelAlign: "start",
          joints: [],
        };
      }
    }
  });
};
