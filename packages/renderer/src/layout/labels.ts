/**
 * Edge labels as opaque pills on their own line, in free space (fixes POC defect 3: labels over
 * cards).
 *
 * The approach follows PR Lens's label placement (https://github.com/coldteadotai/pr-lens,
 * packages/renderer/src/layout/labels.ts at 918ffe82cb1dd71d20ce70b27917aeb80a7a4b49), MIT
 * License, Copyright (c) 2026 Coldtea AI. See NOTICE: a pill rides its route, starting from the
 * middle of the stretch it was planned for and sliding along it until it keeps clear of every
 * card, badge, lane header and earlier pill. Simplified for the POC grid: the corridor a label
 * needs is widened before this runs, so the search is a fixed, ordered list of spots rather
 * than PR Lens's cost model and repair pass.
 */
import {
  EDGE_LABEL_SIZE,
  PILL_CARD_CLEARANCE,
  PILL_CLEARANCE,
  PILL_HEIGHT,
  PILL_MAX_TEXT,
  PILL_PADDING_X,
} from "../design.js";
import { contains, inflate, overlapArea, type Box, type Point } from "../geometry.js";
import { measure, truncate } from "../text.js";
import type { Route } from "./routes.js";

export type Pill = { text: string; box: Box };

/** The label as drawn: cut to the widest pill the grid makes room for. */
export const pillText = (label: string): string =>
  truncate(label, "sans", EDGE_LABEL_SIZE, PILL_MAX_TEXT);

export const pillWidth = (text: string): number =>
  measure(text, "sans", EDGE_LABEL_SIZE) + PILL_PADDING_X * 2;

/** Half the side of the square kept clear around another route's joints. */
const JOINT_REACH = 4;

/** Middle first, then outwards in both directions. */
const FRACTIONS = [
  0.5,
  ...Array.from({ length: 9 }, (_, step) => step + 1).flatMap((step) => [
    0.5 - step * 0.05,
    0.5 + step * 0.05,
  ]),
];

/** Across the line, never so far that the line leaves the pill: it must still read as its label. */
const NUDGES = [0, -4, 4];

const along = (run: readonly Point[], fraction: number): Point => {
  const first = run[0] ?? { x: 0, y: 0 };
  const lengths = run.slice(1).map((p, index) => {
    const previous = run[index] as Point;
    return Math.hypot(p.x - previous.x, p.y - previous.y);
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return first;
  let remaining = total * fraction;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index] ?? 0;
    const from = run[index] as Point;
    const to = run[index + 1] as Point;
    if (remaining <= length && length > 0) {
      const t = remaining / length;
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
    remaining -= length;
  }
  return run[run.length - 1] ?? first;
};

/**
 * One pill per labelled route, in route order. `obstacles` are cards, badges and lane headers;
 * `frame` is the canvas. A pill with no clear spot takes the one that overlaps least, so it is
 * still drawn (and still readable: it is opaque), never dropped.
 */
export const placePills = (
  routes: readonly Route[],
  obstacles: readonly Box[],
  frame: Box,
): Map<number, Pill> => {
  const blocked = obstacles.map((box) => inflate(box, PILL_CARD_CLEARANCE));
  // Where other routes start, turn or end: a pill there reads as their label.
  const joints = (own: Route): Box[] =>
    routes
      .filter((route) => route !== own)
      .flatMap((route) => route.joints)
      .map(({ x, y }) => ({
        x: x - JOINT_REACH,
        y: y - JOINT_REACH,
        width: JOINT_REACH * 2,
        height: JOINT_REACH * 2,
      }));
  const placed: Box[] = [];
  const pills = new Map<number, Pill>();

  for (const [index, route] of routes.entries()) {
    const label = route.plan.edge.label;
    if (label === undefined) continue;
    const text = pillText(label);
    const width = pillWidth(text);

    const candidates: Box[] = [];
    for (const fraction of FRACTIONS) {
      const at = along(route.labelRun, fraction);
      for (const nudge of NUDGES) {
        const vertical =
          route.labelRun.length === 2 &&
          route.labelRun[0]?.x === route.labelRun[1]?.x &&
          route.labelAlign === "centre";
        const centre = vertical ? { x: at.x + nudge, y: at.y } : { x: at.x, y: at.y + nudge };
        candidates.push({
          x: route.labelAlign === "start" ? centre.x : centre.x - width / 2,
          y: centre.y - PILL_HEIGHT / 2,
          width,
          height: PILL_HEIGHT,
        });
      }
      if (route.labelRun.length < 2) break;
    }

    const foreign = joints(route);
    const crowding = (box: Box): number =>
      blocked.reduce((sum, other) => sum + overlapArea(box, other), 0) +
      foreign.reduce((sum, other) => sum + overlapArea(box, other), 0) +
      placed.reduce((sum, other) => sum + overlapArea(box, inflate(other, PILL_CLEARANCE)), 0) +
      (contains(frame, box) ? 0 : 1);

    let best = candidates[0] as Box;
    let bestCrowding = Number.POSITIVE_INFINITY;
    for (const box of candidates) {
      const cost = crowding(box);
      if (cost < bestCrowding) {
        best = box;
        bestCrowding = cost;
      }
      if (cost === 0) break;
    }
    placed.push(best);
    pills.set(index, { text, box: best });
  }
  return pills;
};
